// Package statedir owns the layout of the worker's durable state directory.
// Every sibling under the state dir is named here, once — packages receive
// concrete paths instead of composing them inline or walking parent
// directories to rediscover the root.
package statedir

import "path/filepath"

// Layout derives every path under one worker state dir.
type Layout struct {
	// Root is the durable daemon state directory. The lease table
	// (lease.NewManager) lives directly in it.
	Root string
}

// New builds the layout for a state-dir root.
func New(root string) Layout { return Layout{Root: root} }

// RuntimeInventory is the directory of per-runtime inventory records.
func (l Layout) RuntimeInventory() string { return filepath.Join(l.Root, "gondolin-runtimes") }

// Credentials is where shipped vault credentials land: beside the runtime
// inventory, never inside the workspace.
func (l Layout) Credentials() string { return filepath.Join(l.Root, "credentials") }
