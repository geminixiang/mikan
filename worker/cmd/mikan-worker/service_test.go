package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func issueTestCertificate(t *testing.T, ca *x509.Certificate, caKey *ecdsa.PrivateKey, cn string, usages []x509.ExtKeyUsage) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		ExtKeyUsage:  usages,
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}),
	)
	if err != nil {
		t.Fatal(err)
	}
	return certificate
}

func testCertificateAuthority(t *testing.T) (*x509.Certificate, *ecdsa.PrivateKey, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test-ca"},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(certificate)
	return certificate, key, pool
}

func staticTLSHandshake(t *testing.T, clientCN string) (error, error) {
	t.Helper()
	ca, caKey, pool := testCertificateAuthority(t)
	serverCertificate := issueTestCertificate(t, ca, caKey, "worker", []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth})
	clientCertificate := issueTestCertificate(t, ca, caKey, clientCN, []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serverConfig := newStaticServerTLSConfig(pool, "mikan-host")
	serverConfig.Certificates = []tls.Certificate{serverCertificate}
	serverResult := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverResult <- acceptErr
			return
		}
		server := tls.Server(connection, serverConfig)
		handshakeErr := server.Handshake()
		_ = server.Close()
		serverResult <- handshakeErr
	}()
	client, err := tls.Dial("tcp", listener.Addr().String(), &tls.Config{
		MinVersion:         tls.VersionTLS13,
		Certificates:       []tls.Certificate{clientCertificate},
		InsecureSkipVerify: true, // this test isolates server-side client authorization
	})
	clientErr := err
	if client != nil {
		_ = client.Close()
	}
	serverErr := <-serverResult
	_ = listener.Close()
	return serverErr, clientErr
}

func TestStaticServerTLSHandshakeAuthorizesOnlyConfiguredClientCN(t *testing.T) {
	serverErr, clientErr := staticTLSHandshake(t, "mikan-host")
	if serverErr != nil || clientErr != nil {
		t.Fatalf("authorized host handshake failed: server=%v client=%v", serverErr, clientErr)
	}

	serverErr, _ = staticTLSHandshake(t, "enrolled-worker")
	if serverErr == nil || !strings.Contains(serverErr.Error(), "not authorized") {
		t.Fatalf("worker membership certificate accepted: %v", serverErr)
	}
}

func TestStaticServerTLSConfigAuthorizesOnlyConfiguredClientCN(t *testing.T) {
	config := newStaticServerTLSConfig(x509.NewCertPool(), "mikan-host")
	if config.MinVersion != tls.VersionTLS13 || config.ClientAuth != tls.RequireAndVerifyClientCert {
		t.Fatal("static TLS config does not require TLS 1.3 verified client certificates")
	}
	state := tls.ConnectionState{VerifiedChains: [][]*x509.Certificate{{{
		Subject: pkix.Name{CommonName: "mikan-host"},
	}}}}
	if err := config.VerifyConnection(state); err != nil {
		t.Fatalf("authorized CN rejected: %v", err)
	}
	state.VerifiedChains[0][0].Subject.CommonName = "enrolled-worker"
	if err := config.VerifyConnection(state); err == nil || !strings.Contains(err.Error(), "not authorized") {
		t.Fatalf("unexpected CN accepted: %v", err)
	}
	if err := config.VerifyConnection(tls.ConnectionState{}); err == nil {
		t.Fatal("missing verified chain accepted")
	}
}

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
