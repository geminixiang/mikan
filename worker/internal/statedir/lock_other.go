//go:build !darwin && !linux

package statedir

import (
	"errors"
	"os"
)

func AcquireDaemonLock(_ string) (*os.File, error) {
	return nil, errors.New("mikan-worker state-directory locking is unsupported on this platform")
}
