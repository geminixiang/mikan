package lease

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReadyMarkerPreventsSilentEpochResetAfterStateLoss(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Acquire("c1", time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "leases.json.ready")); err != nil {
		t.Fatalf("ready marker missing: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, "leases.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := NewManager(dir); err == nil || !strings.Contains(err.Error(), "state is missing") {
		t.Fatalf("missing durable lease table was reset: %v", err)
	}
}

func TestEpochsAreMonotonicAcrossReload(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.Acquire("c1", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if first.Epoch != 1 {
		t.Fatalf("expected epoch 1, got %d", first.Epoch)
	}
	second, _ := manager.Acquire("c1", time.Minute)
	if second.Epoch != 2 {
		t.Fatalf("expected epoch 2, got %d", second.Epoch)
	}

	reloaded, err := NewManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	third, _ := reloaded.Acquire("c1", time.Minute)
	if third.Epoch != 3 {
		t.Fatalf("expected epoch 3 after reload, got %d", third.Epoch)
	}
}

func TestReloadRejectsSemanticallyCorruptLeaseTable(t *testing.T) {
	for name, body := range map[string]string{
		"null":         `{"leases":[null]}`,
		"empty-id":     `{"leases":[{"id":"","instanceId":"c1","epoch":1,"expiresAt":"2030-01-01T00:00:00Z"}]}`,
		"zero-epoch":   `{"leases":[{"id":"id","instanceId":"c1","epoch":0,"expiresAt":"2030-01-01T00:00:00Z"}]}`,
		"duplicate":    `{"leases":[{"id":"one","instanceId":"c1","epoch":1,"expiresAt":"2030-01-01T00:00:00Z"},{"id":"two","instanceId":"c1","epoch":2,"expiresAt":"2030-01-01T00:00:00Z"}]}`,
		"duplicate-id": `{"leases":[{"id":"same","instanceId":"c1","epoch":1,"expiresAt":"2030-01-01T00:00:00Z"},{"id":"same","instanceId":"c2","epoch":1,"expiresAt":"2030-01-01T00:00:00Z"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "leases.json"), []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := NewManager(dir); err == nil {
				t.Fatal("semantically corrupt lease table was accepted")
			}
		})
	}
}

func TestAcquireRejectsEpochOverflow(t *testing.T) {
	dir := t.TempDir()
	body := fmt.Sprintf(
		`{"leases":[{"id":"old","instanceId":"c1","epoch":%d,"expiresAt":"2030-01-01T00:00:00Z"}]}`,
		^uint64(0),
	)
	if err := os.WriteFile(filepath.Join(dir, "leases.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Acquire("c1", time.Minute); err == nil {
		t.Fatal("epoch wrapped around")
	}
}

func TestRejectsInvalidAcquireAndRenewInputs(t *testing.T) {
	manager, _ := NewManager(t.TempDir())
	if _, err := manager.Acquire("", time.Minute); err == nil {
		t.Fatal("empty instance id was accepted")
	}
	if _, err := manager.Acquire("c1", 0); err == nil {
		t.Fatal("non-positive acquire ttl was accepted")
	}
	granted, err := manager.Acquire("c1", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Renew(granted.ID, -time.Second); err == nil {
		t.Fatal("non-positive renew ttl was accepted")
	}
}

func TestValidateRejectsStaleEpochAndExpiry(t *testing.T) {
	manager, _ := NewManager(t.TempDir())
	first, _ := manager.Acquire("c1", time.Minute)
	second, _ := manager.Acquire("c1", time.Minute)

	if err := manager.Validate("c1", second.ID, second.Epoch); err != nil {
		t.Fatalf("current lease should validate: %v", err)
	}
	if err := manager.Validate("c1", first.ID, first.Epoch); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("expected stale epoch, got %v", err)
	}
	if err := manager.Validate("c1", second.ID, second.Epoch+5); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("expected stale epoch for wrong epoch, got %v", err)
	}

	manager.elapsed = func(time.Time) time.Duration { return 2 * time.Minute }
	if err := manager.Validate("c1", second.ID, second.Epoch); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected expired, got %v", err)
	}
}

func TestReloadExpiresOldGrantButPreservesEpoch(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	granted, err := manager.Acquire("c1", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	reloaded, err := NewManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := reloaded.Validate("c1", granted.ID, granted.Epoch); !errors.Is(err, ErrExpired) {
		t.Fatalf("reloaded wall-clock grant remained live: %v", err)
	}
	next, err := reloaded.Acquire("c1", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if next.Epoch != granted.Epoch+1 {
		t.Fatalf("restart lost fencing epoch: got %d", next.Epoch)
	}
}

func TestWallClockRollbackDoesNotExtendLiveGrant(t *testing.T) {
	manager, _ := NewManager(t.TempDir())
	wall := time.Now()
	manager.now = func() time.Time { return wall }
	granted, err := manager.Acquire("c1", time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	wall = wall.Add(-24 * time.Hour)
	manager.elapsed = func(time.Time) time.Duration { return 2 * time.Minute }
	if err := manager.Validate("c1", granted.ID, granted.Epoch); !errors.Is(err, ErrExpired) {
		t.Fatalf("wall-clock rollback extended lease: %v", err)
	}
}

func TestRenewAndRelease(t *testing.T) {
	manager, _ := NewManager(t.TempDir())
	granted, _ := manager.Acquire("c1", time.Minute)

	renewed, err := manager.Renew(granted.ID, 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !renewed.ExpiresAt.After(granted.ExpiresAt) {
		t.Fatal("renew should extend expiry")
	}
	if _, err := manager.Renew("nope", time.Minute); !errors.Is(err, ErrUnknownLease) {
		t.Fatalf("expected unknown lease, got %v", err)
	}

	if _, err := manager.Release(granted.ID); err != nil {
		t.Fatal(err)
	}
	if err := manager.Validate("c1", granted.ID, granted.Epoch); !errors.Is(err, ErrExpired) {
		t.Fatalf("released lease should be expired, got %v", err)
	}
	if lease := manager.Current("c1"); lease != nil {
		t.Fatal("released lease should not be current")
	}

	next, _ := manager.Acquire("c1", time.Minute)
	if next.Epoch != granted.Epoch+1 {
		t.Fatalf("release must not reset epochs: got %d", next.Epoch)
	}
}

func TestPersistenceFailureRollsBackLeaseMutation(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	granted, err := manager.Acquire("c1", time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	// Replace the state directory with a plain file so staged writes fail.
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir, []byte("blocked"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := manager.Renew(granted.ID, 2*time.Minute); err == nil {
		t.Fatal("renew unexpectedly succeeded")
	}
	current := manager.Current("c1")
	if current == nil || !current.ExpiresAt.Equal(granted.ExpiresAt) {
		t.Fatalf("failed renew changed in-memory lease: %+v", current)
	}
	if _, err := manager.Release(granted.ID); err == nil {
		t.Fatal("release unexpectedly succeeded")
	}
	if current := manager.Current("c1"); current == nil {
		t.Fatal("failed release expired the in-memory lease")
	}
	if _, err := manager.Acquire("c2", time.Minute); err == nil {
		t.Fatal("acquire unexpectedly succeeded")
	}
	if current := manager.Current("c2"); current != nil {
		t.Fatalf("failed acquire leaked an in-memory lease: %+v", current)
	}
}

func TestExpiredListsLapsedInstances(t *testing.T) {
	manager, _ := NewManager(t.TempDir())
	_, _ = manager.Acquire("gone", 10*time.Millisecond)
	_, _ = manager.Acquire("live", time.Minute)
	time.Sleep(20 * time.Millisecond)

	expired := manager.Expired()
	if len(expired) != 1 || expired[0].InstanceID != "gone" {
		t.Fatalf("expected only 'gone' expired, got %+v", expired)
	}
}
