package runtime

import (
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeConfiner struct {
	released []string
}

func (f *fakeConfiner) Place(int, string, string, string) error { return nil }

func (f *fakeConfiner) Release(sessionID string) {
	f.released = append(f.released, sessionID)
}

func TestInstanceLifecycleLockSerializesOneInstanceOnly(t *testing.T) {
	supervisor := &Supervisor{}
	unlockFirst := supervisor.lockInstance("same")
	var sameEntered atomic.Bool
	var otherEntered atomic.Bool
	done := make(chan struct{}, 2)
	go func() {
		unlock := supervisor.lockInstance("same")
		sameEntered.Store(true)
		unlock()
		done <- struct{}{}
	}()
	go func() {
		unlock := supervisor.lockInstance("other")
		otherEntered.Store(true)
		unlock()
		done <- struct{}{}
	}()

	deadline := time.Now().Add(time.Second)
	for !otherEntered.Load() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !otherEntered.Load() {
		t.Fatal("different instance was unnecessarily serialized")
	}
	if sameEntered.Load() {
		t.Fatal("same instance entered concurrently")
	}
	unlockFirst()
	<-done
	<-done
	if !sameEntered.Load() {
		t.Fatal("same instance never entered after release")
	}
}

func TestStopInstanceThroughEpochPreservesNewerRuntime(t *testing.T) {
	oldProcess := exec.Command("sleep", "60")
	newProcess := exec.Command("sleep", "60")
	if err := oldProcess.Start(); err != nil {
		t.Fatal(err)
	}
	if err := newProcess.Start(); err != nil {
		_ = oldProcess.Process.Kill()
		t.Fatal(err)
	}
	go func() { _ = oldProcess.Wait() }()
	go func() { _ = newProcess.Wait() }()
	t.Cleanup(func() {
		_ = oldProcess.Process.Kill()
		_ = newProcess.Process.Kill()
	})
	supervisor := &Supervisor{
		inventoryDir:    t.TempDir(),
		stopWait:        time.Millisecond,
		confine:         &fakeConfiner{},
		verifyWorkerPID: func(int) (bool, error) { return true, nil },
		log:             slog.Default(),
		runtimes: map[string]*Runtime{
			"old": {SessionID: "old", InstanceID: "inst", WorkerPid: oldProcess.Process.Pid, Epoch: 4},
			"new": {SessionID: "new", InstanceID: "inst", WorkerPid: newProcess.Process.Pid, Epoch: 5},
		},
	}

	if err := supervisor.StopInstanceThroughEpoch("inst", 4); err != nil {
		t.Fatal(err)
	}

	if _, ok := supervisor.runtimes["old"]; ok {
		t.Fatal("expired epoch survived cleanup")
	}
	if _, ok := supervisor.runtimes["new"]; !ok {
		t.Fatal("newer epoch was stopped by stale janitor snapshot")
	}
}

func TestEnsureAbortsWhenLeaseExpiresDuringHandshake(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "slow-worker.sh")
	content := "#!/bin/sh\nsleep 2\necho '{\"ready\":true,\"sessionId\":\"late\",\"socketPath\":\"/tmp/late\",\"workerPid\":'$$',\"runnerPid\":0}'\n"
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	supervisor := NewSupervisor(Options{
		NodeBin:          "/bin/sh",
		WorkerEntry:      script,
		InventoryDir:     filepath.Join(dir, "inventory"),
		HandshakeTimeout: 5 * time.Second,
		StopWait:         time.Millisecond,
	})
	started := time.Now()
	leaseValid := func() error {
		if time.Since(started) >= 50*time.Millisecond {
			return errors.New("expired")
		}
		return nil
	}

	_, err := supervisor.Ensure(WorkerConfig{InstanceID: "inst", Fingerprint: "fp"}, "", 1, leaseValid)
	if err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expected lease expiry, got %v", err)
	}
	if elapsed := time.Since(started); elapsed >= time.Second {
		t.Fatalf("lease expiry did not interrupt handshake promptly: %s", elapsed)
	}
	if supervisor.Count() != 0 {
		t.Fatal("expired ensure published a runtime")
	}
}

func TestAbortSpawnRemovesPublishedInventoryAndConfinement(t *testing.T) {
	dir := t.TempDir()
	process := exec.Command("sleep", "60")
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = process.Process.Kill()
		_, _ = process.Process.Wait()
	})
	inventory := filepath.Join(dir, "announced.json")
	if err := os.WriteFile(inventory, []byte(`{"sessionId":"announced"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	confiner := &fakeConfiner{}
	supervisor := &Supervisor{inventoryDir: dir, confine: confiner, log: slog.Default()}

	if err := supervisor.abortSpawn(process.Process.Pid, &handshake{
		SessionID: "announced",
		WorkerPid: process.Process.Pid,
	}, true); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(inventory); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("aborted spawn inventory remains: %v", err)
	}
	if len(confiner.released) != 1 || confiner.released[0] != "announced" {
		t.Fatalf("aborted spawn confinement not released: %v", confiner.released)
	}
}

func TestReapRunnerEvenWhenInventoryAlreadyDisappeared(t *testing.T) {
	runner := exec.Command("sleep", "60")
	if err := runner.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { _ = runner.Wait() }()
	t.Cleanup(func() { _ = runner.Process.Kill() })
	supervisor := &Supervisor{
		inventoryDir:    t.TempDir(),
		verifyRunnerPID: func(int) (bool, error) { return true, nil },
		log:             slog.Default(),
	}

	if err := supervisor.reapLeftovers(&Runtime{
		SessionID: "missing-inventory",
		RunnerPid: runner.Process.Pid,
	}); err != nil {
		t.Fatal(err)
	}
	if supervisor.pidAlive(runner.Process.Pid) {
		t.Fatal("known runner survived because inventory was already absent")
	}
}

func TestReapFailurePreservesRuntimeForRetry(t *testing.T) {
	supervisor := &Supervisor{
		inventoryDir:    t.TempDir(),
		confine:         &fakeConfiner{},
		verifyWorkerPID: func(int) (bool, error) { return false, nil },
		verifyRunnerPID: func(int) (bool, error) { return false, errors.New("ps unavailable") },
		log:             slog.Default(),
		runtimes: map[string]*Runtime{
			"session": {
				SessionID:  "session",
				InstanceID: "instance",
				WorkerPid:  os.Getpid(),
				RunnerPid:  os.Getpid(),
			},
		},
	}

	if err := supervisor.Stop("session"); err == nil || !strings.Contains(err.Error(), "ps unavailable") {
		t.Fatalf("runner verification failure was ignored: %v", err)
	}
	if _, ok := supervisor.runtimes["session"]; !ok {
		t.Fatal("uncertain runner cleanup dropped runtime authority")
	}
}

func TestWorkerPIDVerifierRequiresExactEntryPath(t *testing.T) {
	dir := t.TempDir()
	entry := filepath.Join(dir, "worker.js")
	if err := os.WriteFile(entry, []byte("#!/bin/sh\nsleep 60\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	process := exec.Command(entry)
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = process.Process.Kill()
		_, _ = process.Process.Wait()
	})

	verified, err := workerPIDVerifier(entry)(process.Process.Pid)
	if err != nil || !verified {
		t.Fatalf("exact worker entry was not recognized: verified=%v err=%v", verified, err)
	}
	verified, err = workerPIDVerifier(filepath.Join(dir, "other", "worker.js"))(process.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	if verified {
		t.Fatal("same basename at another path was accepted")
	}
}

func TestStopDoesNotSignalReusedWorkerPID(t *testing.T) {
	dir := t.TempDir()
	inventory := filepath.Join(dir, "reused.json")
	if err := os.WriteFile(inventory, []byte(`{"sessionId":"reused"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	supervisor := &Supervisor{
		inventoryDir:    dir,
		stopWait:        time.Millisecond,
		confine:         &fakeConfiner{},
		verifyWorkerPID: func(int) (bool, error) { return false, nil },
		log:             slog.Default(),
		runtimes: map[string]*Runtime{
			"reused": {SessionID: "reused", InstanceID: "inst", WorkerPid: os.Getpid()},
		},
	}

	if err := supervisor.Stop("reused"); err != nil {
		t.Fatal(err)
	}
	if _, ok := supervisor.runtimes["reused"]; ok {
		t.Fatal("stale runtime entry remained after detecting pid reuse")
	}
}

func TestStopReleasesConfinement(t *testing.T) {
	confiner := &fakeConfiner{}
	supervisor := &Supervisor{
		inventoryDir: t.TempDir(),
		stopWait:     time.Millisecond,
		confine:      confiner,
		log:          slog.Default(),
		runtimes: map[string]*Runtime{
			"sess-1": {SessionID: "sess-1", InstanceID: "inst", WorkerPid: -1},
		},
	}

	if err := supervisor.Stop("sess-1"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if len(confiner.released) != 1 || confiner.released[0] != "sess-1" {
		t.Fatalf("expected release of sess-1, got %v", confiner.released)
	}
}

func TestValidInventoryRecordRequiresCompleteMatchingIdentity(t *testing.T) {
	valid := inventoryRecord{
		SessionID:   "session",
		InstanceID:  "instance",
		OwnerPid:    1,
		RunnerPid:   2,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		SocketPath:  "/tmp/session.sock",
		Fingerprint: "fingerprint",
	}
	if !validInventoryRecord("session.json", valid) {
		t.Fatal("valid inventory rejected")
	}
	for name, mutate := range map[string]func(*inventoryRecord){
		"instance":    func(record *inventoryRecord) { record.InstanceID = "" },
		"owner":       func(record *inventoryRecord) { record.OwnerPid = 0 },
		"runner":      func(record *inventoryRecord) { record.RunnerPid = -1 },
		"created":     func(record *inventoryRecord) { record.CreatedAt = "invalid" },
		"socket":      func(record *inventoryRecord) { record.SocketPath = "relative.sock" },
		"fingerprint": func(record *inventoryRecord) { record.Fingerprint = "" },
	} {
		t.Run(name, func(t *testing.T) {
			record := valid
			mutate(&record)
			if validInventoryRecord("session.json", record) {
				t.Fatal("invalid inventory accepted")
			}
		})
	}
	if validInventoryRecord("other.json", valid) {
		t.Fatal("inventory filename/session mismatch accepted")
	}
}

func TestRediscoverSkipsNonInventoryJSONByContent(t *testing.T) {
	dir := t.TempDir()
	// A foreign JSON file (e.g. a lease table) in the inventory dir must be
	// skipped by shape, not by a hard-coded filename.
	if err := os.WriteFile(filepath.Join(dir, "leases.json"), []byte(`{"instances":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	supervisor := NewSupervisor(Options{InventoryDir: dir})
	if count := supervisor.Count(); count != 0 {
		t.Fatalf("expected no rediscovered runtimes, got %d", count)
	}
}
