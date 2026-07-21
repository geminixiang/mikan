package api

import (
	"fmt"
	"os"
	"sync"
	"time"
)

// WorkspaceProbe reports whether the shared workspace root is actually usable.
// A worker whose NFS mount died still registers and pings happily — only a
// filesystem operation exposes the dead mount, and on a hard mount that
// operation blocks forever in the kernel. The probe therefore runs in a
// goroutine it is prepared to abandon: callers never wait longer than the
// probe timeout, and an abandoned probe is reported as "not responding" until
// it eventually returns.
type WorkspaceProbe struct {
	root    string
	timeout time.Duration
	ttl     time.Duration

	probe func(root string) error // injectable for tests
	now   func() time.Time

	mu        sync.Mutex
	inFlight  bool
	startedAt time.Time
	hasResult bool
	lastError string
	checkedAt time.Time
}

// NewWorkspaceProbe builds a probe for root. timeout bounds how long a caller
// waits for a fresh result; ttl is how long a result is reused before the
// next call re-probes.
func NewWorkspaceProbe(root string, timeout, ttl time.Duration) *WorkspaceProbe {
	return &WorkspaceProbe{
		root:    root,
		timeout: timeout,
		ttl:     ttl,
		probe:   probeWorkspaceOnce,
		now:     time.Now,
	}
}

// Status returns "" when the workspace root is usable, or a description of
// why it is not. It waits (up to the probe timeout) for a fresh result.
func (p *WorkspaceProbe) Status() string { return p.status(true) }

// Cached is Status for hot paths (heartbeats): it returns the last known
// result immediately and refreshes in the background when stale.
func (p *WorkspaceProbe) Cached() string { return p.status(false) }

func (p *WorkspaceProbe) status(wait bool) string {
	if p == nil || p.root == "" {
		return ""
	}
	p.mu.Lock()
	if p.inFlight {
		stuck := p.now().Sub(p.startedAt) > p.timeout
		last, has, started := p.lastError, p.hasResult, p.startedAt
		p.mu.Unlock()
		if stuck || !has {
			return p.notResponding(started)
		}
		return last // a background refresh just started; report the last state
	}
	if p.hasResult && p.now().Sub(p.checkedAt) < p.ttl {
		last := p.lastError
		p.mu.Unlock()
		return last
	}
	p.inFlight = true
	p.startedAt = p.now()
	started := p.startedAt
	p.mu.Unlock()

	done := make(chan string, 1)
	go func() {
		message := ""
		if err := p.probe(p.root); err != nil {
			message = fmt.Sprintf("workspace root %s is unusable: %v", p.root, err)
		}
		p.mu.Lock()
		p.inFlight = false
		p.hasResult = true
		p.lastError = message
		p.checkedAt = p.now()
		p.mu.Unlock()
		done <- message
	}()

	if !wait {
		p.mu.Lock()
		last, has := p.lastError, p.hasResult
		p.mu.Unlock()
		if !has {
			return "" // no verdict yet; do not raise a false alarm
		}
		return last
	}
	select {
	case message := <-done:
		return message
	case <-time.After(p.timeout):
		return p.notResponding(started)
	}
}

func (p *WorkspaceProbe) notResponding(since time.Time) string {
	return fmt.Sprintf(
		"workspace root %s is not responding (probe stuck since %s; dead network mount?)",
		p.root, since.UTC().Format(time.RFC3339))
}

// probeWorkspaceOnce exercises what a runtime needs from the root: stat it,
// create a file, write, and remove it. On a dead NFS hard mount these are
// exactly the calls that hang.
func probeWorkspaceOnce(root string) error {
	if _, err := os.Stat(root); err != nil {
		return err
	}
	file, err := os.CreateTemp(root, ".mikan-workspace-probe-*")
	if err != nil {
		return err
	}
	path := file.Name()
	_, writeErr := file.WriteString("probe")
	closeErr := file.Close()
	removeErr := os.Remove(path)
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return removeErr
}
