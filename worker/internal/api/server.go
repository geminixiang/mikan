// Package api exposes the mikan-worker protocol: health, fenced leases, and
// runtime lifecycle plus a raw byte tunnel to each runtime's session socket.
package api

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
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
	"sync/atomic"
	"time"

	"github.com/geminixiang/mikan/worker/internal/lease"
	workerruntime "github.com/geminixiang/mikan/worker/internal/runtime"
)

// ProtocolVersion is bumped on incompatible wire changes.
const ProtocolVersion = 2

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
	// CredentialsDir is where shipped vault credentials land (statedir owns
	// the layout); beside the runtime inventory, never inside the workspace.
	CredentialsDir string
	// Workspace, when set, reports shared-workspace usability in /v1/health.
	Workspace *WorkspaceProbe
	Log       *slog.Logger
	// StateLock keeps the process-scoped state-directory advisory lock alive.
	StateLock *os.File

	mu       sync.Mutex
	replayed map[string]replayEntry

	tunnelMu sync.Mutex
	tunnels  map[*activeTunnel]struct{}

	dialhomeHeartbeat atomic.Bool
	controlConnected  atomic.Bool
	heartbeatSeq      atomic.Uint64
	heartbeatOnce     sync.Once
	heartbeatBootID   string
}

type replayEntry struct {
	status   int
	body     []byte
	storedAt time.Time
}

type activeTunnel struct {
	instanceID  string
	epoch       uint64
	connections []net.Conn
}

// Handler builds the protocol mux.
func (s *Server) Handler() http.Handler {
	if s.Log == nil {
		s.Log = slog.Default()
	}
	s.replayed = make(map[string]replayEntry)
	s.tunnels = make(map[*activeTunnel]struct{})
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

// RequireHostActivityHeartbeat disables unconditional watchdog refresh. Dial-home
// sessions call SetControlConnected; static mode refreshes on lease activity.
func (s *Server) RequireHostActivityHeartbeat() {
	s.dialhomeHeartbeat.Store(true)
	s.controlConnected.Store(false)
}

// SetControlConnected updates dial-home admission liveness.
func (s *Server) SetControlConnected(connected bool) {
	s.controlConnected.Store(connected)
	if connected && s.dialhomeHeartbeat.Load() {
		s.touchHeartbeat()
	}
}

func (s *Server) heartbeatAllowed() bool {
	return !s.dialhomeHeartbeat.Load() || s.controlConnected.Load()
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
				s.CloseTunnelsThroughEpoch(expired.InstanceID, expired.Epoch)
				if len(s.Runtimes.List(expired.InstanceID)) > 0 {
					s.Log.Info("fencing runtimes of expired lease", "instanceId", expired.InstanceID, "epoch", expired.Epoch)
					if err := s.Runtimes.StopInstanceThroughEpoch(expired.InstanceID, expired.Epoch); err != nil {
						s.Log.Error("failed to fence runtimes of expired lease", "instanceId", expired.InstanceID, "epoch", expired.Epoch, "error", err)
					} else {
						s.removeCredentialEpochsThrough(expired.InstanceID, expired.Epoch)
					}
				}
			}
			if s.heartbeatAllowed() {
				s.touchHeartbeat()
			}
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
	s.heartbeatOnce.Do(func() {
		value := make([]byte, 16)
		if _, err := rand.Read(value); err != nil {
			s.heartbeatBootID = fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano())
			return
		}
		s.heartbeatBootID = hex.EncodeToString(value)
	})
	sequence := s.heartbeatSeq.Add(1)
	staged := fmt.Sprintf("%s.%d.%d.tmp", path, os.Getpid(), sequence)
	content := fmt.Sprintf("%s:%d\n", s.heartbeatBootID, sequence)
	if err := os.WriteFile(staged, []byte(content), 0o600); err != nil {
		s.Log.Warn("failed to stage heartbeat", "error", err)
		return
	}
	if err := os.Rename(staged, path); err != nil {
		_ = os.Remove(staged)
		s.Log.Warn("failed to publish heartbeat", "error", err)
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"protocolVersion": ProtocolVersion,
		"serverTime":      time.Now().UTC().Format(time.RFC3339Nano),
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

func writeLeaseGrant(w http.ResponseWriter, granted *lease.Lease) {
	writeJSON(w, http.StatusOK, map[string]any{
		"id":         granted.ID,
		"instanceId": granted.InstanceID,
		"epoch":      granted.Epoch,
		"expiresAt":  granted.ExpiresAt,
		"serverTime": time.Now().UTC().Format(time.RFC3339Nano),
	})
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
	if granted != nil {
		// The durable epoch supersedes prior write authority. Close old tunnels
		// and stop their VM before publishing the grant (or reporting uncertain
		// durability): socket EOF alone does not cancel a command already sent
		// into Gondolin's guest control plane.
		s.CloseTunnelsThroughEpoch(granted.InstanceID, granted.Epoch-1)
		if stopErr := s.Runtimes.StopInstanceThroughEpoch(granted.InstanceID, granted.Epoch-1); stopErr != nil {
			writeError(w, http.StatusInternalServerError, "fence_error", stopErr.Error())
			return
		}
		s.removeCredentialEpochsThrough(granted.InstanceID, granted.Epoch-1)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lease_error", err.Error())
		return
	}
	s.touchHeartbeat()
	s.Log.Info("lease acquired", "instanceId", granted.InstanceID, "epoch", granted.Epoch)
	writeLeaseGrant(w, granted)
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
	s.touchHeartbeat()
	writeLeaseGrant(w, renewed)
}

func (s *Server) handleReleaseLease(w http.ResponseWriter, r *http.Request) {
	released, err := s.Leases.Release(r.PathValue("id"))
	if released != nil {
		s.CloseTunnelsThroughEpoch(released.InstanceID, released.Epoch)
		if stopErr := s.Runtimes.StopInstanceThroughEpoch(released.InstanceID, released.Epoch); stopErr != nil {
			writeError(w, http.StatusInternalServerError, "fence_error", stopErr.Error())
			return
		}
		s.removeCredentialEpochsThrough(released.InstanceID, released.Epoch)
	}
	if err != nil {
		writeLeaseError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"released": true})
}

type networkPolicy struct {
	AllowedHosts         []string `json:"allowedHosts,omitempty"`
	AllowedInternalHosts []string `json:"allowedInternalHosts,omitempty"`
	BlockInternalRanges  *bool    `json:"blockInternalRanges,omitempty"`
}

type ensureRuntimeRequest struct {
	InstanceID       string                `json:"instanceId"`
	ImageSelector    string                `json:"imageSelector"`
	Mounts           []workerruntime.Mount `json:"mounts"`
	CredentialFiles  []credentialFile      `json:"credentialFiles"`
	CPUs             string                `json:"cpus"`
	Memory           string                `json:"memory"`
	Fingerprint      string                `json:"fingerprint"`
	Network          *networkPolicy        `json:"network,omitempty"`
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
	leaseID := r.Header.Get(leaseHeader)
	replayKey := ""
	if key := r.Header.Get("Idempotency-Key"); key != "" {
		replayKey = fmt.Sprintf("%s:%s:%d", key, leaseID, epoch)
		if entry, found := s.replay(replayKey); found {
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
	canonicalMounts, err := s.canonicalizeMounts(request.Mounts)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_mounts", err.Error())
		return
	}
	// Land shipped vault credentials as worker-local files and mount them by
	// path — the guest sees them exactly like a local file mount, without the
	// credential ever touching the shared workspace.
	credentialMounts, credentialIdentity, err := s.materializeCredentials(
		request.InstanceID,
		epoch,
		request.CredentialFiles,
	)
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
	// The janitor refreshes the heartbeat every 15s in the daemon. Reject
	// thresholds too close to that cadence: scheduler pauses or modest I/O
	// jitter would otherwise kill healthy VMs repeatedly.
	if heartbeatStaleMs < (30 * time.Second).Milliseconds() {
		writeError(w, http.StatusBadRequest, "invalid_request", "heartbeatStaleMs must be at least 30000")
		return
	}
	config := workerruntime.WorkerConfig{
		InstanceID:    request.InstanceID,
		ImageSelector: request.ImageSelector,
		Mounts:        append(canonicalMounts, credentialMounts...),
		CPUs:          vmCPUs,
		Memory:        request.Memory,
		Fingerprint:   effectiveRuntimeFingerprint(request.Fingerprint, credentialIdentity),
		Network: func() *workerruntime.NetworkPolicy {
			if request.Network == nil {
				return nil
			}
			return &workerruntime.NetworkPolicy{
				AllowedHosts:         request.Network.AllowedHosts,
				AllowedInternalHosts: request.Network.AllowedInternalHosts,
				BlockInternalRanges:  request.Network.BlockInternalRanges,
			}
		}(),
		HeartbeatStaleMs: heartbeatStaleMs,
	}
	ensured, err := s.Runtimes.Ensure(config, request.CPUs, epoch, func() error {
		return s.Leases.Validate(request.InstanceID, leaseID, epoch)
	})
	if err != nil {
		if errors.Is(err, lease.ErrExpired) || errors.Is(err, lease.ErrUnknownLease) || errors.Is(err, lease.ErrStaleEpoch) {
			writeLeaseError(w, err)
			return
		}
		writeError(w, http.StatusBadGateway, "runtime_error", err.Error())
		return
	}
	body, _ := json.Marshal(ensured)
	if replayKey != "" {
		s.remember(replayKey, http.StatusOK, body)
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
	s.removeCredentialEpochsThrough(entry.InstanceID, entry.Epoch)
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
	epoch, ok := s.authorizeLease(w, r, entry.InstanceID)
	if !ok {
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
	if err := s.RegisterTunnel(entry.InstanceID, r.Header.Get(leaseHeader), epoch, client, backend); err != nil {
		client.Close()
		backend.Close()
		return
	}
	defer s.UnregisterTunnel(client)
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

// RegisterTunnel atomically revalidates a grant and tracks both sides of an
// upgraded session. Acquire/release fencing takes the same registry lock, so a
// stale tunnel cannot slip in between validation and supersession.
func (s *Server) RegisterTunnel(
	instanceID string,
	leaseID string,
	epoch uint64,
	connections ...net.Conn,
) error {
	s.tunnelMu.Lock()
	defer s.tunnelMu.Unlock()
	if err := s.Leases.Validate(instanceID, leaseID, epoch); err != nil {
		return err
	}
	if s.tunnels == nil {
		s.tunnels = make(map[*activeTunnel]struct{})
	}
	s.tunnels[&activeTunnel{instanceID: instanceID, epoch: epoch, connections: connections}] = struct{}{}
	return nil
}

// UnregisterTunnel removes the tunnel containing connection after splice exits.
func (s *Server) UnregisterTunnel(connection net.Conn) {
	s.tunnelMu.Lock()
	defer s.tunnelMu.Unlock()
	for tunnel := range s.tunnels {
		for _, candidate := range tunnel.connections {
			if candidate == connection {
				delete(s.tunnels, tunnel)
				return
			}
		}
	}
}

// CloseTunnelsThroughEpoch synchronously revokes old write channels before a
// replacement lease is returned or an expired runtime is fenced.
func (s *Server) CloseTunnelsThroughEpoch(instanceID string, maxEpoch uint64) {
	s.tunnelMu.Lock()
	defer s.tunnelMu.Unlock()
	for tunnel := range s.tunnels {
		if tunnel.instanceID != instanceID || tunnel.epoch > maxEpoch {
			continue
		}
		delete(s.tunnels, tunnel)
		for _, connection := range tunnel.connections {
			_ = connection.Close()
		}
	}
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

func (s *Server) credentialDir(instanceID string) string {
	key := fmt.Sprintf("%x", sha256.Sum256([]byte(instanceID)))
	return filepath.Join(s.credentialsDir(), key)
}

func (s *Server) credentialEpochDir(instanceID string, epoch uint64) string {
	return filepath.Join(s.credentialDir(instanceID), strconv.FormatUint(epoch, 10))
}

func (s *Server) credentialsDir() string {
	return s.CredentialsDir
}

func effectiveRuntimeFingerprint(requestFingerprint string, credentialIdentity string) string {
	if credentialIdentity == "" {
		return requestFingerprint
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(requestFingerprint+"\x00"+credentialIdentity)))
}

// materializeCredentials publishes immutable files under a content-scoped
// generation. A failed or concurrent replacement cannot truncate credentials
// still backing a live runtime.
func (s *Server) materializeCredentials(
	instanceID string,
	epoch uint64,
	files []credentialFile,
) ([]workerruntime.Mount, string, error) {
	if len(files) == 0 {
		return nil, "", nil
	}
	parent := s.credentialEpochDir(instanceID, epoch)
	digest := sha256.New()
	for _, file := range files {
		_, _ = digest.Write([]byte(file.Target))
		_, _ = digest.Write([]byte{0})
		_, _ = digest.Write([]byte(file.ContentBase64))
		_, _ = digest.Write([]byte{0})
	}
	credentialIdentity := fmt.Sprintf("%x", digest.Sum(nil))
	dir := filepath.Join(parent, credentialIdentity)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, "", fmt.Errorf("create credential directory: %w", err)
	}
	staged, err := os.MkdirTemp(parent, ".staged-")
	if err != nil {
		return nil, "", fmt.Errorf("stage credential generation: %w", err)
	}
	removeStaged := true
	defer func() {
		if removeStaged {
			_ = os.RemoveAll(staged)
		}
	}()
	mounts := make([]workerruntime.Mount, 0, len(files))
	targets := make(map[string]struct{}, len(files))
	for i, file := range files {
		if !filepath.IsAbs(file.Target) {
			return nil, "", fmt.Errorf("credential target must be absolute: %s", file.Target)
		}
		target := filepath.Clean(file.Target)
		if target == "/workspace" || strings.HasPrefix(target, "/workspace/") {
			return nil, "", fmt.Errorf("credential target must be outside /workspace: %s", file.Target)
		}
		if _, duplicate := targets[target]; duplicate {
			return nil, "", fmt.Errorf("duplicate credential target: %s", file.Target)
		}
		targets[target] = struct{}{}
		content, err := base64.StdEncoding.DecodeString(file.ContentBase64)
		if err != nil {
			return nil, "", fmt.Errorf("decode credential for %s: %w", file.Target, err)
		}
		name := fmt.Sprintf("cred-%d-%s", i, filepath.Base(file.Target))
		if err := os.WriteFile(filepath.Join(staged, name), content, 0o600); err != nil {
			return nil, "", fmt.Errorf("write credential %s: %w", file.Target, err)
		}
		mounts = append(mounts, workerruntime.Mount{Source: filepath.Join(dir, name), Target: target})
	}
	if err := os.Rename(staged, dir); err != nil {
		if _, statErr := os.Stat(dir); statErr != nil {
			return nil, "", fmt.Errorf("publish credential generation: %w", err)
		}
		if err := validateCredentialGeneration(staged, dir); err != nil {
			return nil, "", fmt.Errorf("validate existing credential generation: %w", err)
		}
	} else {
		removeStaged = false
	}
	return mounts, credentialIdentity, nil
}

func validateCredentialGeneration(expectedDir string, actualDir string) error {
	expected, err := os.ReadDir(expectedDir)
	if err != nil {
		return err
	}
	actual, err := os.ReadDir(actualDir)
	if err != nil {
		return err
	}
	if len(expected) != len(actual) {
		return errors.New("credential file count differs")
	}
	for _, expectedEntry := range expected {
		if !expectedEntry.Type().IsRegular() {
			return fmt.Errorf("staged credential %s is not a regular file", expectedEntry.Name())
		}
		actualPath := filepath.Join(actualDir, expectedEntry.Name())
		info, err := os.Lstat(actualPath)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
			return fmt.Errorf("credential %s is missing, non-regular, or not mode 0600", expectedEntry.Name())
		}
		expectedContent, err := os.ReadFile(filepath.Join(expectedDir, expectedEntry.Name()))
		if err != nil {
			return err
		}
		actualContent, err := os.ReadFile(actualPath)
		if err != nil {
			return err
		}
		if !bytes.Equal(expectedContent, actualContent) {
			return fmt.Errorf("credential %s content differs", expectedEntry.Name())
		}
	}
	return nil
}

func (s *Server) removeCredentialEpochsThrough(instanceID string, maxEpoch uint64) {
	root := s.credentialDir(instanceID)
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		epoch, err := strconv.ParseUint(entry.Name(), 10, 64)
		if err == nil && epoch <= maxEpoch {
			_ = os.RemoveAll(filepath.Join(root, entry.Name()))
		}
	}
}

func (s *Server) canonicalizeMounts(mounts []workerruntime.Mount) ([]workerruntime.Mount, error) {
	var resolvedRoot string
	if s.WorkspaceRoot != "" {
		var err error
		resolvedRoot, err = filepath.EvalSymlinks(s.WorkspaceRoot)
		if err != nil {
			return nil, fmt.Errorf("resolve workspace root %s: %w", s.WorkspaceRoot, err)
		}
		resolvedRoot = filepath.Clean(resolvedRoot)
	}
	canonical := make([]workerruntime.Mount, 0, len(mounts))
	for _, mount := range mounts {
		if !filepath.IsAbs(mount.Source) || !filepath.IsAbs(mount.Target) {
			return nil, fmt.Errorf("mount paths must be absolute: %s -> %s", mount.Source, mount.Target)
		}
		resolvedSource, err := filepath.EvalSymlinks(mount.Source)
		if err != nil {
			return nil, fmt.Errorf("resolve mount source %s: %w", mount.Source, err)
		}
		resolvedSource = filepath.Clean(resolvedSource)
		if resolvedRoot != "" {
			relative, err := filepath.Rel(resolvedRoot, resolvedSource)
			if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
				return nil, fmt.Errorf("mount source %s escapes the workspace root", mount.Source)
			}
		}
		canonical = append(canonical, workerruntime.Mount{Source: resolvedSource, Target: mount.Target})
	}
	return canonical, nil
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
	case errors.Is(err, lease.ErrStaleEpoch):
		writeError(w, http.StatusConflict, "stale_epoch", err.Error())
	case errors.Is(err, lease.ErrUnknownLease):
		writeError(w, http.StatusNotFound, "unknown_lease", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "lease_error", err.Error())
	}
}
