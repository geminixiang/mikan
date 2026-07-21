package cgroup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeCgroup(t *testing.T, controllers, procs string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "cgroup.controllers"), []byte(controllers), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.procs"), []byte(procs), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}

func TestPrepareSubtreeEnablesControllersLevelByLevel(t *testing.T) {
	own := fakeCgroup(t, "cpuset cpu io memory pids", "123\n456\n")

	parent, err := prepareSubtree(own)
	if err != nil {
		t.Fatalf("prepareSubtree: %v", err)
	}
	if parent != filepath.Join(own, "mikan-worker") {
		t.Errorf("parent = %q, want <own>/mikan-worker", parent)
	}

	// worker processes were evacuated into the supervisor leaf
	leafProcs := readFile(t, filepath.Join(own, "supervisor", "cgroup.procs"))
	for _, pid := range []string{"123", "456"} {
		if !strings.Contains(leafProcs, pid) {
			t.Errorf("pid %s not moved into supervisor leaf; got %q", pid, leafProcs)
		}
	}

	// controllers were enabled on the worker's own cgroup AND the runtimes parent
	for _, dir := range []string{own, parent} {
		control := readFile(t, filepath.Join(dir, "cgroup.subtree_control"))
		if control != "+cpu +memory" {
			t.Errorf("%s/cgroup.subtree_control = %q, want \"+cpu +memory\"", dir, control)
		}
	}
}

func TestPrepareSubtreeWithoutMemberProcessesSkipsEvacuation(t *testing.T) {
	own := fakeCgroup(t, "cpu memory", "")

	if _, err := prepareSubtree(own); err != nil {
		t.Fatalf("prepareSubtree: %v", err)
	}
	if _, err := os.Stat(filepath.Join(own, "supervisor", "cgroup.procs")); err == nil {
		t.Error("no processes to evacuate, but supervisor leaf got cgroup.procs writes")
	}
}

func TestPrepareSubtreeRequiresDelegatedControllers(t *testing.T) {
	own := fakeCgroup(t, "pids", "123\n")

	_, err := prepareSubtree(own)
	if err == nil {
		t.Fatal("expected an error when cpu/memory are not delegated")
	}
	if !strings.Contains(err.Error(), "Delegate=yes") {
		t.Errorf("error should mention Delegate=yes, got: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(own, "supervisor")); statErr == nil {
		t.Error("must not evacuate processes when controllers are missing")
	}
}

func TestPrepareSubtreeAtRootKeepsRootProcesses(t *testing.T) {
	own := fakeCgroup(t, "cpu memory", "1\n")
	previous := cgroupRoot
	cgroupRoot = own
	defer func() { cgroupRoot = previous }()

	if _, err := prepareSubtree(own); err != nil {
		t.Fatalf("prepareSubtree: %v", err)
	}
	if _, err := os.Stat(filepath.Join(own, "supervisor")); err == nil {
		t.Error("root cgroup processes must not be evacuated")
	}
}

func TestParseMemory(t *testing.T) {
	cases := map[string]int64{
		"512m":    512 << 20,
		"2g":      2 << 30,
		"1024k":   1024 << 10,
		"1048576": 1048576,
	}
	for input, want := range cases {
		got, err := ParseMemory(input)
		if err != nil || got != want {
			t.Errorf("ParseMemory(%q) = %d, %v; want %d", input, got, err, want)
		}
	}
	for _, bad := range []string{"", "abc", "-1g", "0"} {
		if _, err := ParseMemory(bad); err == nil {
			t.Errorf("ParseMemory(%q) should error", bad)
		}
	}
}
