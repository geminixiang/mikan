// Package runtime supervises the detached Node processes that each host one
// Gondolin VM. It reuses the Node workers' inventory records (the same JSON
// contract local mikan uses) to rediscover runtimes across daemon restarts.
package runtime

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ErrNotFound reports an unknown session id.
var ErrNotFound = errors.New("runtime not found")

// Mount is one worker-local path projected into the VM.
type Mount struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

// WorkerConfig is the JSON argv contract of gondolin-worker-main.js.
type WorkerConfig struct {
	InstanceID       string  `json:"instanceId"`
	Image            string  `json:"image,omitempty"`
	ImageSelector    string  `json:"imageSelector,omitempty"`
	Mounts           []Mount `json:"mounts"`
	CPUs             int     `json:"cpus,omitempty"`
	Memory           string  `json:"memory,omitempty"`
	Fingerprint      string  `json:"fingerprint"`
	InventoryDir     string  `json:"inventoryDir"`
	HeartbeatStaleMs int64   `json:"heartbeatStaleMs"`
}

type handshake struct {
	Ready      bool   `json:"ready"`
	Error      string `json:"error"`
	SessionID  string `json:"sessionId"`
	SocketPath string `json:"socketPath"`
	WorkerPid  int    `json:"workerPid"`
	RunnerPid  int    `json:"runnerPid"`
}

type inventoryRecord struct {
	SessionID   string `json:"sessionId"`
	InstanceID  string `json:"instanceId"`
	OwnerPid    int    `json:"ownerPid"`
	RunnerPid   int    `json:"runnerPid"`
	SocketPath  string `json:"socketPath"`
	Fingerprint string `json:"fingerprint"`
}

// Runtime is one live Gondolin VM host process.
type Runtime struct {
	SessionID   string `json:"sessionId"`
	InstanceID  string `json:"instanceId"`
	Fingerprint string `json:"fingerprint"`
	SocketPath  string `json:"-"`
	WorkerPid   int    `json:"workerPid"`
	RunnerPid   int    `json:"runnerPid"`
	Epoch       uint64 `json:"epoch"`
	Adopted     bool   `json:"adopted"`
}

// Placer confines a spawned worker's process tree (cgroups on Linux).
type Placer func(pid int, sessionID string, cpus string, memory string) error

// Supervisor spawns, rediscovers, and stops runtime host processes.
type Supervisor struct {
	mu               sync.Mutex
	nodeBin          string
	workerEntry      string
	inventoryDir     string
	handshakeTimeout time.Duration
	stopWait         time.Duration
	place            Placer
	log              *slog.Logger
	runtimes         map[string]*Runtime // by session id
}

// Options configures a Supervisor.
type Options struct {
	NodeBin          string
	WorkerEntry      string
	InventoryDir     string
	HandshakeTimeout time.Duration
	StopWait         time.Duration
	Place            Placer
	Log              *slog.Logger
}

// NewSupervisor builds a Supervisor and rediscovers surviving runtimes.
func NewSupervisor(options Options) *Supervisor {
	if options.HandshakeTimeout == 0 {
		options.HandshakeTimeout = 2 * time.Minute
	}
	if options.StopWait == 0 {
		options.StopWait = 15 * time.Second
	}
	if options.Log == nil {
		options.Log = slog.Default()
	}
	if options.Place == nil {
		options.Place = func(int, string, string, string) error { return nil }
	}
	supervisor := &Supervisor{
		nodeBin:          options.NodeBin,
		workerEntry:      options.WorkerEntry,
		inventoryDir:     options.InventoryDir,
		handshakeTimeout: options.HandshakeTimeout,
		stopWait:         options.StopWait,
		place:            options.Place,
		log:              options.Log,
		runtimes:         make(map[string]*Runtime),
	}
	supervisor.rediscover()
	return supervisor
}

// Ensure returns a live runtime for the instance: it adopts a surviving one
// whose fingerprint matches, stops one that drifted, and spawns otherwise.
// The runtime is (re)bound to the caller's fencing epoch.
func (s *Supervisor) Ensure(config WorkerConfig, cgroupCPUs string, epoch uint64) (*Runtime, error) {
	s.mu.Lock()
	existing := s.byInstanceLocked(config.InstanceID)
	s.mu.Unlock()

	if existing != nil {
		if s.pidAlive(existing.WorkerPid) && existing.Fingerprint == config.Fingerprint {
			s.mu.Lock()
			existing.Epoch = epoch
			existing.Adopted = true
			adopted := *existing
			s.mu.Unlock()
			return &adopted, nil
		}
		if err := s.Stop(existing.SessionID); err != nil && !errors.Is(err, ErrNotFound) {
			return nil, fmt.Errorf("stop stale runtime: %w", err)
		}
	}
	return s.spawn(config, cgroupCPUs, epoch)
}

// List snapshots live runtimes, optionally filtered by instance id.
func (s *Supervisor) List(instanceID string) []Runtime {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Runtime
	for _, entry := range s.runtimes {
		if instanceID != "" && entry.InstanceID != instanceID {
			continue
		}
		if !s.pidAlive(entry.WorkerPid) {
			continue
		}
		out = append(out, *entry)
	}
	return out
}

// Get returns a live runtime by session id.
func (s *Supervisor) Get(sessionID string) (*Runtime, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.runtimes[sessionID]
	if !ok || !s.pidAlive(entry.WorkerPid) {
		return nil, ErrNotFound
	}
	found := *entry
	return &found, nil
}

// StopInstance stops every runtime bound to the instance (lease fencing).
func (s *Supervisor) StopInstance(instanceID string) {
	for _, entry := range s.List(instanceID) {
		if err := s.Stop(entry.SessionID); err != nil && !errors.Is(err, ErrNotFound) {
			s.log.Warn("failed to stop fenced runtime", "sessionId", entry.SessionID, "error", err)
		}
	}
}

// Stop terminates a runtime's worker process and reaps its leftovers.
func (s *Supervisor) Stop(sessionID string) error {
	s.mu.Lock()
	entry, ok := s.runtimes[sessionID]
	if ok {
		delete(s.runtimes, sessionID)
	}
	s.mu.Unlock()
	if !ok {
		return ErrNotFound
	}

	if s.pidAlive(entry.WorkerPid) {
		_ = syscall.Kill(entry.WorkerPid, syscall.SIGTERM)
		if !s.waitForExit(entry.WorkerPid, s.stopWait) {
			_ = syscall.Kill(entry.WorkerPid, syscall.SIGKILL)
			s.waitForExit(entry.WorkerPid, 2*time.Second)
		}
	}
	s.reapLeftovers(entry)
	return nil
}

// Count reports live runtimes for capacity reporting.
func (s *Supervisor) Count() int {
	return len(s.List(""))
}

func (s *Supervisor) spawn(config WorkerConfig, cgroupCPUs string, epoch uint64) (*Runtime, error) {
	config.InventoryDir = s.inventoryDir
	raw, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(s.nodeBin, s.workerEntry, string(raw))
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("spawn worker: %w", err)
	}
	// Never wait on the child beyond the handshake: it must outlive the daemon.
	go func() { _ = cmd.Wait() }()

	shake, err := s.readHandshake(stdout)
	if err != nil {
		_ = syscall.Kill(cmd.Process.Pid, syscall.SIGKILL)
		return nil, err
	}
	if err := s.place(cmd.Process.Pid, shake.SessionID, cgroupCPUs, config.Memory); err != nil {
		s.log.Warn("cgroup placement failed", "sessionId", shake.SessionID, "error", err)
	}

	entry := &Runtime{
		SessionID:   shake.SessionID,
		InstanceID:  config.InstanceID,
		Fingerprint: config.Fingerprint,
		SocketPath:  shake.SocketPath,
		WorkerPid:   shake.WorkerPid,
		RunnerPid:   shake.RunnerPid,
		Epoch:       epoch,
	}
	if entry.WorkerPid == 0 {
		entry.WorkerPid = cmd.Process.Pid
	}
	s.mu.Lock()
	s.runtimes[entry.SessionID] = entry
	s.mu.Unlock()
	created := *entry
	return &created, nil
}

func (s *Supervisor) readHandshake(stdout interface{ Read([]byte) (int, error) }) (*handshake, error) {
	type result struct {
		shake *handshake
		err   error
	}
	results := make(chan result, 1)
	go func() {
		reader := bufio.NewReader(stdout)
		line, err := reader.ReadString('\n')
		if err != nil {
			results <- result{nil, fmt.Errorf("worker exited before handshake: %w", err)}
			return
		}
		var shake handshake
		if err := json.Unmarshal([]byte(line), &shake); err != nil {
			results <- result{nil, fmt.Errorf("invalid worker handshake %q: %w", strings.TrimSpace(line), err)}
			return
		}
		if !shake.Ready {
			results <- result{nil, fmt.Errorf("worker failed to start: %s", shake.Error)}
			return
		}
		results <- result{&shake, nil}
	}()
	select {
	case r := <-results:
		return r.shake, r.err
	case <-time.After(s.handshakeTimeout):
		return nil, fmt.Errorf("worker not ready within %s", s.handshakeTimeout)
	}
}

// rediscover rebuilds the runtime table from inventory records left by
// workers that survived a daemon restart.
func (s *Supervisor) rediscover() {
	entries, err := os.ReadDir(s.inventoryDir)
	if err != nil {
		return
	}
	for _, file := range entries {
		if !strings.HasSuffix(file.Name(), ".json") || file.Name() == "leases.json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.inventoryDir, file.Name()))
		if err != nil {
			continue
		}
		var record inventoryRecord
		if err := json.Unmarshal(raw, &record); err != nil || record.SessionID == "" {
			continue
		}
		if record.SocketPath == "" || !s.pidAlive(record.OwnerPid) {
			continue
		}
		s.runtimes[record.SessionID] = &Runtime{
			SessionID:   record.SessionID,
			InstanceID:  record.InstanceID,
			Fingerprint: record.Fingerprint,
			SocketPath:  record.SocketPath,
			WorkerPid:   record.OwnerPid,
			RunnerPid:   record.RunnerPid,
			Adopted:     true,
		}
		s.log.Info("rediscovered runtime", "sessionId", record.SessionID, "instanceId", record.InstanceID)
	}
}

// reapLeftovers removes the inventory record (and orphaned VM runner) of a
// worker that could not clean up after itself.
func (s *Supervisor) reapLeftovers(entry *Runtime) {
	path := filepath.Join(s.inventoryDir, entry.SessionID+".json")
	if _, err := os.Stat(path); err != nil {
		return // graceful worker shutdown released its own record
	}
	if entry.RunnerPid > 0 && s.pidAlive(entry.RunnerPid) && s.looksLikeGondolinRunner(entry.RunnerPid) {
		s.log.Info("stopping orphaned VM runner", "runnerPid", entry.RunnerPid, "sessionId", entry.SessionID)
		_ = syscall.Kill(entry.RunnerPid, syscall.SIGTERM)
		if !s.waitForExit(entry.RunnerPid, 2*time.Second) {
			_ = syscall.Kill(entry.RunnerPid, syscall.SIGKILL)
		}
	}
	_ = os.Remove(path)
}

func (s *Supervisor) looksLikeGondolinRunner(pid int) bool {
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "command=").Output()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(out)), "gondolin")
}

func (s *Supervisor) byInstanceLocked(instanceID string) *Runtime {
	for _, entry := range s.runtimes {
		if entry.InstanceID == instanceID {
			return entry
		}
	}
	return nil
}

func (s *Supervisor) pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

func (s *Supervisor) waitForExit(pid int, wait time.Duration) bool {
	deadline := time.Now().Add(wait)
	for s.pidAlive(pid) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
	return true
}
