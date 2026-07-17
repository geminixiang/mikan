package runtime

import (
	"testing"

	"github.com/geminixiang/mikan/worker/internal/contract"
)

// The supervisor's structs mirror the TS wire shapes in
// src/sandbox/gondolin-contract.ts; the shared fixtures pin both sides.
func TestWireContractFixtures(t *testing.T) {
	cases := []struct {
		fixture string
		value   any
	}{
		{"worker-config.json", &WorkerConfig{}},
		{"worker-handshake.json", &handshake{}},
		{"runtime-record.json", &inventoryRecord{}},
		{"runtime.json", &Runtime{}},
	}
	for _, entry := range cases {
		if err := contract.RoundTrip(contract.Fixture(entry.fixture), entry.value); err != nil {
			t.Error(err)
		}
	}
}
