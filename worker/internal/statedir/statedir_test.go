package statedir

import "testing"

func TestLayoutDerivesEveryPathFromRoot(t *testing.T) {
	layout := New("/var/lib/mikan-worker")
	if got := layout.RuntimeInventory(); got != "/var/lib/mikan-worker/gondolin-runtimes" {
		t.Fatalf("RuntimeInventory: %s", got)
	}
	if got := layout.Credentials(); got != "/var/lib/mikan-worker/credentials" {
		t.Fatalf("Credentials: %s", got)
	}
}
