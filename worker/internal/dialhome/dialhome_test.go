package dialhome

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/geminixiang/mikan/worker/internal/api"
	"github.com/geminixiang/mikan/worker/internal/lease"
	workerruntime "github.com/geminixiang/mikan/worker/internal/runtime"
)

const fakeWorkerScript = `#!/bin/sh
echo "{\"ready\":true,\"sessionId\":\"sess-$$\",\"socketPath\":\"$MIKAN_TEST_SOCKET\",\"workerPid\":$$,\"runnerPid\":0}"
exec sleep 60
`

// fakeGateway hands the client pre-connected pipe ends and keeps the server
// ends for the test to drive.
type fakeGateway struct {
	conns chan net.Conn
}

func (g *fakeGateway) dial() (net.Conn, error) {
	client, server := net.Pipe()
	g.conns <- server
	return client, nil
}

func newTestServer(t *testing.T, socketPath string) *api.Server {
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
	server := &api.Server{Leases: leases, Runtimes: supervisor, InventoryDir: filepath.Join(dir, "inventory")}
	server.Handler() // initialize replay map
	return server
}

func startClient(t *testing.T, server *api.Server) (*fakeGateway, chan struct{}) {
	t.Helper()
	gateway := &fakeGateway{conns: make(chan net.Conn, 8)}
	client := &Client{
		Dial:         gateway.dial,
		Server:       server,
		Name:         "test-worker",
		MaxRuntimes:  4,
		PingInterval: time.Hour, // keep pings out of the frame stream
		ReconnectMin: 10 * time.Millisecond,
		ReconnectMax: 20 * time.Millisecond,
	}
	stop := make(chan struct{})
	go client.Run(stop)
	t.Cleanup(func() { close(stop) })
	return gateway, stop
}

func awaitConn(t *testing.T, gateway *fakeGateway) net.Conn {
	t.Helper()
	select {
	case conn := <-gateway.conns:
		return conn
	case <-time.After(5 * time.Second):
		t.Fatal("no connection from client")
		return nil
	}
}

func rpc(t *testing.T, conn net.Conn, id int64, method, path string, body any, headers map[string]string) Frame {
	t.Helper()
	var raw json.RawMessage
	if body != nil {
		encoded, _ := json.Marshal(body)
		raw = encoded
	}
	if err := WriteFrame(conn, Frame{Type: "request", ID: id, Method: method, Path: path, Body: raw, Headers: headers}); err != nil {
		t.Fatal(err)
	}
	for {
		frame, err := ReadFrame(conn)
		if err != nil {
			t.Fatal(err)
		}
		if frame.Type == "response" && frame.ID == id {
			return frame
		}
	}
}

func TestRegisterAndRPC(t *testing.T) {
	server := newTestServer(t, "/nonexistent.sock")
	gateway, _ := startClient(t, server)
	control := awaitConn(t, gateway)

	register, err := ReadFrame(control)
	if err != nil {
		t.Fatal(err)
	}
	if register.Type != "register" || register.Name != "test-worker" || register.MaxRuntimes != 4 {
		t.Fatalf("unexpected register frame: %+v", register)
	}

	health := rpc(t, control, 1, "GET", "/v1/health", nil, nil)
	if health.Status != http.StatusOK || !bytes.Contains(health.Body, []byte("activeRuntimes")) {
		t.Fatalf("health RPC failed: %d %s", health.Status, health.Body)
	}

	// full protocol flow over RPC: lease → ensure → list
	leaseResponse := rpc(t, control, 2, "POST", "/v1/leases", map[string]any{"instanceId": "c1"}, nil)
	var granted lease.Lease
	_ = json.Unmarshal(leaseResponse.Body, &granted)
	if granted.Epoch != 1 {
		t.Fatalf("lease RPC failed: %s", leaseResponse.Body)
	}
	leaseHeaders := map[string]string{
		"X-Mikan-Lease": granted.ID,
		"X-Mikan-Epoch": fmt.Sprintf("%d", granted.Epoch),
	}
	ensure := rpc(t, control, 3, "POST", "/v1/runtimes", map[string]any{
		"instanceId":    "c1",
		"imageSelector": "mikan-sandbox:latest",
		"fingerprint":   "fp",
	}, leaseHeaders)
	if ensure.Status != http.StatusOK {
		t.Fatalf("ensure RPC failed: %d %s", ensure.Status, ensure.Body)
	}
}

func TestDialBackTunnelSplicesAndEnforcesLease(t *testing.T) {
	shortDir, err := os.MkdirTemp("/tmp", "mikan-dial")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(shortDir) })
	socketPath := filepath.Join(shortDir, "s.sock")
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
				buffer := make([]byte, 256)
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

	server := newTestServer(t, socketPath)
	gateway, _ := startClient(t, server)
	control := awaitConn(t, gateway)
	if _, err := ReadFrame(control); err != nil { // register
		t.Fatal(err)
	}

	leaseResponse := rpc(t, control, 1, "POST", "/v1/leases", map[string]any{"instanceId": "c1"}, nil)
	var granted lease.Lease
	_ = json.Unmarshal(leaseResponse.Body, &granted)
	leaseHeaders := map[string]string{
		"X-Mikan-Lease": granted.ID,
		"X-Mikan-Epoch": fmt.Sprintf("%d", granted.Epoch),
	}
	ensure := rpc(t, control, 2, "POST", "/v1/runtimes", map[string]any{
		"instanceId":    "c1",
		"imageSelector": "mikan-sandbox:latest",
		"fingerprint":   "fp",
	}, leaseHeaders)
	var runtime workerruntime.Runtime
	_ = json.Unmarshal(ensure.Body, &runtime)
	if runtime.SessionID == "" {
		t.Fatalf("no runtime: %s", ensure.Body)
	}

	// tunnel without lease headers is refused: no dial-back arrives
	if err := WriteFrame(control, Frame{Type: "open-tunnel", Nonce: "n0", SessionID: runtime.SessionID}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gateway.conns:
		t.Fatal("unauthorized tunnel was opened")
	case <-time.After(200 * time.Millisecond):
	}

	// authorized tunnel splices to the session socket
	if err := WriteFrame(control, Frame{Type: "open-tunnel", Nonce: "n1", SessionID: runtime.SessionID, Headers: leaseHeaders}); err != nil {
		t.Fatal(err)
	}
	tunnel := awaitConn(t, gateway)
	preamble, err := ReadFrame(tunnel)
	if err != nil {
		t.Fatal(err)
	}
	if preamble.Type != "tunnel" || preamble.Nonce != "n1" || preamble.Name != "test-worker" {
		t.Fatalf("unexpected preamble: %+v", preamble)
	}
	if _, err := tunnel.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	echoed := make([]byte, 5)
	if _, err := tunnel.Read(echoed); err != nil {
		t.Fatal(err)
	}
	if string(echoed) != "HELLO" {
		t.Fatalf("tunnel echoed %q", echoed)
	}
}

func TestReconnectsAndReregisters(t *testing.T) {
	server := newTestServer(t, "/nonexistent.sock")
	gateway, _ := startClient(t, server)

	first := awaitConn(t, gateway)
	if _, err := ReadFrame(first); err != nil {
		t.Fatal(err)
	}
	first.Close() // gateway drops the control channel

	second := awaitConn(t, gateway)
	register, err := ReadFrame(second)
	if err != nil {
		t.Fatal(err)
	}
	if register.Type != "register" {
		t.Fatalf("expected re-register, got %+v", register)
	}
}
