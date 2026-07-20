//go:build darwin || linux

package statedir

import (
	"strings"
	"testing"
)

func TestDaemonLockIsExclusiveAndReleasedOnClose(t *testing.T) {
	dir := t.TempDir()
	first, err := AcquireDaemonLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := AcquireDaemonLock(dir)
	if err == nil || !strings.Contains(err.Error(), "already owned") {
		if second != nil {
			_ = second.Close()
		}
		t.Fatalf("second lock error = %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	third, err := AcquireDaemonLock(dir)
	if err != nil {
		t.Fatalf("lock was not released: %v", err)
	}
	_ = third.Close()
}
