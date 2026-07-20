// Package lease implements durable, fenced leases over conversation instance
// ids. Epochs are monotonic across daemon restarts: a partitioned client
// holding a superseded epoch is rejected even after the daemon reboots.
package lease

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	ErrUnknownLease = errors.New("unknown or superseded lease")
	ErrExpired      = errors.New("lease expired")
	ErrStaleEpoch   = errors.New("stale fencing epoch")
)

// Lease is one grant of write authority over an instance id.
type Lease struct {
	ID         string    `json:"id"`
	InstanceID string    `json:"instanceId"`
	Epoch      uint64    `json:"epoch"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

// Manager owns the lease table and its durable snapshot. Epochs are durable;
// live deadlines are deliberately process-local because JSON cannot preserve
// Go's monotonic clock reading. After restart, old grants are expired until a
// host acquires a new epoch.
type Manager struct {
	mu           sync.Mutex
	path         string
	leases       map[string]*Lease // by instance id; epochs stay monotonic per instance
	deadlines    map[string]leaseDeadline
	now          func() time.Time
	monotonicNow func() time.Time
	elapsed      func(time.Time) time.Duration
}

type leaseDeadline struct {
	startedAt time.Time
	ttl       time.Duration
}

type snapshot struct {
	Leases []*Lease `json:"leases"`
}

// NewManager loads (or initializes) the lease table at dir/leases.json.
func NewManager(dir string) (*Manager, error) {
	manager := &Manager{
		path:         filepath.Join(dir, "leases.json"),
		leases:       make(map[string]*Lease),
		deadlines:    make(map[string]leaseDeadline),
		now:          time.Now,
		monotonicNow: time.Now,
		elapsed:      time.Since,
	}
	raw, err := os.ReadFile(manager.path)
	if errors.Is(err, os.ErrNotExist) {
		if _, markerErr := os.Stat(manager.readyPath()); markerErr == nil {
			return nil, fmt.Errorf("read lease table: durable lease state is missing")
		} else if !errors.Is(markerErr, os.ErrNotExist) {
			return nil, fmt.Errorf("inspect lease ready marker: %w", markerErr)
		}
		return manager, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read lease table: %w", err)
	}
	var snap snapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return nil, fmt.Errorf("parse lease table %s: %w", manager.path, err)
	}
	leaseIDs := make(map[string]struct{}, len(snap.Leases))
	for index, entry := range snap.Leases {
		if entry == nil {
			return nil, fmt.Errorf("parse lease table %s: lease %d is null", manager.path, index)
		}
		if entry.InstanceID == "" || entry.ID == "" || entry.Epoch == 0 || entry.ExpiresAt.IsZero() {
			return nil, fmt.Errorf("parse lease table %s: lease %d has invalid identity, epoch, or expiry", manager.path, index)
		}
		if _, duplicate := manager.leases[entry.InstanceID]; duplicate {
			return nil, fmt.Errorf("parse lease table %s: duplicate instance %q", manager.path, entry.InstanceID)
		}
		if _, duplicate := leaseIDs[entry.ID]; duplicate {
			return nil, fmt.Errorf("parse lease table %s: duplicate lease id", manager.path)
		}
		leaseIDs[entry.ID] = struct{}{}
		manager.leases[entry.InstanceID] = entry
	}
	if err := ensureReadyMarker(manager.readyPath()); err != nil {
		return nil, fmt.Errorf("create lease ready marker: %w", err)
	}
	return manager, nil
}

// Acquire supersedes any existing lease for the instance and bumps its epoch.
func (m *Manager) Acquire(instanceID string, ttl time.Duration) (*Lease, error) {
	if instanceID == "" {
		return nil, errors.New("instance id is required")
	}
	if ttl <= 0 {
		return nil, errors.New("lease ttl must be positive")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	previous, hadPrevious := m.leases[instanceID]
	previousDeadline, hadPreviousDeadline := m.deadlines[instanceID]
	var epoch uint64 = 1
	if hadPrevious {
		if previous.Epoch == ^uint64(0) {
			return nil, fmt.Errorf("lease epoch exhausted for instance %q", instanceID)
		}
		epoch = previous.Epoch + 1
	}
	entry := &Lease{
		ID:         newLeaseID(),
		InstanceID: instanceID,
		Epoch:      epoch,
		ExpiresAt:  m.now().Add(ttl),
	}
	m.leases[instanceID] = entry
	m.deadlines[instanceID] = leaseDeadline{startedAt: m.monotonicNow(), ttl: ttl}
	committed, err := m.persistLocked()
	if err != nil {
		if committed {
			granted := *entry
			return &granted, fmt.Errorf("lease acquired but durable commit is uncertain: %w", err)
		}
		if hadPrevious {
			m.leases[instanceID] = previous
		} else {
			delete(m.leases, instanceID)
		}
		if hadPreviousDeadline {
			m.deadlines[instanceID] = previousDeadline
		} else {
			delete(m.deadlines, instanceID)
		}
		return nil, err
	}
	granted := *entry
	return &granted, nil
}

// Renew extends the expiry of a lease that is still the current grant.
func (m *Manager) Renew(leaseID string, ttl time.Duration) (*Lease, error) {
	if leaseID == "" {
		return nil, ErrUnknownLease
	}
	if ttl <= 0 {
		return nil, errors.New("lease ttl must be positive")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	entry := m.byIDLocked(leaseID)
	if entry == nil {
		return nil, ErrUnknownLease
	}
	if m.expiredLocked(entry) {
		return nil, ErrExpired
	}
	previousExpiry := entry.ExpiresAt
	previousDeadline := m.deadlines[entry.InstanceID]
	entry.ExpiresAt = m.now().Add(ttl)
	m.deadlines[entry.InstanceID] = leaseDeadline{startedAt: m.monotonicNow(), ttl: ttl}
	committed, err := m.persistLocked()
	if err != nil {
		if committed {
			return nil, fmt.Errorf("lease renewed but durable commit is uncertain: %w", err)
		}
		entry.ExpiresAt = previousExpiry
		m.deadlines[entry.InstanceID] = previousDeadline
		return nil, err
	}
	renewed := *entry
	return &renewed, nil
}

// Release drops a lease. The instance entry is kept so the epoch stays
// monotonic for the next acquisition. A non-nil lease with an error means the
// release was applied in memory and renamed, but directory durability is
// uncertain; callers must still fence active work for that grant.
func (m *Manager) Release(leaseID string) (*Lease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry := m.byIDLocked(leaseID)
	if entry == nil {
		return nil, ErrUnknownLease
	}
	previousExpiry := entry.ExpiresAt
	previousDeadline, hadPreviousDeadline := m.deadlines[entry.InstanceID]
	entry.ExpiresAt = m.now()
	delete(m.deadlines, entry.InstanceID)
	committed, err := m.persistLocked()
	if err != nil {
		if committed {
			released := *entry
			return &released, fmt.Errorf("lease released but durable commit is uncertain: %w", err)
		}
		entry.ExpiresAt = previousExpiry
		if hadPreviousDeadline {
			m.deadlines[entry.InstanceID] = previousDeadline
		}
		return nil, err
	}
	released := *entry
	return &released, nil
}

// Validate checks that (leaseID, epoch) is the live grant for the instance.
func (m *Manager) Validate(instanceID, leaseID string, epoch uint64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.leases[instanceID]
	if !ok || entry.ID != leaseID {
		if ok && epoch < entry.Epoch {
			return ErrStaleEpoch
		}
		return ErrUnknownLease
	}
	if epoch != entry.Epoch {
		return ErrStaleEpoch
	}
	if m.expiredLocked(entry) {
		return ErrExpired
	}
	return nil
}

// Current returns the live lease for an instance, if any.
func (m *Manager) Current(instanceID string) *Lease {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.leases[instanceID]
	if !ok || m.expiredLocked(entry) {
		return nil
	}
	current := *entry
	return &current
}

// Expired lists instances whose lease has lapsed (for runtime fencing sweeps).
func (m *Manager) Expired() []Lease {
	m.mu.Lock()
	defer m.mu.Unlock()
	var expired []Lease
	for _, entry := range m.leases {
		if m.expiredLocked(entry) {
			expired = append(expired, *entry)
		}
	}
	return expired
}

func (m *Manager) readyPath() string {
	return m.path + ".ready"
}

func (m *Manager) expiredLocked(entry *Lease) bool {
	deadline, ok := m.deadlines[entry.InstanceID]
	return !ok || m.elapsed(deadline.startedAt) >= deadline.ttl
}

func (m *Manager) byIDLocked(leaseID string) *Lease {
	for _, entry := range m.leases {
		if entry.ID == leaseID {
			return entry
		}
	}
	return nil
}

func (m *Manager) persistLocked() (bool, error) {
	snap := snapshot{Leases: make([]*Lease, 0, len(m.leases))}
	for _, entry := range m.leases {
		snap.Leases = append(snap.Leases, entry)
	}
	raw, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return false, err
	}
	dir := filepath.Dir(m.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false, err
	}
	staged := m.path + ".tmp"
	file, err := os.OpenFile(staged, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return false, err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		_ = os.Remove(staged)
		return false, err
	}
	removeStaged := true
	defer func() {
		_ = file.Close()
		if removeStaged {
			_ = os.Remove(staged)
		}
	}()
	if _, err := file.Write(append(raw, '\n')); err != nil {
		return false, err
	}
	if err := file.Sync(); err != nil {
		return false, err
	}
	if err := file.Close(); err != nil {
		return false, err
	}
	if err := os.Rename(staged, m.path); err != nil {
		return false, err
	}
	removeStaged = false
	parent, err := os.Open(dir)
	if err != nil {
		return true, err
	}
	defer parent.Close()
	if err := parent.Sync(); err != nil {
		return true, err
	}
	if err := ensureReadyMarker(m.readyPath()); err != nil {
		return true, err
	}
	return true, nil
}

func ensureReadyMarker(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	staged := path + ".tmp"
	file, err := os.OpenFile(staged, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		_ = os.Remove(staged)
		file, err = os.OpenFile(staged, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	}
	if err != nil {
		return err
	}
	removeStaged := true
	defer func() {
		_ = file.Close()
		if removeStaged {
			_ = os.Remove(staged)
		}
	}()
	if _, err := file.WriteString("ready\n"); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(staged, path); err != nil {
		return err
	}
	removeStaged = false
	parent, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

func newLeaseID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		panic(err) // crypto/rand failure is not a recoverable daemon state
	}
	return hex.EncodeToString(raw)
}
