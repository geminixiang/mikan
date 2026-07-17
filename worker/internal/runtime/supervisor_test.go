package runtime

import (
	"log/slog"
	"os"
	"path/filepath"
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
