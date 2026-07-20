package join

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/geminixiang/mikan/worker/internal/dialhome"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
	pin  string
}

func newTestCA(t *testing.T, commonName string) *testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: commonName},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	fingerprint := sha256.Sum256(der)
	return &testCA{
		cert: cert,
		key:  key,
		pem:  pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pin:  "sha256:" + hex.EncodeToString(fingerprint[:]),
	}
}

func (ca *testCA) issueServer(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "gateway"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func (ca *testCA) signCSR(t *testing.T, csrPEM string) string {
	t.Helper()
	block, _ := pem.Decode([]byte(csrPEM))
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(3),
		Subject:      csr.Subject,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.cert, csr.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

// startFakeGateway serves exactly one join exchange.
func startFakeGateway(t *testing.T, ca *testCA, serverCert tls.Certificate) string {
	t.Helper()
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{serverCert},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		frame, err := dialhome.ReadFrame(conn)
		if err != nil || frame.Type != "join" {
			return
		}
		if frame.Token != "good.token" {
			_ = dialhome.WriteFrame(conn, dialhome.Frame{Type: "join-error", Message: "invalid token"})
			return
		}
		_ = dialhome.WriteFrame(conn, dialhome.Frame{
			Type: "join-ok",
			Cert: ca.signCSR(t, frame.CSR),
			CA:   string(ca.pem),
		})
	}()
	return listener.Addr().String()
}

func TestRejectsInvalidWorkerNameBeforeDial(t *testing.T) {
	err := Run(Options{Name: "bad worker", CAPin: "sha256:" + strings.Repeat("0", 64)})
	if err == nil || !strings.Contains(err.Error(), "worker name must be") {
		t.Fatalf("invalid name error = %v", err)
	}
}

func TestRejectsExistingCredentialDirectoryBeforeDial(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(configPath, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := Run(Options{Name: "worker-1", Dir: dir, CAPin: "sha256:" + strings.Repeat("0", 64)})
	if err == nil || !strings.Contains(err.Error(), "use a new --dir") {
		t.Fatalf("existing credentials error = %v", err)
	}
}

func TestJoinWritesCredentialsAndConfig(t *testing.T) {
	ca := newTestCA(t, "mikan-worker-ca")
	address := startFakeGateway(t, ca, ca.issueServer(t))
	dir := t.TempDir()

	err := Run(Options{
		Address: address,
		Token:   "good.token",
		CAPin:   strings.ToUpper(ca.pin), // pin comparison must be case-insensitive
		Name:    "linux-1",
		Dir:     dir,
		Config:  Config{Host: "https://127.0.0.1:8433", MaxRuntimes: 4, WorkspaceRoot: "/srv/ws"},
	})
	if err != nil {
		t.Fatal(err)
	}

	config, err := LoadConfig(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if config.Name != "linux-1" || config.MaxRuntimes != 4 || config.CAFile == "" {
		t.Fatalf("unexpected config: %+v", config)
	}
	for _, name := range []string{"client.pem", "client-key.pem", "ca.pem"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s has mode %o, want 600", name, info.Mode().Perm())
		}
	}

	// the written client cert chains to the written CA and carries the name
	certPEM, _ := os.ReadFile(filepath.Join(dir, "client.pem"))
	block, _ := pem.Decode(certPEM)
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Subject.CommonName != "linux-1" {
		t.Fatalf("client cert CN = %q", cert.Subject.CommonName)
	}
}

func TestJoinRefusesWrongPin(t *testing.T) {
	ca := newTestCA(t, "mikan-worker-ca")
	address := startFakeGateway(t, ca, ca.issueServer(t))
	dir := t.TempDir()

	wrongPin := "sha256:" + strings.Repeat("ab", 32)
	err := Run(Options{Address: address, Token: "good.token", CAPin: wrongPin, Name: "x", Dir: dir})
	if err == nil || !strings.Contains(err.Error(), "pin mismatch") {
		t.Fatalf("expected pin mismatch, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "client.pem")); statErr == nil {
		t.Fatal("credentials must not be written on pin mismatch")
	}
}

func TestJoinRefusesServerNotSignedByPinnedCA(t *testing.T) {
	ca := newTestCA(t, "mikan-worker-ca")
	impostor := newTestCA(t, "impostor-ca")
	// server presents a cert from a DIFFERENT CA, but returns the pinned CA
	address := startFakeGateway(t, ca, impostor.issueServer(t))

	err := Run(Options{
		Address: address,
		Token:   "good.token",
		CAPin:   ca.pin,
		Name:    "x",
		Dir:     t.TempDir(),
	})
	if err == nil || !strings.Contains(err.Error(), "does not chain to the pinned CA") {
		t.Fatalf("expected chain verification failure, got %v", err)
	}
}

func TestJoinSurfacesGatewayRefusal(t *testing.T) {
	ca := newTestCA(t, "mikan-worker-ca")
	address := startFakeGateway(t, ca, ca.issueServer(t))

	err := Run(Options{
		Address: address,
		Token:   "bad.token",
		CAPin:   ca.pin,
		Name:    "x",
		Dir:     t.TempDir(),
	})
	if err == nil || !strings.Contains(err.Error(), "invalid token") {
		t.Fatalf("expected gateway refusal, got %v", err)
	}
}
