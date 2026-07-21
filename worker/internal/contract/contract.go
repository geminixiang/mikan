// Package contract backs the per-package wire-contract tests. The JSON
// fixtures in worker/contract-fixtures pin every shape crossing the
// mikan ⇄ worker boundary; the TS side checks the same files against its
// schemas (src/sandbox/gondolin-contract.ts), so a field added on one side
// only fails one of the two suites.
package contract

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
)

// Fixture resolves a fixture name from a package two levels below worker/.
func Fixture(name string) string {
	return filepath.Join("..", "..", "contract-fixtures", name)
}

// RoundTrip unmarshals the fixture into value, marshals it back, and
// compares the two JSON object trees. A field present in the fixture but
// absent from the Go struct disappears on the way back and fails the
// comparison — exactly the silent-drop drift this exists to catch.
func RoundTrip(fixturePath string, value any) error {
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, value); err != nil {
		return fmt.Errorf("unmarshal fixture into %T: %w", value, err)
	}
	remarshaled, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var want, got map[string]any
	if err := json.Unmarshal(raw, &want); err != nil {
		return err
	}
	if err := json.Unmarshal(remarshaled, &got); err != nil {
		return err
	}
	if !reflect.DeepEqual(want, got) {
		return fmt.Errorf(
			"fixture %s does not round-trip through %T\nfixture:     %v\nround-trip:  %v",
			fixturePath, value, want, got,
		)
	}
	return nil
}
