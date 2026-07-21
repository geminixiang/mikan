package api

import (
	"testing"

	"github.com/geminixiang/mikan/worker/internal/contract"
)

// The ensure body mirrors the TS request in src/sandbox/gondolin-contract.ts.
func TestWireContractFixtures(t *testing.T) {
	if err := contract.RoundTrip(
		contract.Fixture("ensure-runtime-request.json"),
		&ensureRuntimeRequest{},
	); err != nil {
		t.Error(err)
	}
}
