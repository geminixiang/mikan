package lease

import (
	"testing"

	"github.com/geminixiang/mikan/worker/internal/contract"
)

// The lease grant mirrors the TS response in src/sandbox/gondolin-contract.ts.
func TestWireContractFixtures(t *testing.T) {
	if err := contract.RoundTrip(contract.Fixture("lease-grant.json"), &Lease{}); err != nil {
		t.Error(err)
	}
}
