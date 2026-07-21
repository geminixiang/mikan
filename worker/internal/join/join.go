// Package join implements the worker side of the one-time-token bootstrap:
// generate a keypair locally (the private key never leaves this machine),
// present the token with a CSR over a pinned TLS connection, and persist the
// CA-signed client certificate plus a connect config.
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
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/geminixiang/mikan/worker/internal/dialhome"
)

// Config is what join writes and `connect --config` reads.
type Config struct {
	Host          string `json:"host"`
	Name          string `json:"name"`
	CertFile      string `json:"certFile"`
	KeyFile       string `json:"keyFile"`
	CAFile        string `json:"caFile"`
	MaxRuntimes   int    `json:"maxRuntimes,omitempty"`
	StateDir      string `json:"stateDir,omitempty"`
	WorkerEntry   string `json:"workerEntry,omitempty"`
	NodeBin       string `json:"nodeBin,omitempty"`
	WorkspaceRoot string `json:"workspaceRoot,omitempty"`
}

// LoadConfig reads a config written by join.
func LoadConfig(path string) (Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var config Config
	if err := json.Unmarshal(raw, &config); err != nil {
		return Config{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return config, nil
}

// Options for one join exchange.
type Options struct {
	// Address is host:port of the mikan worker gateway.
	Address string
	// ServerName for later verified connections (the gateway hostname).
	ServerName string
	Token      string
	// CAPin is "sha256:<hex>" of the gateway CA certificate DER.
	CAPin string
	Name  string
	// Dir receives client.pem, client-key.pem, ca.pem, and config.json.
	Dir    string
	Config Config
	// DialTimeout bounds the TCP+TLS dial.
	DialTimeout time.Duration
}

// Run performs the join exchange and writes the credential files.
//
// Trust bootstrap: the TLS dial skips PKI verification (the worker has no CA
// yet), then the response's CA is checked against the out-of-band pin AND the
// connection's server certificate is re-verified against that CA before
// anything is persisted — a man-in-the-middle would need a CA matching the
// pin.
func Run(options Options) error {
	if options.DialTimeout == 0 {
		options.DialTimeout = 10 * time.Second
	}
	pin, err := normalizePin(options.CAPin)
	if err != nil {
		return err
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate key: %w", err)
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: options.Name},
	}, key)
	if err != nil {
		return fmt.Errorf("create CSR: %w", err)
	}
	csrPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER})

	dialer := &net.Dialer{Timeout: options.DialTimeout}
	conn, err := tls.DialWithDialer(dialer, "tcp", options.Address, &tls.Config{
		MinVersion:         tls.VersionTLS13,
		InsecureSkipVerify: true, // verified below against the pinned CA
	})
	if err != nil {
		return fmt.Errorf("dial gateway: %w", err)
	}
	defer conn.Close()
	serverCerts := conn.ConnectionState().PeerCertificates
	if len(serverCerts) == 0 {
		return errors.New("gateway presented no certificate")
	}

	if err := dialhome.WriteFrame(conn, dialhome.Frame{
		Type:  "join",
		Token: options.Token,
		Name:  options.Name,
		CSR:   string(csrPEM),
	}); err != nil {
		return fmt.Errorf("send join request: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	response, err := dialhome.ReadFrame(conn)
	if err != nil {
		return fmt.Errorf("read join response: %w", err)
	}
	if response.Type == "join-error" {
		return fmt.Errorf("gateway refused the join: %s", response.Message)
	}
	if response.Type != "join-ok" || response.Cert == "" || response.CA == "" {
		return fmt.Errorf("unexpected join response %q", response.Type)
	}

	caCert, err := parseCertificate(response.CA)
	if err != nil {
		return fmt.Errorf("parse CA: %w", err)
	}
	fingerprint := sha256.Sum256(caCert.Raw)
	if hex.EncodeToString(fingerprint[:]) != pin {
		return fmt.Errorf(
			"CA pin mismatch: gateway CA is sha256:%s — refusing to trust it",
			hex.EncodeToString(fingerprint[:]),
		)
	}
	// The pinned CA must also vouch for the server we actually spoke to.
	roots := x509.NewCertPool()
	roots.AddCert(caCert)
	intermediates := x509.NewCertPool()
	for _, cert := range serverCerts[1:] {
		intermediates.AddCert(cert)
	}
	if _, err := serverCerts[0].Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: intermediates,
	}); err != nil {
		return fmt.Errorf("gateway certificate does not chain to the pinned CA: %w", err)
	}

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(options.Dir, 0o700); err != nil {
		return err
	}
	files := map[string][]byte{
		"client.pem":     []byte(response.Cert),
		"client-key.pem": pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}),
		"ca.pem":         []byte(response.CA),
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(options.Dir, name), content, 0o600); err != nil {
			return err
		}
	}
	config := options.Config
	config.Name = options.Name
	config.CertFile = filepath.Join(options.Dir, "client.pem")
	config.KeyFile = filepath.Join(options.Dir, "client-key.pem")
	config.CAFile = filepath.Join(options.Dir, "ca.pem")
	raw, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(options.Dir, "config.json"), append(raw, '\n'), 0o600)
}

func normalizePin(pin string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(pin))
	normalized = strings.TrimPrefix(normalized, "sha256:")
	normalized = strings.ReplaceAll(normalized, ":", "")
	if len(normalized) != 64 {
		return "", fmt.Errorf("invalid --ca-pin %q (expected sha256:<64 hex chars>)", pin)
	}
	if _, err := hex.DecodeString(normalized); err != nil {
		return "", fmt.Errorf("invalid --ca-pin %q: %w", pin, err)
	}
	return normalized, nil
}

func parseCertificate(pemData string) (*x509.Certificate, error) {
	block, _ := pem.Decode([]byte(pemData))
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("no certificate PEM block")
	}
	return x509.ParseCertificate(block.Bytes)
}
