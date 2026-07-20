// mikan-worker hosts Gondolin runtimes for a remote mikan over mutual TLS.
//
// Two modes share one protocol implementation:
//
//	mikan-worker [flags]          — listen mode: serve mTLS, mikan dials in
//	mikan-worker connect [flags]  — dial-home mode: connect out to mikan's
//	                                worker gateway (NAT-friendly)
package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/geminixiang/mikan/worker/internal/api"
	"github.com/geminixiang/mikan/worker/internal/cgroup"
	"github.com/geminixiang/mikan/worker/internal/dialhome"
	"github.com/geminixiang/mikan/worker/internal/join"
	"github.com/geminixiang/mikan/worker/internal/lease"
	workerruntime "github.com/geminixiang/mikan/worker/internal/runtime"
	"github.com/geminixiang/mikan/worker/internal/statedir"
)

// cgroupConfiner adapts the cgroup package to the supervisor's Confiner
// seam: placement on hosts without cgroup v2 degrades to unconfined, and
// stopping a runtime reclaims its cgroup directory.
type cgroupConfiner struct{}

func (cgroupConfiner) Place(pid int, sessionID string, cpus string, memory string) error {
	err := cgroup.Place(pid, sessionID, cpus, memory)
	if err == cgroup.ErrUnsupported {
		return nil
	}
	return err
}

func (cgroupConfiner) Release(sessionID string) { cgroup.Remove(sessionID) }

// version is stamped by the release build via -ldflags "-X main.version=…".
var version = "dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "connect":
			runConnect(os.Args[2:])
			return
		case "join":
			runJoin(os.Args[2:])
			return
		case "install-service":
			runInstallService(os.Args[2:])
			return
		case "version", "--version", "-v":
			fmt.Println(version)
			return
		}
	}
	runServe(os.Args[1:])
}

// daemonFlags are shared between both modes.
type daemonFlags struct {
	stateDir      *string
	workerEntry   *string
	nodeBin       *string
	workspaceRoot *string
}

func addDaemonFlags(flags *flag.FlagSet) daemonFlags {
	return daemonFlags{
		stateDir:      flags.String("state-dir", "/var/lib/mikan-worker", "durable daemon state (leases, runtime inventory)"),
		workerEntry:   flags.String("worker-entry", "", "path to mikan's dist/sandbox/gondolin-worker-main.js"),
		nodeBin:       flags.String("node", "node", "node binary used to run gondolin workers"),
		workspaceRoot: flags.String("workspace-root", "", "restrict mount sources to this shared workspace root"),
	}
}

// buildDaemon assembles the supervisor + lease manager + protocol server both
// modes serve, and starts the janitor.
func buildDaemon(flags daemonFlags, logger *slog.Logger) *api.Server {
	if *flags.workerEntry == "" {
		fatal(logger, "worker-entry is required")
	}
	state := statedir.New(*flags.stateDir)
	if err := os.MkdirAll(state.RuntimeInventory(), 0o700); err != nil {
		fatal(logger, fmt.Sprintf("create state dir: %v", err))
	}
	stateLock, err := statedir.AcquireDaemonLock(state.Root)
	if err != nil {
		fatal(logger, err.Error())
	}
	leases, err := lease.NewManager(state.Root)
	if err != nil {
		fatal(logger, err.Error())
	}
	supervisor := workerruntime.NewSupervisor(workerruntime.Options{
		NodeBin:      *flags.nodeBin,
		WorkerEntry:  *flags.workerEntry,
		InventoryDir: state.RuntimeInventory(),
		Confine:      cgroupConfiner{},
		Log:          logger,
	})
	server := &api.Server{
		Leases:         leases,
		Runtimes:       supervisor,
		WorkspaceRoot:  *flags.workspaceRoot,
		InventoryDir:   state.RuntimeInventory(),
		CredentialsDir: state.Credentials(),
		Workspace:      api.NewWorkspaceProbe(*flags.workspaceRoot, 2*time.Second, time.Minute),
		Log:            logger,
		StateLock:      stateLock,
	}
	server.RequireHostActivityHeartbeat()
	stop := make(chan struct{})
	go server.Janitor(15*time.Second, stop)
	return server
}

func runServe(args []string) {
	flags := flag.NewFlagSet("mikan-worker", flag.ExitOnError)
	listen := flags.String("listen", ":8433", "address to serve mTLS on")
	certFile := flags.String("cert", "", "server certificate (PEM)")
	keyFile := flags.String("key", "", "server private key (PEM)")
	clientCAFile := flags.String("client-ca", "", "CA bundle that signs allowed client certificates (PEM)")
	clientCN := flags.String("client-cn", "", "required Common Name of the authorized mikan host certificate")
	daemon := addDaemonFlags(flags)
	_ = flags.Parse(args)

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if *certFile == "" || *keyFile == "" || *clientCAFile == "" || *clientCN == "" {
		fatal(logger, "cert, key, client-ca, and client-cn are required")
	}
	server := buildDaemon(daemon, logger)

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
		TLSConfig:         newStaticServerTLSConfig(clientCAs, *clientCN),
	}
	logger.Info("mikan-worker listening", "addr", *listen, "inventoryDir", server.InventoryDir)
	if err := httpServer.ListenAndServeTLS(*certFile, *keyFile); err != nil {
		fatal(logger, err.Error())
	}
}

func newStaticServerTLSConfig(clientCAs *x509.CertPool, clientCN string) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS13,
		ClientAuth: tls.RequireAndVerifyClientCert,
		ClientCAs:  clientCAs,
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.VerifiedChains) == 0 || len(state.VerifiedChains[0]) == 0 {
				return errors.New("verified client certificate is missing")
			}
			actual := state.VerifiedChains[0][0].Subject.CommonName
			if actual != clientCN {
				return fmt.Errorf("client certificate CN %q is not authorized", actual)
			}
			return nil
		},
		// The session tunnel hijacks connections, which requires HTTP/1.1.
		NextProtos: []string{"http/1.1"},
	}
}

// gatewayAddress resolves a gateway URL into host:port and the TLS ServerName.
func gatewayAddress(logger *slog.Logger, raw string) (string, string) {
	gateway, err := url.Parse(raw)
	if err != nil || gateway.Hostname() == "" {
		fatal(logger, fmt.Sprintf("invalid gateway URL %q", raw))
	}
	port := gateway.Port()
	if port == "" {
		port = "8433"
	}
	return net.JoinHostPort(gateway.Hostname(), port), gateway.Hostname()
}

func runJoin(args []string) {
	flags := flag.NewFlagSet("mikan-worker join", flag.ExitOnError)
	token := flags.String("token", "", "one-time join token from `mikan --worker-token`")
	caPin := flags.String("ca-pin", "", "expected gateway CA fingerprint (sha256:…)")
	name := flags.String("name", defaultWorkerName(), "stable worker name (placement identity)")
	dir := flags.String("dir", defaultWorkerDir(), "directory for credentials and config.json")
	maxRuntimes := flags.Int("max-runtimes", runtime.NumCPU(), "advertised admission cap for new placements")
	daemon := addDaemonFlags(flags)
	// support `join <url> --flags`: stdlib flag stops at the first positional
	var host string
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		host = args[0]
		args = args[1:]
	}
	_ = flags.Parse(args)
	if host == "" {
		host = flags.Arg(0)
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if host == "" || *token == "" || *caPin == "" {
		fatal(logger, "usage: mikan-worker join https://mikan:8433 --token <t> --ca-pin sha256:<hex> [flags]")
	}
	absoluteDir, err := filepath.Abs(*dir)
	if err != nil {
		fatal(logger, fmt.Sprintf("resolve credential directory: %v", err))
	}
	address, serverName := gatewayAddress(logger, host)

	err = join.Run(join.Options{
		Address:    address,
		ServerName: serverName,
		Token:      *token,
		CAPin:      *caPin,
		Name:       *name,
		Dir:        absoluteDir,
		Config: join.Config{
			Host:          host,
			MaxRuntimes:   *maxRuntimes,
			StateDir:      *daemon.stateDir,
			WorkerEntry:   *daemon.workerEntry,
			NodeBin:       *daemon.nodeBin,
			WorkspaceRoot: *daemon.workspaceRoot,
		},
	})
	if err != nil {
		fatal(logger, err.Error())
	}
	configPath := filepath.Join(absoluteDir, "config.json")
	fmt.Printf("Joined %s as %q. Credentials written to %s\n\n", host, *name, absoluteDir)
	fmt.Printf("Install and start the worker as a persistent systemd service:\n")
	fmt.Printf("  sudo %s install-service --config %s\n\n", executablePath(), configPath)
	fmt.Printf("Or run it in the foreground:\n  mikan-worker connect --config %s\n", configPath)
}

func runConnect(args []string) {
	flags := flag.NewFlagSet("mikan-worker connect", flag.ExitOnError)
	configPath := flags.String("config", "", "path to config.json created by mikan-worker join")
	host := flags.String("host", "", "mikan worker gateway URL, e.g. https://mikan.internal:8433")
	name := flags.String("name", "", "stable worker name (placement identity)")
	certFile := flags.String("cert", "", "client certificate presented to the gateway (PEM)")
	keyFile := flags.String("key", "", "client private key (PEM)")
	caFile := flags.String("ca", "", "CA bundle that signs the gateway's server certificate (PEM)")
	maxRuntimes := flags.Int("max-runtimes", 0, "advertised admission cap for new placements")
	daemon := addDaemonFlags(flags)
	_ = flags.Parse(args)

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if *configPath != "" {
		config, err := join.LoadConfig(*configPath)
		if err != nil {
			fatal(logger, fmt.Sprintf("load config: %v", err))
		}
		// flags explicitly set on the command line override the config file
		applyIfUnset(flags, "host", host, config.Host)
		applyIfUnset(flags, "name", name, config.Name)
		applyIfUnset(flags, "cert", certFile, config.CertFile)
		applyIfUnset(flags, "key", keyFile, config.KeyFile)
		applyIfUnset(flags, "ca", caFile, config.CAFile)
		if !wasSet(flags, "max-runtimes") && config.MaxRuntimes > 0 {
			*maxRuntimes = config.MaxRuntimes
		}
		applyIfUnset(flags, "state-dir", daemon.stateDir, config.StateDir)
		applyIfUnset(flags, "worker-entry", daemon.workerEntry, config.WorkerEntry)
		applyIfUnset(flags, "node", daemon.nodeBin, config.NodeBin)
		applyIfUnset(flags, "workspace-root", daemon.workspaceRoot, config.WorkspaceRoot)
	}
	if *name == "" {
		*name = defaultWorkerName()
	}
	if !join.ValidWorkerName(*name) {
		fatal(logger, "worker name must be 1-128 letters, numbers, dots, underscores, or hyphens")
	}
	if *maxRuntimes <= 0 {
		*maxRuntimes = runtime.NumCPU()
	}
	if *host == "" || *certFile == "" || *keyFile == "" || *caFile == "" {
		fatal(logger, "host, cert, key, and ca are required (or pass --config)")
	}
	address, serverName := gatewayAddress(logger, *host)

	certificate, err := tls.LoadX509KeyPair(*certFile, *keyFile)
	if err != nil {
		fatal(logger, fmt.Sprintf("load client certificate: %v", err))
	}
	roots := x509.NewCertPool()
	caPEM, err := os.ReadFile(*caFile)
	if err != nil {
		fatal(logger, fmt.Sprintf("read gateway CA: %v", err))
	}
	if !roots.AppendCertsFromPEM(caPEM) {
		fatal(logger, "gateway CA bundle contains no certificates")
	}
	tlsConfig := &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{certificate},
		RootCAs:      roots,
		ServerName:   serverName,
	}

	server := buildDaemon(daemon, logger)
	client := &dialhome.Client{
		Dial: func() (net.Conn, error) {
			return tls.DialWithDialer(&net.Dialer{
				Timeout:   10 * time.Second,
				KeepAlive: 30 * time.Second,
				KeepAliveConfig: net.KeepAliveConfig{
					Enable:   true,
					Idle:     30 * time.Second,
					Interval: 10 * time.Second,
					Count:    3,
				},
			}, "tcp", address, tlsConfig)
		},
		Server:      server,
		Name:        *name,
		MaxRuntimes: *maxRuntimes,
		Workspace:   server.Workspace,
		Log:         logger,
	}
	logger.Info("mikan-worker dialing home", "gateway", address, "name", *name)
	client.Run(make(chan struct{}))
}

func defaultWorkerName() string {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		return "worker"
	}
	return hostname
}

func defaultWorkerDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "mikan-worker"
	}
	return filepath.Join(home, "mikan-worker")
}

func executablePath() string {
	path, err := os.Executable()
	if err != nil {
		return "/usr/local/bin/mikan-worker"
	}
	return path
}

func wasSet(flags *flag.FlagSet, name string) bool {
	set := false
	flags.Visit(func(f *flag.Flag) {
		if f.Name == name {
			set = true
		}
	})
	return set
}

func applyIfUnset(flags *flag.FlagSet, name string, target *string, value string) {
	if !wasSet(flags, name) && value != "" {
		*target = value
	}
}

func fatal(logger *slog.Logger, message string) {
	logger.Error(message)
	os.Exit(1)
}
