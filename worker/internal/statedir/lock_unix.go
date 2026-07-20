//go:build darwin || linux

package statedir

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// AcquireDaemonLock exclusively owns one worker state directory for this
// process. The kernel releases the advisory lock on crash or exit; the lock
// file itself may remain and is safe to reuse.
func AcquireDaemonLock(root string) (*os.File, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(root, "daemon.lock")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("worker state directory %s is already owned by another daemon: %w", root, err)
	}
	return file, nil
}
