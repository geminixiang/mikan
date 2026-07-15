// Package cgroup confines runtime process trees with cgroup v2 on Linux.
// Fractional CPU quotas apply here what the VM's whole-vCPU count cannot
// express. Everything is best-effort: a worker without cgroup v2 (or a
// non-Linux host) still runs, it just loses strict enforcement.
package cgroup

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
)

var (
	cgroupRoot     = "/sys/fs/cgroup"
	procSelfCgroup = "/proc/self/cgroup"
)

// ErrUnsupported reports a host without cgroup v2 (or no delegated cgroup).
var ErrUnsupported = errors.New("cgroup v2 unavailable or not delegated to this process")

// base returns <own-cgroup>/mikan-worker ready to host runtime cgroups.
// Runtime cgroups are created BELOW the worker's own cgroup, not at the
// cgroup root, so an unprivileged worker started with systemd `Delegate=yes`
// can manage its own subtree. Falls back to the root only when privileged.
func base() (string, error) {
	if runtime.GOOS != "linux" {
		return "", ErrUnsupported
	}
	if _, err := os.Stat(filepath.Join(cgroupRoot, "cgroup.controllers")); err != nil {
		return "", ErrUnsupported
	}
	own, err := ownCgroup()
	if err != nil {
		return "", err
	}
	return prepareSubtree(own)
}

func ownCgroup() (string, error) {
	raw, err := os.ReadFile(procSelfCgroup)
	if err != nil {
		return "", ErrUnsupported
	}
	// cgroup v2 line is "0::/system.slice/mikan-worker.service"
	relative := ""
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if rest, ok := strings.CutPrefix(line, "0::"); ok {
			relative = rest
			break
		}
	}
	return filepath.Join(cgroupRoot, relative), nil
}

// prepareSubtree makes <own>/mikan-worker able to host runtime cgroups with
// cpu/memory limits. cgroup v2 imposes two constraints here: controllers
// must be enabled level by level from the delegated cgroup down, and a
// non-root cgroup with member processes cannot delegate domain controllers
// (the "no internal process" rule) — so the worker's own processes are first
// evacuated into a <own>/supervisor leaf.
func prepareSubtree(own string) (string, error) {
	if err := requireControllers(own); err != nil {
		return "", err
	}
	if own != cgroupRoot { // the root cgroup may keep its own processes
		if err := evacuateProcesses(own); err != nil {
			return "", err
		}
	}
	if err := enableControllers(own); err != nil {
		return "", err
	}
	parent := filepath.Join(own, "mikan-worker")
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", ErrUnsupported
	}
	if err := enableControllers(parent); err != nil {
		return "", err
	}
	return parent, nil
}

// requireControllers fails early — with an actionable message — when cpu or
// memory never made it into the worker's cgroup. Without this, the failure
// surfaces later as a bare ENOENT on cgroup.subtree_control.
func requireControllers(own string) error {
	raw, err := os.ReadFile(filepath.Join(own, "cgroup.controllers"))
	if err != nil {
		return ErrUnsupported
	}
	available := strings.Fields(string(raw))
	for _, controller := range []string{"cpu", "memory"} {
		if !slices.Contains(available, controller) {
			return fmt.Errorf(
				"%s controller not delegated to %s (available: %q); run the systemd service (Delegate=yes) or a privileged worker",
				controller, own, strings.TrimSpace(string(raw)))
		}
	}
	return nil
}

// evacuateProcesses moves every process directly in own into a leaf child,
// satisfying the no-internal-process rule before controllers are delegated.
// Children spawned afterwards inherit the leaf, so this converges.
func evacuateProcesses(own string) error {
	leaf := filepath.Join(own, "supervisor")
	if err := os.MkdirAll(leaf, 0o755); err != nil {
		return fmt.Errorf("create supervisor leaf cgroup: %w", err)
	}
	target := filepath.Join(leaf, "cgroup.procs")
	for attempt := 0; attempt < 5; attempt++ {
		raw, err := os.ReadFile(filepath.Join(own, "cgroup.procs"))
		if err != nil {
			return fmt.Errorf("read cgroup.procs: %w", err)
		}
		pids := strings.Fields(string(raw))
		if len(pids) == 0 {
			return nil
		}
		for _, pid := range pids {
			_ = writePid(target, pid) // a pid may exit between read and write
		}
	}
	return nil // stragglers surface as EBUSY on cgroup.subtree_control
}

func writePid(path, pid string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString(pid)
	return err
}

// Place moves pid into a fresh cgroup under <own-cgroup>/mikan-worker/<name>
// with the given limits. cpus is a decimal like "0.5"; memory a size like "512m".
func Place(pid int, name string, cpus string, memory string) error {
	root, err := base()
	if err != nil {
		return err
	}
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create cgroup: %w", err)
	}
	if cpus != "" {
		if err := writeCPUMax(dir, cpus); err != nil {
			return err
		}
	}
	if memory != "" {
		limit, err := ParseMemory(memory)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, "memory.max"), []byte(strconv.FormatInt(limit, 10)), 0o644); err != nil {
			return fmt.Errorf("set memory.max: %w", err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.procs"), []byte(strconv.Itoa(pid)), 0o644); err != nil {
		return fmt.Errorf("move pid into cgroup: %w", err)
	}
	return nil
}

// Remove deletes the runtime's cgroup once its processes are gone.
func Remove(name string) {
	root, err := base()
	if err != nil {
		return
	}
	_ = os.Remove(filepath.Join(root, name))
}

func enableControllers(dir string) error {
	control := filepath.Join(dir, "cgroup.subtree_control")
	if err := os.WriteFile(control, []byte("+cpu +memory"), 0o644); err != nil {
		return fmt.Errorf("enable cpu/memory controllers: %w", err)
	}
	return nil
}

func writeCPUMax(dir string, cpus string) error {
	fraction, err := strconv.ParseFloat(cpus, 64)
	if err != nil || fraction <= 0 {
		return fmt.Errorf("invalid cpu limit %q", cpus)
	}
	const period = 100000
	quota := int64(fraction * period)
	value := fmt.Sprintf("%d %d", quota, period)
	if err := os.WriteFile(filepath.Join(dir, "cpu.max"), []byte(value), 0o644); err != nil {
		return fmt.Errorf("set cpu.max: %w", err)
	}
	return nil
}

// ParseMemory converts docker-style sizes ("512m", "2g", "1048576") to bytes.
func ParseMemory(value string) (int64, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	multiplier := int64(1)
	switch {
	case strings.HasSuffix(normalized, "k"):
		multiplier, normalized = 1<<10, strings.TrimSuffix(normalized, "k")
	case strings.HasSuffix(normalized, "m"):
		multiplier, normalized = 1<<20, strings.TrimSuffix(normalized, "m")
	case strings.HasSuffix(normalized, "g"):
		multiplier, normalized = 1<<30, strings.TrimSuffix(normalized, "g")
	}
	amount, err := strconv.ParseInt(normalized, 10, 64)
	if err != nil || amount <= 0 {
		return 0, fmt.Errorf("invalid memory limit %q", value)
	}
	return amount * multiplier, nil
}
