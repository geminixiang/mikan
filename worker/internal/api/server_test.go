package api

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/geminixiang/mikan/worker/internal/lease"
	workerruntime "github.com/geminixiang/mikan/worker/internal/runtime"
)

// fakeWorkerScript emits a gondolin worker handshake and idles like a real
// detached worker. Session ids derive from the shell pid so each spawn is
// unique; the socket path comes from the environment.
const fakeWorkerScript = `#!/bin/sh
echo "{\"ready\":true,\"sessionId\":\"sess-$$\",\"socketPath\":\"$MIKAN_TEST_SOCKET\",\"workerPid\":$$,\"runnerPid\":0}"
exec sleep 60
`

type testWorld struct {
	server   *Server
	handler  http.Handler
	leaseID  string
	epoch    uint64
	instance string
}

func newTestWorld(t *testing.T, socketPath string) *testWorld {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-worker.sh")
	if err := os.WriteFile(script, []byte(fakeWorkerScript), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MIKAN_TEST_SOCKET", socketPath)
	leases, err := lease.NewManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	supervisor := workerruntime.NewSupervisor(workerruntime.Options{
		NodeBin:          "/bin/sh",
		WorkerEntry:      script,
		InventoryDir:     filepath.Join(dir, "inventory"),
		HandshakeTimeout: 5 * time.Second,
		StopWait:         2 * time.Second,
	})
	server := &Server{
		Leases:         leases,
		Runtimes:       supervisor,
		InventoryDir:   filepath.Join(dir, "inventory"),
		CredentialsDir: filepath.Join(dir, "credentials"),
	}
	return &testWorld{server: server, handler: server.Handler(), instance: "c1"}
}

func (w *testWorld) request(t *testing.T, method, path string, body any, withLease bool) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	request := httptest.NewRequest(method, path, reader)
	if withLease {
		request.Header.Set("X-Mikan-Lease", w.leaseID)
		request.Header.Set("X-Mikan-Epoch", fmt.Sprintf("%d", w.epoch))
	}
	recorder := httptest.NewRecorder()
	w.handler.ServeHTTP(recorder, request)
	return recorder
}

func (w *testWorld) acquireLease(t *testing.T) {
	t.Helper()
	response := w.request(t, "POST", "/v1/leases", map[string]any{"instanceId": w.instance}, false)
	if response.Code != http.StatusOK {
		t.Fatalf("acquire lease: %d %s", response.Code, response.Body)
	}
	var granted lease.Lease
	_ = json.Unmarshal(response.Body.Bytes(), &granted)
	w.leaseID = granted.ID
	w.epoch = granted.Epoch
}

func (w *testWorld) ensureRuntime(t *testing.T, fingerprint string, headers map[string]string) (*httptest.ResponseRecorder, workerruntime.Runtime) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{
		"instanceId":    w.instance,
		"imageSelector": "mikan-sandbox:latest",
		"fingerprint":   fingerprint,
	})
	request := httptest.NewRequest("POST", "/v1/runtimes", bytes.NewReader(raw))
	request.Header.Set("X-Mikan-Lease", w.leaseID)
	request.Header.Set("X-Mikan-Epoch", fmt.Sprintf("%d", w.epoch))
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	w.handler.ServeHTTP(recorder, request)
	var runtime workerruntime.Runtime
	_ = json.Unmarshal(recorder.Body.Bytes(), &runtime)
	return recorder, runtime
}

func TestEnsureRefusedWhenWorkspaceUnusable(t *testing.T) {
	world := newTestWorld(t, "/nonexistent.sock")
	world.server.Workspace = NewWorkspaceProbe("/nonexistent/mikan-workspace", time.Second, time.Minute)
	world.acquireLease(t)

	response, _ := world.ensureRuntime(t, "fp-1", nil)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 for an unusable workspace, got %d %s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), "workspace_unusable") {
		t.Errorf("body should carry workspace_unusable: %s", response.Body)
	}

	// /v1/health reports the same diagnosis for placement decisions
	health := world.request(t, "GET", "/v1/health", nil, false)
	if !strings.Contains(health.Body.String(), "workspaceError") {
		t.Errorf("health should report workspaceError: %s", health.Body)
	}
}

func TestRuntimeLifecycleUnderLease(t *testing.T) {
	world := newTestWorld(t, "/nonexistent.sock")

	// runtime operations without a lease are refused
	response, _ := world.ensureRuntime(t, "fp-1", nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without lease, got %d", response.Code)
	}

	world.acquireLease(t)
	response, created := world.ensureRuntime(t, "fp-1", nil)
	if response.Code != http.StatusOK || created.SessionID == "" {
		t.Fatalf("ensure runtime: %d %s", response.Code, response.Body)
	}

	// same fingerprint adopts instead of spawning
	_, adopted := world.ensureRuntime(t, "fp-1", nil)
	if adopted.SessionID != created.SessionID || !adopted.Adopted {
		t.Fatalf("expected adoption of %s, got %+v", created.SessionID, adopted)
	}

	// drifted fingerprint replaces the runtime
	_, replaced := world.ensureRuntime(t, "fp-2", nil)
	if replaced.SessionID == created.SessionID {
		t.Fatal("expected a fresh runtime after fingerprint drift")
	}

	stop := world.request(t, "DELETE", "/v1/runtimes/"+replaced.SessionID, nil, true)
	if stop.Code != http.StatusOK {
		t.Fatalf("stop runtime: %d %s", stop.Code, stop.Body)
	}
	if get := world.request(t, "GET", "/v1/runtimes/"+replaced.SessionID, nil, false); get.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after stop, got %d", get.Code)
	}
}

func TestStaleEpochIsFenced(t *testing.T) {
	world := newTestWorld(t, "/nonexistent.sock")
	world.acquireLease(t)
	staleLease, staleEpoch := world.leaseID, world.epoch

	world.acquireLease(t) // supersedes: epoch += 1

	raw, _ := json.Marshal(map[string]any{
		"instanceId":    world.instance,
		"imageSelector": "mikan-sandbox:latest",
		"fingerprint":   "fp",
	})
	request := httptest.NewRequest("POST", "/v1/runtimes", bytes.NewReader(raw))
	request.Header.Set("X-Mikan-Lease", staleLease)
	request.Header.Set("X-Mikan-Epoch", fmt.Sprintf("%d", staleEpoch))
	recorder := httptest.NewRecorder()
	world.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("expected 409 for stale epoch, got %d %s", recorder.Code, recorder.Body)
	}
}

func TestIdempotencyKeyReplaysEnsure(t *testing.T) {
	world := newTestWorld(t, "/nonexistent.sock")
	world.acquireLease(t)

	_, first := world.ensureRuntime(t, "fp-1", map[string]string{"Idempotency-Key": "k1"})
	_, second := world.ensureRuntime(t, "fp-1", map[string]string{"Idempotency-Key": "k1"})
	if first.SessionID != second.SessionID {
		t.Fatalf("idempotent replay diverged: %s vs %s", first.SessionID, second.SessionID)
	}
	if count := world.server.Runtimes.Count(); count != 1 {
		t.Fatalf("expected a single runtime, got %d", count)
	}
}

func TestMountValidationEnforcesWorkspaceRoot(t *testing.T) {
	world := newTestWorld(t, "/nonexistent.sock")
	world.server.WorkspaceRoot = "/srv/workspace"
	world.acquireLease(t)

	raw, _ := json.Marshal(map[string]any{
		"instanceId":    world.instance,
		"imageSelector": "mikan-sandbox:latest",
		"fingerprint":   "fp",
		"mounts":        []map[string]string{{"source": "/etc", "target": "/workspace"}},
	})
	request := httptest.NewRequest("POST", "/v1/runtimes", bytes.NewReader(raw))
	request.Header.Set("X-Mikan-Lease", world.leaseID)
	request.Header.Set("X-Mikan-Epoch", fmt.Sprintf("%d", world.epoch))
	recorder := httptest.NewRecorder()
	world.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for escaping mount, got %d", recorder.Code)
	}
}

func TestSessionTunnelSplicesBytes(t *testing.T) {
	// echo backend playing the role of a runtime's session socket; unix
	// socket paths must stay short (104 bytes on macOS), so avoid t.TempDir()
	shortDir, err := os.MkdirTemp("/tmp", "mikan-sock")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(shortDir) })
	socketPath := filepath.Join(shortDir, "session.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				buffer := make([]byte, 1024)
				for {
					n, err := c.Read(buffer)
					if err != nil {
						c.Close()
						return
					}
					_, _ = c.Write(bytes.ToUpper(buffer[:n]))
				}
			}(conn)
		}
	}()

	world := newTestWorld(t, socketPath)
	world.acquireLease(t)
	_, created := world.ensureRuntime(t, "fp-1", nil)
	if created.SessionID == "" {
		t.Fatal("runtime was not created")
	}

	httpServer := httptest.NewServer(world.handler)
	defer httpServer.Close()

	conn, err := net.Dial("tcp", strings.TrimPrefix(httpServer.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn,
		"GET /v1/runtimes/%s/session HTTP/1.1\r\nHost: worker\r\nConnection: Upgrade\r\nUpgrade: gondolin-session\r\nX-Mikan-Lease: %s\r\nX-Mikan-Epoch: %d\r\n\r\n",
		created.SessionID, world.leaseID, world.epoch)

	reader := bufio.NewReader(conn)
	status, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(status, "101") {
		t.Fatalf("expected 101 upgrade, got %q (%v)", status, err)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}

	if _, err := conn.Write([]byte("hello tunnel")); err != nil {
		t.Fatal(err)
	}
	echoed := make([]byte, len("HELLO TUNNEL"))
	if _, err := reader.Read(echoed); err != nil {
		t.Fatal(err)
	}
	if string(echoed) != "HELLO TUNNEL" {
		t.Fatalf("tunnel echoed %q", echoed)
	}
}

func TestMaterializeCredentials(t *testing.T) {
	dir := t.TempDir()
	server := &Server{
		InventoryDir:   filepath.Join(dir, "inventory"),
		CredentialsDir: filepath.Join(dir, "credentials"),
	}

	// no credentials → no mounts, no dir
	mounts, err := server.materializeCredentials("c1", nil)
	if err != nil || mounts != nil {
		t.Fatalf("empty credentials: %v %v", mounts, err)
	}

	files := []credentialFile{
		{Target: "/root/.config/gws/credentials.json", ContentBase64: base64.StdEncoding.EncodeToString([]byte("{token}"))},
	}
	mounts, err = server.materializeCredentials("c1", files)
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 1 || mounts[0].Target != "/root/.config/gws/credentials.json" {
		t.Fatalf("unexpected mounts: %+v", mounts)
	}
	// the shipped content landed owner-only, outside any workspace
	content, err := os.ReadFile(mounts[0].Source)
	if err != nil || string(content) != "{token}" {
		t.Fatalf("credential content: %q %v", content, err)
	}
	info, _ := os.Stat(mounts[0].Source)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credential mode %o, want 600", info.Mode().Perm())
	}
	if strings.Contains(mounts[0].Source, "workspace") {
		t.Fatalf("credential leaked into a workspace path: %s", mounts[0].Source)
	}

	// re-materializing replaces (rotation): different content, same slot
	files[0].ContentBase64 = base64.StdEncoding.EncodeToString([]byte("{rotated}"))
	mounts, _ = server.materializeCredentials("c1", files)
	content, _ = os.ReadFile(mounts[0].Source)
	if string(content) != "{rotated}" {
		t.Fatalf("rotation not applied: %q", content)
	}

	// a relative target is rejected
	if _, err := server.materializeCredentials("c1", []credentialFile{{Target: "rel/path", ContentBase64: "Zm9v"}}); err == nil {
		t.Fatal("expected rejection of relative credential target")
	}
}
