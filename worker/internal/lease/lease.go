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

// Manager owns the lease table and its durable snapshot.
type Manager struct {
	mu     sync.Mutex
	path   string
	leases map[string]*Lease // by instance id; epochs stay monotonic per instance
	now    func() time.Time
}

type snapshot struct {
	Leases []*Lease `json:"leases"`
}

// NewManager loads (or initializes) the lease table at dir/leases.json.
func NewManager(dir string) (*Manager, error) {
	manager := &Manager{
		path:   filepath.Join(dir, "leases.json"),
		leases: make(map[string]*Lease),
		now:    time.Now,
	}
	raw, err := os.ReadFile(manager.path)
	if errors.Is(err, os.ErrNotExist) {
		return manager, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read lease table: %w", err)
	}
	var snap snapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return nil, fmt.Errorf("parse lease table %s: %w", manager.path, err)
	}
	for _, entry := range snap.Leases {
		manager.leases[entry.InstanceID] = entry
	}
	return manager, nil
}

// Acquire supersedes any existing lease for the instance and bumps its epoch.
func (m *Manager) Acquire(instanceID string, ttl time.Duration) (*Lease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var epoch uint64 = 1
	if previous, ok := m.leases[instanceID]; ok {
		epoch = previous.Epoch + 1
	}
	entry := &Lease{
		ID:         newLeaseID(),
		InstanceID: instanceID,
		Epoch:      epoch,
		ExpiresAt:  m.now().Add(ttl),
	}
	m.leases[instanceID] = entry
	if err := m.persistLocked(); err != nil {
		return nil, err
	}
	granted := *entry
	return &granted, nil
}

// Renew extends the expiry of a lease that is still the current grant.
func (m *Manager) Renew(leaseID string, ttl time.Duration) (*Lease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry := m.byIDLocked(leaseID)
	if entry == nil {
		return nil, ErrUnknownLease
	}
	if m.now().After(entry.ExpiresAt) {
		return nil, ErrExpired
	}
	entry.ExpiresAt = m.now().Add(ttl)
	if err := m.persistLocked(); err != nil {
		return nil, err
	}
	renewed := *entry
	return &renewed, nil
}

// Release drops a lease. The instance entry is kept so the epoch stays
// monotonic for the next acquisition.
func (m *Manager) Release(leaseID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry := m.byIDLocked(leaseID)
	if entry == nil {
		return ErrUnknownLease
	}
	entry.ExpiresAt = m.now()
	return m.persistLocked()
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
	if m.now().After(entry.ExpiresAt) {
		return ErrExpired
	}
	return nil
}

// Current returns the live lease for an instance, if any.
func (m *Manager) Current(instanceID string) *Lease {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.leases[instanceID]
	if !ok || m.now().After(entry.ExpiresAt) {
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
		if m.now().After(entry.ExpiresAt) {
			expired = append(expired, *entry)
		}
	}
	return expired
}

func (m *Manager) byIDLocked(leaseID string) *Lease {
	for _, entry := range m.leases {
		if entry.ID == leaseID {
			return entry
		}
	}
	return nil
}

func (m *Manager) persistLocked() error {
	snap := snapshot{Leases: make([]*Lease, 0, len(m.leases))}
	for _, entry := range m.leases {
		snap.Leases = append(snap.Leases, entry)
	}
	raw, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(m.path), 0o700); err != nil {
		return err
	}
	staged := m.path + ".tmp"
	if err := os.WriteFile(staged, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(staged, m.path)
}

func newLeaseID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		panic(err) // crypto/rand failure is not a recoverable daemon state
	}
	return hex.EncodeToString(raw)
}
