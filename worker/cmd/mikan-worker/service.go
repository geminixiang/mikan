package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/geminixiang/mikan/worker/internal/join"
)

const (
	workerServiceName = "mikan-worker.service"
	workerServicePath = "/etc/systemd/system/mikan-worker.service"
)

func runInstallService(args []string) {
	flags := flag.NewFlagSet("mikan-worker install-service", flag.ExitOnError)
	configPath := flags.String("config", "", "path to config.json created by mikan-worker join")
	serviceUser := flags.String("user", os.Getenv("SUDO_USER"), "OS user that runs the worker")
	_ = flags.Parse(args)

	if *configPath == "" {
		fmt.Fprintln(os.Stderr, "usage: sudo mikan-worker install-service --config <config.json>")
		os.Exit(1)
	}
	if err := installSystemdService(*configPath, *serviceUser); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Installed and started %s.\n", workerServiceName)
}

func installSystemdService(configPath, serviceUser string) error {
	if runtime.GOOS != "linux" {
		return errors.New("systemd service installation is only supported on Linux")
	}
	if os.Geteuid() != 0 {
		return errors.New("service installation requires root; rerun with sudo")
	}
	if !validServiceUser(serviceUser) {
		return errors.New("cannot determine the worker user; run through sudo or pass --user")
	}
	serviceUID, err := resolveServiceUID(serviceUser)
	if err != nil {
		return err
	}

	absoluteConfigPath, err := filepath.Abs(configPath)
	if err != nil {
		return fmt.Errorf("resolve config path: %w", err)
	}
	if err := validateServiceConfig(absoluteConfigPath, serviceUID); err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve mikan-worker executable: %w", err)
	}
	unit := buildSystemdUnit(executable, absoluteConfigPath, serviceUser)
	if err := writeSystemdUnit(unit); err != nil {
		return err
	}
	for _, args := range [][]string{
		{"daemon-reload"},
		{"enable", workerServiceName},
		{"restart", workerServiceName},
	} {
		if err := runSystemctl(args...); err != nil {
			return err
		}
	}
	return nil
}

func validateServiceConfig(path string, serviceUID uint32) error {
	if err := validatePrivateFile(path, serviceUID); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	config, err := join.LoadConfig(path)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	if config.Host == "" || config.CertFile == "" || config.KeyFile == "" || config.CAFile == "" {
		return errors.New("config is missing host or TLS credential paths; run mikan-worker join again")
	}
	for _, credentialPath := range []string{config.CertFile, config.KeyFile, config.CAFile} {
		if err := validatePrivateFile(credentialPath, serviceUID); err != nil {
			return fmt.Errorf("credential: %w", err)
		}
	}
	return nil
}

func resolveServiceUID(serviceUser string) (uint32, error) {
	uid := ""
	if serviceUser == os.Getenv("SUDO_USER") {
		uid = os.Getenv("SUDO_UID")
	}
	if uid == "" {
		account, err := user.Lookup(serviceUser)
		if err != nil {
			return 0, fmt.Errorf("look up service user %q: %w", serviceUser, err)
		}
		uid = account.Uid
	}
	parsed, err := strconv.ParseUint(uid, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("invalid uid %q for service user %q", uid, serviceUser)
	}
	return uint32(parsed), nil
}

func validatePrivateFile(path string, ownerUID uint32) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", path)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s must not be accessible by group or others; run chmod 600", path)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != ownerUID {
		return fmt.Errorf("%s must be owned by the worker user", path)
	}
	return nil
}

func buildSystemdUnit(executable, configPath, serviceUser string) string {
	return fmt.Sprintf(`[Unit]
Description=mikan gondolin worker
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=%s
ExecStart=%s connect --config %s
Restart=always
RestartSec=5
Delegate=yes

[Install]
WantedBy=multi-user.target
`, serviceUser, quoteSystemdArg(executable), quoteSystemdArg(configPath))
}

func quoteSystemdArg(value string) string {
	replacer := strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "%", "%%", "$", "$$")
	return `"` + replacer.Replace(value) + `"`
}

func validServiceUser(value string) bool {
	if value == "" || value == "root" {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || strings.ContainsRune("_.-", char) {
			continue
		}
		return false
	}
	return true
}

func writeSystemdUnit(content string) error {
	temp, err := os.CreateTemp(filepath.Dir(workerServicePath), ".mikan-worker.service-*")
	if err != nil {
		return fmt.Errorf("create systemd unit: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o644); err != nil {
		temp.Close()
		return fmt.Errorf("chmod systemd unit: %w", err)
	}
	if _, err := temp.WriteString(content); err != nil {
		temp.Close()
		return fmt.Errorf("write systemd unit: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close systemd unit: %w", err)
	}
	if err := os.Rename(tempPath, workerServicePath); err != nil {
		return fmt.Errorf("install systemd unit: %w", err)
	}
	return nil
}

func runSystemctl(args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "systemctl", args...).CombinedOutput()
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("systemctl %s timed out", strings.Join(args, " "))
		}
		return fmt.Errorf("systemctl %s failed: %s", strings.Join(args, " "), strings.TrimSpace(string(output)))
	}
	return nil
}
