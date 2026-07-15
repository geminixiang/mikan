package api

import (
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkspaceProbeHealthyRoot(t *testing.T) {
	probe := NewWorkspaceProbe(t.TempDir(), time.Second, time.Minute)
	if status := probe.Status(); status != "" {
		t.Errorf("healthy root reported %q", status)
	}
}

func TestWorkspaceProbeMissingRoot(t *testing.T) {
	probe := NewWorkspaceProbe("/nonexistent/mikan-workspace", time.Second, time.Minute)
	status := probe.Status()
	if !strings.Contains(status, "/nonexistent/mikan-workspace") {
		t.Errorf("status should name the root, got %q", status)
	}
}

func TestWorkspaceProbeEmptyRootSkips(t *testing.T) {
	probe := NewWorkspaceProbe("", time.Second, time.Minute)
	if status := probe.Status(); status != "" {
		t.Errorf("no root configured should report healthy, got %q", status)
	}
	var nilProbe *WorkspaceProbe
	if status := nilProbe.Status(); status != "" {
		t.Errorf("nil probe should report healthy, got %q", status)
	}
}

func TestWorkspaceProbeReportsStuckMountWithoutPilingUp(t *testing.T) {
	release := make(chan struct{})
	var calls atomic.Int32
	probe := NewWorkspaceProbe("/mnt/dead", 20*time.Millisecond, time.Minute)
	probe.probe = func(string) error {
		calls.Add(1)
		<-release
		return nil
	}

	status := probe.Status()
	if !strings.Contains(status, "not responding") {
		t.Fatalf("hung probe should report not responding, got %q", status)
	}
	// a second caller must not start another probe against the dead mount
	if again := probe.Status(); !strings.Contains(again, "not responding") {
		t.Errorf("stuck probe should keep reporting, got %q", again)
	}
	if got := calls.Load(); got != 1 {
		t.Errorf("probe ran %d times; single-flight expected", got)
	}

	close(release) // the mount recovers
	deadline := time.Now().Add(time.Second)
	for probe.Status() != "" {
		if time.Now().After(deadline) {
			t.Fatal("probe never recovered after the mount came back")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestWorkspaceProbeCachesWithinTTL(t *testing.T) {
	var calls atomic.Int32
	probe := NewWorkspaceProbe("/mnt/ok", time.Second, time.Minute)
	probe.probe = func(string) error {
		calls.Add(1)
		return nil
	}
	current := time.Now()
	probe.now = func() time.Time { return current }

	probe.Status()
	probe.Status()
	if got := calls.Load(); got != 1 {
		t.Errorf("fresh result should be reused, probe ran %d times", got)
	}
	current = current.Add(2 * time.Minute)
	probe.Status()
	if got := calls.Load(); got != 2 {
		t.Errorf("stale result should re-probe, probe ran %d times", got)
	}
}

func TestWorkspaceProbeCachedNeverBlocks(t *testing.T) {
	release := make(chan struct{})
	failure := errors.New("stale file handle")
	probe := NewWorkspaceProbe("/mnt/nfs", time.Second, time.Nanosecond)
	probe.probe = func(string) error { return failure }

	if status := probe.Status(); !strings.Contains(status, "stale file handle") {
		t.Fatalf("expected the probe failure, got %q", status)
	}

	probe.probe = func(string) error {
		<-release
		return nil
	}
	start := time.Now()
	status := probe.Cached() // stale → kicks a refresh, but must not wait for it
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Errorf("Cached blocked for %s", elapsed)
	}
	if !strings.Contains(status, "stale file handle") {
		t.Errorf("Cached should report last known state, got %q", status)
	}
	close(release)
}
