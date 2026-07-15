package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildSystemdUnit(t *testing.T) {
	unit := buildSystemdUnit(
		"/opt/mikan worker/bin/mikan-worker",
		"/home/worker/config%prod.json",
		"mikan_worker",
	)

	for _, expected := range []string{
		"User=mikan_worker",
		`ExecStart="/opt/mikan worker/bin/mikan-worker" connect --config "/home/worker/config%%prod.json"`,
		"Restart=always",
		"Delegate=yes",
	} {
		if !strings.Contains(unit, expected) {
			t.Fatalf("unit does not contain %q:\n%s", expected, unit)
		}
	}
}

func TestValidServiceUser(t *testing.T) {
	for _, value := range []string{"worker", "gcp_worker-1", "user.name"} {
		if !validServiceUser(value) {
			t.Errorf("expected %q to be valid", value)
		}
	}
	for _, value := range []string{"", "root", "worker name", "worker\nExecStart=/bin/sh"} {
		if validServiceUser(value) {
			t.Errorf("expected %q to be invalid", value)
		}
	}
}

func TestValidateServiceConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	for _, name := range []string{"client.pem", "client-key.pem", "ca.pem"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("test"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	content := `{
  "host": "https://mikan.example:8433",
  "certFile": "` + filepath.Join(dir, "client.pem") + `",
  "keyFile": "` + filepath.Join(dir, "client-key.pem") + `",
  "caFile": "` + filepath.Join(dir, "ca.pem") + `"
}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateServiceConfig(path, uint32(os.Getuid())); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}

	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := validateServiceConfig(path, uint32(os.Getuid())); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("expected insecure-permissions error, got %v", err)
	}
}
