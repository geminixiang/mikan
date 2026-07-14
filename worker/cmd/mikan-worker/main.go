// mikan-worker hosts Gondolin runtimes for a remote mikan over mutual TLS.
package main

import (
	"crypto/tls"
	"crypto/x509"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/geminixiang/mikan/worker/internal/api"
	"github.com/geminixiang/mikan/worker/internal/cgroup"
	"github.com/geminixiang/mikan/worker/internal/lease"
	workerruntime "github.com/geminixiang/mikan/worker/internal/runtime"
)

func main() {
	listen := flag.String("listen", ":8433", "address to serve mTLS on")
	certFile := flag.String("cert", "", "server certificate (PEM)")
	keyFile := flag.String("key", "", "server private key (PEM)")
	clientCAFile := flag.String("client-ca", "", "CA bundle that signs allowed client certificates (PEM)")
	stateDir := flag.String("state-dir", "/var/lib/mikan-worker", "durable daemon state (leases, runtime inventory)")
	workerEntry := flag.String("worker-entry", "", "path to mikan's dist/sandbox/gondolin-worker-main.js")
	nodeBin := flag.String("node", "node", "node binary used to run gondolin workers")
	workspaceRoot := flag.String("workspace-root", "", "restrict mount sources to this shared workspace root")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if *certFile == "" || *keyFile == "" || *clientCAFile == "" {
		fatal(logger, "cert, key, and client-ca are required")
	}
	if *workerEntry == "" {
		fatal(logger, "worker-entry is required")
	}

	inventoryDir := filepath.Join(*stateDir, "gondolin-runtimes")
	if err := os.MkdirAll(inventoryDir, 0o700); err != nil {
		fatal(logger, fmt.Sprintf("create state dir: %v", err))
	}
	leases, err := lease.NewManager(*stateDir)
	if err != nil {
		fatal(logger, err.Error())
	}
	supervisor := workerruntime.NewSupervisor(workerruntime.Options{
		NodeBin:      *nodeBin,
		WorkerEntry:  *workerEntry,
		InventoryDir: inventoryDir,
		Place: func(pid int, sessionID string, cpus string, memory string) error {
			err := cgroup.Place(pid, sessionID, cpus, memory)
			if err == cgroup.ErrUnsupported {
				return nil
			}
			return err
		},
		Log: logger,
	})

	server := &api.Server{
		Leases:        leases,
		Runtimes:      supervisor,
		WorkspaceRoot: *workspaceRoot,
		InventoryDir:  inventoryDir,
		Log:           logger,
	}
	stop := make(chan struct{})
	go server.Janitor(15*time.Second, stop)

	clientCAs := x509.NewCertPool()
	caPEM, err := os.ReadFile(*clientCAFile)
	if err != nil {
		fatal(logger, fmt.Sprintf("read client CA: %v", err))
	}
	if !clientCAs.AppendCertsFromPEM(caPEM) {
		fatal(logger, "client CA bundle contains no certificates")
	}

	httpServer := &http.Server{
		Addr:              *listen,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS13,
			ClientAuth: tls.RequireAndVerifyClientCert,
			ClientCAs:  clientCAs,
			// The session tunnel hijacks connections, which requires HTTP/1.1.
			NextProtos: []string{"http/1.1"},
		},
	}
	logger.Info("mikan-worker listening", "addr", *listen, "inventoryDir", inventoryDir)
	if err := httpServer.ListenAndServeTLS(*certFile, *keyFile); err != nil {
		fatal(logger, err.Error())
	}
}

func fatal(logger *slog.Logger, message string) {
	logger.Error(message)
	os.Exit(1)
}
