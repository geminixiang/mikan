// Package api exposes the mikan-worker protocol: health, fenced leases, and
// runtime lifecycle plus a raw byte tunnel to each runtime's session socket.
package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/geminixiang/mikan/worker/internal/lease"
	workerruntime "github.com/geminixiang/mikan/worker/internal/runtime"
)

// ProtocolVersion is bumped on incompatible wire changes.
const ProtocolVersion = 1

const (
	leaseHeader = "X-Mikan-Lease"
	epochHeader = "X-Mikan-Epoch"

	defaultLeaseTTL = 5 * time.Minute
	maxLeaseTTL     = time.Hour
	maxBodyBytes    = 1 << 20
	idempotencyTTL  = 10 * time.Minute
)

// Server wires the protocol handlers to the lease manager and supervisor.
type Server struct {
	Leases        *lease.Manager
	Runtimes      *workerruntime.Supervisor
	WorkspaceRoot string
	InventoryDir  string
	// Workspace, when set, reports shared-workspace usability in /v1/health.
	Workspace *WorkspaceProbe
	Log       *slog.Logger

	mu       sync.Mutex
	replayed map[string]replayEntry
}

type replayEntry struct {
	status   int
	body     []byte
	storedAt time.Time
}

// Handler builds the protocol mux.
func (s *Server) Handler() http.Handler {
	if s.Log == nil {
		s.Log = slog.Default()
	}
	s.replayed = make(map[string]replayEntry)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", s.handleHealth)
	mux.HandleFunc("POST /v1/leases", s.handleAcquireLease)
	mux.HandleFunc("POST /v1/leases/{id}/renew", s.handleRenewLease)
	mux.HandleFunc("DELETE /v1/leases/{id}", s.handleReleaseLease)
	mux.HandleFunc("POST /v1/runtimes", s.handleEnsureRuntime)
	mux.HandleFunc("GET /v1/runtimes", s.handleListRuntimes)
	mux.HandleFunc("GET /v1/runtimes/{sessionId}", s.handleGetRuntime)
	mux.HandleFunc("DELETE /v1/runtimes/{sessionId}", s.handleStopRuntime)
	mux.HandleFunc("GET /v1/runtimes/{sessionId}/session", s.handleSessionTunnel)
	return mux
}

// Janitor fences runtimes of expired leases and keeps the worker-side
// heartbeat fresh so Node workers know a supervisor is still around.
func (s *Server) Janitor(interval time.Duration, stop <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			for _, expired := range s.Leases.Expired() {
				if len(s.Runtimes.List(expired.InstanceID)) > 0 {
					s.Log.Info("fencing runtimes of expired lease", "instanceId", expired.InstanceID)
					s.Runtimes.StopInstance(expired.InstanceID)
				}
			}
			s.touchHeartbeat()
			s.pruneReplayed()
		}
	}
}

func (s *Server) touchHeartbeat() {
	if s.InventoryDir == "" {
		return
	}
	_ = os.MkdirAll(s.InventoryDir, 0o700)
	path := filepath.Join(s.InventoryDir, "heartbeat")
	if err := os.WriteFile(path, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o600); err != nil {
		s.Log.Warn("failed to touch heartbeat", "error", err)
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"protocolVersion": ProtocolVersion,
		"os":              runtime.GOOS,
		"arch":            runtime.GOARCH,
		"accelerator":     Accelerator(),
		"cpus":            runtime.NumCPU(),
		"memoryBytes":     TotalMemoryBytes(),
		"activeRuntimes":  s.Runtimes.Count(),
	}
	if workspaceError := s.Workspace.Cached(); workspaceError != "" {
		body["workspaceError"] = workspaceError
	}
	writeJSON(w, http.StatusOK, body)
}

type acquireLeaseRequest struct {
	InstanceID string `json:"instanceId"`
	TTLSeconds int    `json:"ttlSeconds"`
}

func (s *Server) handleAcquireLease(w http.ResponseWriter, r *http.Request) {
	var request acquireLeaseRequest
	if !readJSON(w, r, &request) {
		return
	}
	if request.InstanceID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "instanceId is required")
		return
	}
	granted, err := s.Leases.Acquire(request.InstanceID, ttlFrom(request.TTLSeconds))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lease_error", err.Error())
		return
	}
	s.Log.Info("lease acquired", "instanceId", granted.InstanceID, "epoch", granted.Epoch)
	writeJSON(w, http.StatusOK, granted)
}

type renewLeaseRequest struct {
	TTLSeconds int `json:"ttlSeconds"`
}

func (s *Server) handleRenewLease(w http.ResponseWriter, r *http.Request) {
	var request renewLeaseRequest
	if !readJSON(w, r, &request) {
		return
	}
	renewed, err := s.Leases.Renew(r.PathValue("id"), ttlFrom(request.TTLSeconds))
	if err != nil {
		writeLeaseError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, renewed)
}

func (s *Server) handleReleaseLease(w http.ResponseWriter, r *http.Request) {
	if err := s.Leases.Release(r.PathValue("id")); err != nil {
		writeLeaseError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"released": true})
}

type ensureRuntimeRequest struct {
	InstanceID       string                `json:"instanceId"`
	ImageSelector    string                `json:"imageSelector"`
	Mounts           []workerruntime.Mount `json:"mounts"`
	CredentialFiles  []credentialFile      `json:"credentialFiles"`
	CPUs             string                `json:"cpus"`
	Memory           string                `json:"memory"`
	Fingerprint      string                `json:"fingerprint"`
	HeartbeatStaleMs int64                 `json:"heartbeatStaleMs"`
}

// credentialFile is a vault credential shipped by content (not a shared-fs
// mount): the mikan host decides what to inject, independent of the workspace.
type credentialFile struct {
	Target        string `json:"target"`
	ContentBase64 string `json:"contentBase64"`
}

func (s *Server) handleEnsureRuntime(w http.ResponseWriter, r *http.Request) {
	var request ensureRuntimeRequest
	if !readJSON(w, r, &request) {
		return
	}
	epoch, ok := s.authorizeLease(w, r, request.InstanceID)
	if !ok {
		return
	}
	if key := r.Header.Get("Idempotency-Key"); key != "" {
		if entry, found := s.replay(key); found {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(entry.status)
			_, _ = w.Write(entry.body)
			return
		}
	}
	if request.ImageSelector == "" || request.Fingerprint == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "imageSelector and fingerprint are required")
		return
	}
	// Refuse to spawn (or adopt) a runtime whose workspace sits on a dead
	// mount: its VM would hang on the first guest I/O with no way to cancel.
	if message := s.Workspace.Status(); message != "" {
		writeError(w, http.StatusServiceUnavailable, "workspace_unusable", message)
		return
	}
	if err := s.validateMounts(request.Mounts); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_mounts", err.Error())
		return
	}
	// Land shipped vault credentials as worker-local files and mount them by
	// path — the guest sees them exactly like a local file mount, without the
	// credential ever touching the shared workspace.
	credentialMounts, err := s.materializeCredentials(request.InstanceID, request.CredentialFiles)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_credentials", err.Error())
		return
	}
	vmCPUs := 0
	if request.CPUs != "" {
		fraction, err := strconv.ParseFloat(request.CPUs, 64)
		if err != nil || fraction <= 0 {
			writeError(w, http.StatusBadRequest, "invalid_request", fmt.Sprintf("invalid cpu limit %q", request.CPUs))
			return
		}
		vmCPUs = int(math.Ceil(fraction))
	}
	heartbeatStaleMs := request.HeartbeatStaleMs
	if heartbeatStaleMs == 0 {
		// If this daemon dies for good, its janitor stops touching the
		// heartbeat and orphaned VM hosts shut themselves down.
		heartbeatStaleMs = (45 * time.Minute).Milliseconds()
	}
	config := workerruntime.WorkerConfig{
		InstanceID:       request.InstanceID,
		ImageSelector:    request.ImageSelector,
		Mounts:           append(request.Mounts, credentialMounts...),
		CPUs:             vmCPUs,
		Memory:           request.Memory,
		Fingerprint:      request.Fingerprint,
		HeartbeatStaleMs: heartbeatStaleMs,
	}
	ensured, err := s.Runtimes.Ensure(config, request.CPUs, epoch)
	if err != nil {
		writeError(w, http.StatusBadGateway, "runtime_error", err.Error())
		return
	}
	body, _ := json.Marshal(ensured)
	if key := r.Header.Get("Idempotency-Key"); key != "" {
		s.remember(key, http.StatusOK, body)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (s *Server) handleListRuntimes(w http.ResponseWriter, r *http.Request) {
	list := s.Runtimes.List(r.URL.Query().Get("instanceId"))
	if list == nil {
		list = []workerruntime.Runtime{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"runtimes": list})
}

func (s *Server) handleGetRuntime(w http.ResponseWriter, r *http.Request) {
	entry, err := s.Runtimes.Get(r.PathValue("sessionId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "runtime not found")
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (s *Server) handleStopRuntime(w http.ResponseWriter, r *http.Request) {
	entry, err := s.Runtimes.Get(r.PathValue("sessionId"))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"stopped": false})
		return
	}
	if _, ok := s.authorizeLease(w, r, entry.InstanceID); !ok {
		return
	}
	if err := s.Runtimes.Stop(entry.SessionID); err != nil && !errors.Is(err, workerruntime.ErrNotFound) {
		writeError(w, http.StatusInternalServerError, "runtime_error", err.Error())
		return
	}
	// the shipped credentials died with the runtime
	_ = os.RemoveAll(filepath.Join(s.credentialsDir(), entry.InstanceID))
	writeJSON(w, http.StatusOK, map[string]any{"stopped": true})
}

func (s *Server) handleSessionTunnel(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "gondolin-session") {
		writeError(w, http.StatusBadRequest, "invalid_request", "expected Upgrade: gondolin-session")
		return
	}
	entry, err := s.Runtimes.Get(r.PathValue("sessionId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "runtime not found")
		return
	}
	if _, ok := s.authorizeLease(w, r, entry.InstanceID); !ok {
		return
	}
	backend, err := net.DialTimeout("unix", entry.SocketPath, 5*time.Second)
	if err != nil {
		writeError(w, http.StatusBadGateway, "runtime_gone", err.Error())
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		backend.Close()
		writeError(w, http.StatusInternalServerError, "tunnel_error", "connection cannot be hijacked")
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		backend.Close()
		writeError(w, http.StatusInternalServerError, "tunnel_error", err.Error())
		return
	}
	response := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: gondolin-session\r\nConnection: Upgrade\r\n\r\n"
	if _, err := buffered.WriteString(response); err != nil {
		client.Close()
		backend.Close()
		return
	}
	if err := buffered.Flush(); err != nil {
		client.Close()
		backend.Close()
		return
	}
	splice(client, backend)
}

// splice copies bytes both ways and tears the pair down when either side ends
// — closing the tunnel kills the in-flight guest command, exactly like
// disconnecting from the local session socket.
func splice(client net.Conn, backend net.Conn) {
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(backend, client)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, backend)
		done <- struct{}{}
	}()
	<-done
	client.Close()
	backend.Close()
	<-done
}

// authorizeLease validates the fencing headers against an instance id.
func (s *Server) authorizeLease(w http.ResponseWriter, r *http.Request, instanceID string) (uint64, bool) {
	leaseID := r.Header.Get(leaseHeader)
	epochRaw := r.Header.Get(epochHeader)
	epoch, err := strconv.ParseUint(epochRaw, 10, 64)
	if leaseID == "" || err != nil {
		writeError(w, http.StatusUnauthorized, "missing_lease", "lease headers are required")
		return 0, false
	}
	switch validation := s.Leases.Validate(instanceID, leaseID, epoch); {
	case validation == nil:
		return epoch, true
	case errors.Is(validation, lease.ErrStaleEpoch):
		writeError(w, http.StatusConflict, "stale_epoch", "a newer lease supersedes this epoch")
	case errors.Is(validation, lease.ErrExpired):
		writeError(w, http.StatusGone, "lease_expired", "lease expired; acquire a new one")
	default:
		writeError(w, http.StatusUnauthorized, "unknown_lease", "lease is not current for this instance")
	}
	return 0, false
}

// credentialsDir is where shipped vault credentials land, beside the runtime
// inventory but never inside the workspace.
func (s *Server) credentialsDir() string {
	return filepath.Join(filepath.Dir(s.InventoryDir), "credentials")
}

// materializeCredentials writes each shipped credential to a per-instance,
// owner-only file and returns it as a plain file mount for the guest.
func (s *Server) materializeCredentials(
	instanceID string,
	files []credentialFile,
) ([]workerruntime.Mount, error) {
	if len(files) == 0 {
		return nil, nil
	}
	dir := filepath.Join(s.credentialsDir(), instanceID)
	// fresh each ensure: a rotated credential replaces the old file
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create credential dir: %w", err)
	}
	mounts := make([]workerruntime.Mount, 0, len(files))
	for i, file := range files {
		if !filepath.IsAbs(file.Target) {
			return nil, fmt.Errorf("credential target must be absolute: %s", file.Target)
		}
		content, err := base64.StdEncoding.DecodeString(file.ContentBase64)
		if err != nil {
			return nil, fmt.Errorf("decode credential for %s: %w", file.Target, err)
		}
		local := filepath.Join(dir, fmt.Sprintf("cred-%d-%s", i, filepath.Base(file.Target)))
		if err := os.WriteFile(local, content, 0o600); err != nil {
			return nil, fmt.Errorf("write credential %s: %w", file.Target, err)
		}
		mounts = append(mounts, workerruntime.Mount{Source: local, Target: file.Target})
	}
	return mounts, nil
}

func (s *Server) validateMounts(mounts []workerruntime.Mount) error {
	for _, mount := range mounts {
		if !filepath.IsAbs(mount.Source) || !filepath.IsAbs(mount.Target) {
			return fmt.Errorf("mount paths must be absolute: %s -> %s", mount.Source, mount.Target)
		}
		if s.WorkspaceRoot != "" && !strings.HasPrefix(filepath.Clean(mount.Source)+"/", filepath.Clean(s.WorkspaceRoot)+"/") {
			return fmt.Errorf("mount source %s escapes the workspace root", mount.Source)
		}
	}
	return nil
}

func (s *Server) replay(key string) (replayEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.replayed[key]
	return entry, ok
}

func (s *Server) remember(key string, status int, body []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.replayed[key] = replayEntry{status: status, body: body, storedAt: time.Now()}
}

func (s *Server) pruneReplayed() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, entry := range s.replayed {
		if time.Since(entry.storedAt) > idempotencyTTL {
			delete(s.replayed, key)
		}
	}
}

func ttlFrom(seconds int) time.Duration {
	if seconds <= 0 {
		return defaultLeaseTTL
	}
	ttl := time.Duration(seconds) * time.Second
	if ttl > maxLeaseTTL {
		return maxLeaseTTL
	}
	return ttl
}

func Accelerator() string {
	switch runtime.GOOS {
	case "linux":
		if _, err := os.Stat("/dev/kvm"); err == nil {
			return "kvm"
		}
		return "none"
	case "darwin":
		return "hvf"
	default:
		return "none"
	}
}

func TotalMemoryBytes() int64 {
	if runtime.GOOS == "linux" {
		raw, err := os.ReadFile("/proc/meminfo")
		if err == nil {
			for _, line := range strings.Split(string(raw), "\n") {
				if value, found := strings.CutPrefix(line, "MemTotal:"); found {
					fields := strings.Fields(value)
					if len(fields) >= 1 {
						if kb, err := strconv.ParseInt(fields[0], 10, 64); err == nil {
							return kb * 1024
						}
					}
				}
			}
		}
	}
	return 0
}

func readJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	body := http.MaxBytesReader(w, r.Body, maxBodyBytes)
	if err := json.NewDecoder(body).Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

func writeLeaseError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, lease.ErrExpired):
		writeError(w, http.StatusGone, "lease_expired", err.Error())
	case errors.Is(err, lease.ErrUnknownLease):
		writeError(w, http.StatusNotFound, "unknown_lease", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "lease_error", err.Error())
	}
}
