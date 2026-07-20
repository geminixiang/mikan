// Package runtime supervises the detached Node processes that each host one
// Gondolin VM. It reuses the Node workers' inventory records (the same JSON
// contract local mikan uses) to rediscover runtimes across daemon restarts.
package runtime

import (
	"bufio"
	"context"
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

type NetworkPolicy struct {
	AllowedHosts         []string `json:"allowedHosts,omitempty"`
	AllowedInternalHosts []string `json:"allowedInternalHosts,omitempty"`
	BlockInternalRanges  *bool    `json:"blockInternalRanges,omitempty"`
}

// WorkerConfig is the JSON argv contract of gondolin-worker-main.js.
type WorkerConfig struct {
	InstanceID       string         `json:"instanceId"`
	Image            string         `json:"image,omitempty"`
	ImageSelector    string         `json:"imageSelector,omitempty"`
	Mounts           []Mount        `json:"mounts"`
	CPUs             int            `json:"cpus,omitempty"`
	Memory           string         `json:"memory,omitempty"`
	Fingerprint      string         `json:"fingerprint"`
	Network          *NetworkPolicy `json:"network,omitempty"`
	InventoryDir     string         `json:"inventoryDir"`
	HeartbeatStaleMs int64          `json:"heartbeatStaleMs"`
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
	CreatedAt   string `json:"createdAt"`
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

// Confiner confines a spawned worker's process tree (cgroups on Linux) and
// releases the confinement when the runtime stops. Both sides of the seam
// are best-effort; a Place without a matching Release leaks an empty cgroup
// directory per runtime, so the supervisor releases on every Stop.
type Confiner interface {
	Place(pid int, sessionID string, cpus string, memory string) error
	Release(sessionID string)
}

type noopConfiner struct{}

func (noopConfiner) Place(int, string, string, string) error { return nil }
func (noopConfiner) Release(string)                          {}

type instanceLock struct {
	mu   sync.Mutex
	refs int
}

// Supervisor spawns, rediscovers, and stops runtime host processes.
type Supervisor struct {
	mu               sync.Mutex
	locksMu          sync.Mutex
	instanceLocks    map[string]*instanceLock
	nodeBin          string
	workerEntry      string
	inventoryDir     string
	handshakeTimeout time.Duration
	stopWait         time.Duration
	confine          Confiner
	verifyWorkerPID  func(int) (bool, error)
	verifyRunnerPID  func(int) (bool, error)
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
	Confine          Confiner
	VerifyWorkerPID  func(int) (bool, error)
	VerifyRunnerPID  func(int) (bool, error)
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
	if options.Confine == nil {
		options.Confine = noopConfiner{}
	}
	if options.VerifyWorkerPID == nil {
		options.VerifyWorkerPID = workerPIDVerifier(options.WorkerEntry)
	}
	if options.VerifyRunnerPID == nil {
		options.VerifyRunnerPID = runnerPIDVerifier
	}
	supervisor := &Supervisor{
		nodeBin:          options.NodeBin,
		workerEntry:      options.WorkerEntry,
		inventoryDir:     options.InventoryDir,
		handshakeTimeout: options.HandshakeTimeout,
		stopWait:         options.StopWait,
		confine:          options.Confine,
		verifyWorkerPID:  options.VerifyWorkerPID,
		verifyRunnerPID:  options.VerifyRunnerPID,
		log:              options.Log,
		runtimes:         make(map[string]*Runtime),
		instanceLocks:    make(map[string]*instanceLock),
	}
	supervisor.rediscover()
	return supervisor
}

// Ensure returns a live runtime for the instance: it adopts a surviving one
// whose fingerprint matches, stops one that drifted, and spawns otherwise.
// The runtime is (re)bound to the caller's fencing epoch. leaseValid is checked
// throughout slow lifecycle work so an expired request cannot publish a VM
// after the host's failover fence has passed.
func (s *Supervisor) Ensure(
	config WorkerConfig,
	cgroupCPUs string,
	epoch uint64,
	leaseValid func() error,
) (*Runtime, error) {
	unlock := s.lockInstance(config.InstanceID)
	defer unlock()

	if err := leaseValid(); err != nil {
		return nil, fmt.Errorf("lease no longer valid: %w", err)
	}
	s.mu.Lock()
	existing := s.byInstanceLocked(config.InstanceID)
	s.mu.Unlock()

	if existing != nil {
		if s.pidAlive(existing.WorkerPid) && existing.Fingerprint == config.Fingerprint {
			if err := leaseValid(); err != nil {
				return nil, fmt.Errorf("lease no longer valid: %w", err)
			}
			s.mu.Lock()
			existing.Epoch = epoch
			existing.Adopted = true
			adopted := *existing
			s.mu.Unlock()
			return &adopted, nil
		}
		if err := s.stopUnlocked(existing.SessionID, false); err != nil && !errors.Is(err, ErrNotFound) {
			return nil, fmt.Errorf("stop stale runtime: %w", err)
		}
	}
	return s.spawn(config, cgroupCPUs, epoch, leaseValid)
}

// List snapshots live runtimes, optionally filtered by instance id.
func (s *Supervisor) List(instanceID string) []Runtime {
	return s.list(instanceID)
}

func (s *Supervisor) list(instanceID string) []Runtime {
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

// StopInstanceThroughEpoch stops runtimes no newer than a fencing snapshot.
// A janitor may wait behind a concurrent Ensure; the epoch guard prevents its
// stale expiry snapshot from killing a runtime rebound to a newer lease.
func (s *Supervisor) StopInstanceThroughEpoch(instanceID string, maxEpoch uint64) error {
	unlock := s.lockInstance(instanceID)
	defer unlock()
	var failures []error
	for _, entry := range s.list(instanceID) {
		if entry.Epoch > maxEpoch {
			continue
		}
		if err := s.stopUnlocked(entry.SessionID, true); err != nil && !errors.Is(err, ErrNotFound) {
			s.log.Warn("failed to stop fenced runtime", "sessionId", entry.SessionID, "error", err)
			failures = append(failures, fmt.Errorf("stop runtime %s: %w", entry.SessionID, err))
		}
	}
	return errors.Join(failures...)
}

// Stop terminates a runtime's worker process and reaps its leftovers.
func (s *Supervisor) Stop(sessionID string) error {
	s.mu.Lock()
	entry, ok := s.runtimes[sessionID]
	s.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	unlock := s.lockInstance(entry.InstanceID)
	defer unlock()
	return s.stopUnlocked(sessionID, false)
}

func (s *Supervisor) stopUnlocked(sessionID string, fence bool) error {
	s.mu.Lock()
	entry, ok := s.runtimes[sessionID]
	s.mu.Unlock()
	if !ok {
		return ErrNotFound
	}

	if s.pidAlive(entry.WorkerPid) {
		verified, err := s.verifyWorker(entry.WorkerPid)
		if err != nil {
			return fmt.Errorf("verify runtime process %d before stop: %w", entry.WorkerPid, err)
		}
		if verified {
			stopSignal := syscall.SIGTERM
			if fence {
				// The Node worker treats SIGUSR2 as a fencing shutdown: close the VM
				// without publishing guest file projections from a stale epoch.
				stopSignal = syscall.SIGUSR2
			}
			_ = syscall.Kill(entry.WorkerPid, stopSignal)
			if !s.waitForExit(entry.WorkerPid, s.stopWait) {
				_ = syscall.Kill(entry.WorkerPid, syscall.SIGKILL)
				if !s.waitForExit(entry.WorkerPid, 2*time.Second) {
					return fmt.Errorf("runtime process %d did not exit after SIGKILL", entry.WorkerPid)
				}
			}
		} else {
			s.log.Warn("runtime owner pid was reused; refusing to signal unrelated process", "pid", entry.WorkerPid, "sessionId", entry.SessionID)
		}
	}
	s.mu.Lock()
	delete(s.runtimes, sessionID)
	s.mu.Unlock()
	if err := s.reapLeftovers(entry); err != nil {
		s.mu.Lock()
		s.runtimes[sessionID] = entry
		s.mu.Unlock()
		return err
	}
	s.confine.Release(entry.SessionID)
	return nil
}

// Count reports live runtimes for capacity reporting.
func (s *Supervisor) Count() int {
	return len(s.List(""))
}

func (s *Supervisor) spawn(
	config WorkerConfig,
	cgroupCPUs string,
	epoch uint64,
	leaseValid func() error,
) (*Runtime, error) {
	if err := leaseValid(); err != nil {
		return nil, fmt.Errorf("lease no longer valid: %w", err)
	}
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

	shake, err := s.readHandshake(stdout, leaseValid)
	if err != nil {
		killProcessGroup(cmd.Process.Pid)
		return nil, err
	}
	if err := leaseValid(); err != nil {
		if abortErr := s.abortSpawn(cmd.Process.Pid, shake, false); abortErr != nil {
			return nil, errors.Join(fmt.Errorf("lease no longer valid: %w", err), abortErr)
		}
		return nil, fmt.Errorf("lease no longer valid: %w", err)
	}
	if err := s.confine.Place(cmd.Process.Pid, shake.SessionID, cgroupCPUs, config.Memory); err != nil {
		s.log.Warn("cgroup placement failed", "sessionId", shake.SessionID, "error", err)
	}
	if err := leaseValid(); err != nil {
		if abortErr := s.abortSpawn(cmd.Process.Pid, shake, true); abortErr != nil {
			return nil, errors.Join(fmt.Errorf("lease no longer valid: %w", err), abortErr)
		}
		return nil, fmt.Errorf("lease no longer valid: %w", err)
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

func (s *Supervisor) abortSpawn(processPID int, shake *handshake, confined bool) error {
	killProcessGroup(processPID)
	workerPID := shake.WorkerPid
	if workerPID == 0 {
		workerPID = processPID
	}
	reapErr := s.reapLeftovers(&Runtime{
		SessionID: shake.SessionID,
		WorkerPid: workerPID,
		RunnerPid: shake.RunnerPid,
	})
	if confined {
		s.confine.Release(shake.SessionID)
	}
	return reapErr
}

func killProcessGroup(pid int) {
	// spawn uses Setsid, so a negative pid reaches pre-handshake VM children
	// whose PIDs are not known yet. Fall back to the parent for defensive use
	// on platforms where the process group is already gone.
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	_ = syscall.Kill(pid, syscall.SIGKILL)
}

func (s *Supervisor) readHandshake(
	stdout interface{ Read([]byte) (int, error) },
	leaseValid func() error,
) (*handshake, error) {
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
	timeout := time.NewTimer(s.handshakeTimeout)
	defer timeout.Stop()
	leaseCheck := time.NewTicker(100 * time.Millisecond)
	defer leaseCheck.Stop()
	for {
		select {
		case r := <-results:
			return r.shake, r.err
		case <-leaseCheck.C:
			if err := leaseValid(); err != nil {
				return nil, fmt.Errorf("lease no longer valid while starting runtime: %w", err)
			}
		case <-timeout.C:
			return nil, fmt.Errorf("worker not ready within %s", s.handshakeTimeout)
		}
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
		if !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		// No filename allowlist beyond .json: anything that is not an
		// inventory record (wrong shape, no sessionId) fails the parse
		// checks below, so foreign files in the dir are skipped by content.
		raw, err := os.ReadFile(filepath.Join(s.inventoryDir, file.Name()))
		if err != nil {
			continue
		}
		var record inventoryRecord
		if err := json.Unmarshal(raw, &record); err != nil || !validInventoryRecord(file.Name(), record) {
			s.log.Warn("skipping invalid runtime inventory", "file", file.Name())
			continue
		}
		if record.SocketPath == "" || !s.pidAlive(record.OwnerPid) {
			continue
		}
		verified, err := s.verifyWorker(record.OwnerPid)
		if err != nil {
			s.log.Warn("could not verify rediscovered runtime owner", "sessionId", record.SessionID, "pid", record.OwnerPid, "error", err)
			continue
		}
		if !verified {
			s.log.Warn("skipping runtime inventory whose owner pid was reused", "sessionId", record.SessionID, "pid", record.OwnerPid)
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

func validInventoryRecord(fileName string, record inventoryRecord) bool {
	if record.SessionID == "" ||
		record.InstanceID == "" ||
		record.Fingerprint == "" ||
		record.OwnerPid <= 0 ||
		record.RunnerPid < 0 ||
		!filepath.IsAbs(record.SocketPath) ||
		fileName != record.SessionID+".json" ||
		filepath.Base(fileName) != fileName {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, record.CreatedAt)
	return err == nil
}

// reapLeftovers removes the inventory record (and orphaned VM runner) of a
// worker that could not clean up after itself.
func (s *Supervisor) reapLeftovers(entry *Runtime) error {
	path := filepath.Join(s.inventoryDir, entry.SessionID+".json")
	inventoryExists := true
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		inventoryExists = false
	} else if err != nil {
		return fmt.Errorf("inspect runtime inventory %s: %w", path, err)
	}
	if entry.RunnerPid > 0 && s.pidAlive(entry.RunnerPid) {
		verified, err := s.verifyRunner(entry.RunnerPid)
		if err != nil {
			if !s.pidAlive(entry.RunnerPid) {
				verified = false
			} else {
				return fmt.Errorf("verify runner process %d: %w", entry.RunnerPid, err)
			}
		}
		if verified {
			s.log.Info("stopping orphaned VM runner", "runnerPid", entry.RunnerPid, "sessionId", entry.SessionID)
			_ = syscall.Kill(entry.RunnerPid, syscall.SIGTERM)
			if !s.waitForExit(entry.RunnerPid, 2*time.Second) {
				_ = syscall.Kill(entry.RunnerPid, syscall.SIGKILL)
				if !s.waitForExit(entry.RunnerPid, 2*time.Second) {
					return fmt.Errorf("VM runner process %d did not exit after SIGKILL", entry.RunnerPid)
				}
			}
		} else {
			s.log.Warn("runner pid was reused; refusing to signal unrelated process", "pid", entry.RunnerPid, "sessionId", entry.SessionID)
		}
	}
	if inventoryExists {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove runtime inventory %s: %w", path, err)
		}
	}
	return nil
}

func workerPIDVerifier(workerEntry string) func(int) (bool, error) {
	expected := filepath.Clean(workerEntry)
	return func(pid int) (bool, error) {
		if workerEntry == "" || expected == "." {
			return false, errors.New("worker entry identity is unavailable")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "ps", "-p", strconv.Itoa(pid), "-o", "command=").Output()
		if err != nil {
			return false, err
		}
		return strings.Contains(string(out), expected), nil
	}
}

func (s *Supervisor) verifyWorker(pid int) (bool, error) {
	if s.verifyWorkerPID == nil {
		return false, errors.New("worker process verifier is unavailable")
	}
	return s.verifyWorkerPID(pid)
}

func runnerPIDVerifier(pid int) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-p", strconv.Itoa(pid), "-o", "command=").Output()
	if err != nil {
		return false, err
	}
	return strings.Contains(strings.ToLower(string(out)), "gondolin"), nil
}

func (s *Supervisor) verifyRunner(pid int) (bool, error) {
	if s.verifyRunnerPID == nil {
		return false, errors.New("runner process verifier is unavailable")
	}
	return s.verifyRunnerPID(pid)
}

func (s *Supervisor) lockInstance(instanceID string) func() {
	s.locksMu.Lock()
	if s.instanceLocks == nil {
		s.instanceLocks = make(map[string]*instanceLock)
	}
	lock := s.instanceLocks[instanceID]
	if lock == nil {
		lock = &instanceLock{}
		s.instanceLocks[instanceID] = lock
	}
	lock.refs++
	s.locksMu.Unlock()
	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		s.locksMu.Lock()
		lock.refs--
		if lock.refs == 0 {
			delete(s.instanceLocks, instanceID)
		}
		s.locksMu.Unlock()
	}
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
