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
	"strconv"
	"strings"
)

const cgroupRoot = "/sys/fs/cgroup"

// ErrUnsupported reports a host without cgroup v2.
var ErrUnsupported = errors.New("cgroup v2 unavailable on this host")

// Place moves pid into a fresh cgroup under mikan-worker/<name> with the
// given limits. cpus is a decimal like "0.5"; memory a size like "512m".
func Place(pid int, name string, cpus string, memory string) error {
	if runtime.GOOS != "linux" {
		return ErrUnsupported
	}
	if _, err := os.Stat(filepath.Join(cgroupRoot, "cgroup.controllers")); err != nil {
		return ErrUnsupported
	}
	dir := filepath.Join(cgroupRoot, "mikan-worker", name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create cgroup: %w", err)
	}
	if err := enableControllers(); err != nil {
		return err
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
	_ = os.Remove(filepath.Join(cgroupRoot, "mikan-worker", name))
}

func enableControllers() error {
	control := filepath.Join(cgroupRoot, "mikan-worker", "cgroup.subtree_control")
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
