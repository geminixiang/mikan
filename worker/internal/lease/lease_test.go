package lease

import (
	"errors"
	"testing"
	"time"
)

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

	manager.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if err := manager.Validate("c1", second.ID, second.Epoch); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected expired, got %v", err)
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

	if err := manager.Release(granted.ID); err != nil {
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
