// Package dialhome implements the worker side of mikan's dial-home mode:
// instead of listening for the mikan host, the daemon opens one outbound mTLS
// control connection to it (NAT-friendly, GitHub-Actions-runner style),
// registers its identity and surviving runtimes, serves the same protocol as
// the listen mode over RPC frames, and dials back one data connection per
// session tunnel the host asks for.
package dialhome

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/geminixiang/mikan/worker/internal/api"
	workerruntime "github.com/geminixiang/mikan/worker/internal/runtime"
)

const maxFrameBytes = 8 << 20

// Frame is the single message shape on the control channel (u32be length +
// JSON both directions). Fields are a union across message types.
type Frame struct {
	Type            string                  `json:"type"`
	ID              int64                   `json:"id,omitempty"`
	Name            string                  `json:"name,omitempty"`
	OS              string                  `json:"os,omitempty"`
	Arch            string                  `json:"arch,omitempty"`
	Accelerator     string                  `json:"accelerator,omitempty"`
	CPUs            int                     `json:"cpus,omitempty"`
	MemoryBytes     int64                   `json:"memoryBytes,omitempty"`
	MaxRuntimes     int                     `json:"maxRuntimes,omitempty"`
	ProtocolVersion int                     `json:"protocolVersion,omitempty"`
	ActiveRuntimes  int                     `json:"activeRuntimes,omitempty"`
	Runtimes        []workerruntime.Runtime `json:"runtimes,omitempty"`
	Method          string                  `json:"method,omitempty"`
	Path            string                  `json:"path,omitempty"`
	Headers         map[string]string       `json:"headers,omitempty"`
	Body            json.RawMessage         `json:"body,omitempty"`
	Status          int                     `json:"status,omitempty"`
	Nonce           string                  `json:"nonce,omitempty"`
	SessionID       string                  `json:"sessionId,omitempty"`
	Message         string                  `json:"message,omitempty"`
	// WorkspaceError is non-empty when the shared workspace root failed its
	// usability probe (register and ping frames).
	WorkspaceError string `json:"workspaceError,omitempty"`
	// join exchange
	Token string `json:"token,omitempty"`
	CSR   string `json:"csr,omitempty"`
	Cert  string `json:"cert,omitempty"`
	CA    string `json:"ca,omitempty"`
}

// WriteFrame encodes one frame onto a stream.
func WriteFrame(w io.Writer, frame Frame) error {
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(payload)))
	if _, err := w.Write(header); err != nil {
		return err
	}
	_, err = w.Write(payload)
	return err
}

// ReadFrame decodes one frame from a stream.
func ReadFrame(r io.Reader) (Frame, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(r, header); err != nil {
		return Frame{}, err
	}
	length := binary.BigEndian.Uint32(header)
	if length > maxFrameBytes {
		return Frame{}, fmt.Errorf("frame too large: %d bytes", length)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return Frame{}, err
	}
	var frame Frame
	if err := json.Unmarshal(payload, &frame); err != nil {
		return Frame{}, fmt.Errorf("malformed frame: %w", err)
	}
	return frame, nil
}

// WorkspaceHealth reports shared-workspace usability for control frames.
type WorkspaceHealth interface {
	Status() string // fresh result, bounded wait — for registration
	Cached() string // last known result, never blocks — for heartbeats
}

// Client maintains the dial-home relationship with one mikan host.
type Client struct {
	// Dial opens one authenticated stream to the host (control or dial-back).
	Dial func() (net.Conn, error)
	// Server is the same protocol implementation the listen mode serves.
	Server *api.Server
	Name   string
	// MaxRuntimes advertises the admission cap the host should apply.
	MaxRuntimes int
	// Workspace, when set, stamps register and ping frames with the shared
	// workspace root's health so the host can gate placement on it.
	Workspace WorkspaceHealth
	Log       *slog.Logger

	PingInterval time.Duration
	// PongTimeout bounds how long a ping may remain unacknowledged before the
	// control channel is treated as half-open and reconnected.
	PongTimeout time.Duration
	// ReconnectMin/Max bound the exponential backoff between attempts.
	ReconnectMin time.Duration
	ReconnectMax time.Duration
	// ReconnectResetAfter resets accumulated backoff after a session stayed
	// healthy for this long. ReconnectJitter is the fractional random spread
	// applied to waits so a gateway restart does not synchronize the fleet.
	ReconnectResetAfter time.Duration
	ReconnectJitter     float64
	// RandomFloat is overridden by tests. Production uses math/rand/v2.
	RandomFloat func() float64

	// handler is built once: Server.Handler() resets idempotency state.
	handler http.Handler
}

// Run dials, registers, and serves until stop closes. Each disconnect is
// followed by a fresh register carrying the currently surviving runtimes, so
// the host can reconcile placements after any gap.
func (c *Client) Run(stop <-chan struct{}) {
	if c.Log == nil {
		c.Log = slog.Default()
	}
	if c.PingInterval == 0 {
		c.PingInterval = 15 * time.Second
	}
	if c.PongTimeout == 0 {
		c.PongTimeout = 10 * time.Second
	}
	if c.ReconnectMin == 0 {
		c.ReconnectMin = time.Second
	}
	if c.ReconnectMax == 0 {
		c.ReconnectMax = 30 * time.Second
	}
	if c.ReconnectResetAfter == 0 {
		c.ReconnectResetAfter = time.Minute
	}
	if c.ReconnectJitter == 0 {
		c.ReconnectJitter = 0.2
	}
	if c.RandomFloat == nil {
		c.RandomFloat = rand.Float64
	}
	c.handler = c.Server.Handler()
	backoff := c.ReconnectMin
	for {
		select {
		case <-stop:
			return
		default:
		}
		started := time.Now()
		err := c.session(stop)
		if err == nil {
			return // stop requested during a healthy session
		}
		if time.Since(started) >= c.ReconnectResetAfter {
			backoff = c.ReconnectMin
		}
		delay := jitterDelay(backoff, c.ReconnectJitter, c.RandomFloat())
		c.Log.Warn("dial-home session ended; reconnecting", "error", err, "backoff", delay)
		select {
		case <-stop:
			return
		case <-time.After(delay):
		}
		backoff *= 2
		if backoff > c.ReconnectMax {
			backoff = c.ReconnectMax
		}
	}
}

// session runs one control-channel lifetime. Returns nil only when stop fired.
func (c *Client) session(stop <-chan struct{}) error {
	conn, err := c.Dial()
	if err != nil {
		return fmt.Errorf("dial control: %w", err)
	}
	defer conn.Close()

	writes := &syncWriter{conn: conn}
	if err := WriteFrame(writes, c.registerFrame()); err != nil {
		return fmt.Errorf("register: %w", err)
	}
	c.Log.Info("registered with mikan host", "name", c.Name, "runtimes", c.Server.Runtimes.Count())

	frames := make(chan Frame)
	readErr := make(chan error, 1)
	readerDone := make(chan struct{})
	defer close(readerDone)
	go func() {
		for {
			frame, err := ReadFrame(conn)
			if err != nil {
				select {
				case readErr <- err:
				case <-readerDone:
				}
				return
			}
			select {
			case frames <- frame:
			case <-readerDone:
				return
			}
		}
	}()

	ping := time.NewTicker(c.PingInterval)
	defer ping.Stop()
	var pongTimer *time.Timer
	var pongTimeout <-chan time.Time
	stopPongTimer := func() {
		if pongTimer != nil && !pongTimer.Stop() {
			select {
			case <-pongTimer.C:
			default:
			}
		}
		pongTimeout = nil
	}
	defer stopPongTimer()
	for {
		select {
		case <-stop:
			return nil
		case err := <-readErr:
			return err
		case <-pongTimeout:
			return fmt.Errorf("gateway pong timeout after %s", c.PongTimeout)
		case <-ping.C:
			// Only one ping may be outstanding. The timeout owns liveness until
			// its matching pong arrives, preventing traffic from masking a
			// one-way or half-open control channel.
			if pongTimeout != nil {
				continue
			}
			frame := Frame{
				Type:           "ping",
				ActiveRuntimes: c.Server.Runtimes.Count(),
				WorkspaceError: c.workspaceCached(),
			}
			if err := WriteFrame(writes, frame); err != nil {
				return err
			}
			pongTimer = time.NewTimer(c.PongTimeout)
			pongTimeout = pongTimer.C
		case frame := <-frames:
			switch frame.Type {
			case "request":
				go c.serveRPC(writes, frame)
			case "open-tunnel":
				go c.dialBackTunnel(frame)
			case "pong":
				stopPongTimer()
			default:
				c.Log.Warn("unknown control frame", "type", frame.Type)
			}
		}
	}
}

func jitterDelay(base time.Duration, fraction, randomFloat float64) time.Duration {
	if fraction <= 0 {
		return base
	}
	if fraction > 1 {
		fraction = 1
	}
	factor := 1 + ((randomFloat*2)-1)*fraction
	return time.Duration(float64(base) * factor)
}

func (c *Client) registerFrame() Frame {
	return Frame{
		Type:            "register",
		Name:            c.Name,
		OS:              runtime.GOOS,
		Arch:            runtime.GOARCH,
		Accelerator:     api.Accelerator(),
		CPUs:            runtime.NumCPU(),
		MemoryBytes:     api.TotalMemoryBytes(),
		MaxRuntimes:     c.MaxRuntimes,
		ProtocolVersion: api.ProtocolVersion,
		Runtimes:        c.Server.Runtimes.List(""),
		WorkspaceError:  c.workspaceStatus(),
	}
}

func (c *Client) workspaceStatus() string {
	if c.Workspace == nil {
		return ""
	}
	return c.Workspace.Status()
}

func (c *Client) workspaceCached() string {
	if c.Workspace == nil {
		return ""
	}
	return c.Workspace.Cached()
}

// serveRPC synthesizes the frame into the daemon's regular HTTP handler, so
// listen mode and dial-home mode cannot drift apart.
func (c *Client) serveRPC(writes *syncWriter, frame Frame) {
	request, err := http.NewRequest(frame.Method, frame.Path, bytes.NewReader(frame.Body))
	if err != nil {
		_ = WriteFrame(writes, Frame{Type: "response", ID: frame.ID, Status: http.StatusBadRequest})
		return
	}
	for key, value := range frame.Headers {
		request.Header.Set(key, value)
	}
	recorder := &responseRecorder{header: make(http.Header)}
	c.handler.ServeHTTP(recorder, request)
	_ = WriteFrame(writes, Frame{
		Type:   "response",
		ID:     frame.ID,
		Status: recorder.statusOr200(),
		Body:   json.RawMessage(recorder.body.Bytes()),
	})
}

// dialBackTunnel opens the per-command data connection and splices it onto
// the runtime's session socket — the host-side abort-by-disconnect semantics
// pass through unchanged.
func (c *Client) dialBackTunnel(frame Frame) {
	entry, err := c.Server.Runtimes.Get(frame.SessionID)
	if err != nil {
		c.Log.Warn("tunnel for unknown runtime", "sessionId", frame.SessionID)
		return
	}
	if err := c.authorizeTunnel(entry, frame.Headers); err != nil {
		c.Log.Warn("tunnel refused", "sessionId", frame.SessionID, "error", err)
		return
	}
	conn, err := c.Dial()
	if err != nil {
		c.Log.Warn("dial-back failed", "error", err)
		return
	}
	if err := WriteFrame(conn, Frame{Type: "tunnel", Nonce: frame.Nonce, Name: c.Name}); err != nil {
		conn.Close()
		return
	}
	backend, err := net.DialTimeout("unix", entry.SocketPath, 5*time.Second)
	if err != nil {
		conn.Close()
		c.Log.Warn("session socket unreachable", "sessionId", frame.SessionID, "error", err)
		return
	}
	splice(conn, backend)
}

// authorizeTunnel enforces the same lease fencing the listen mode applies to
// its session endpoint.
func (c *Client) authorizeTunnel(entry *workerruntime.Runtime, headers map[string]string) error {
	leaseID := headers["X-Mikan-Lease"]
	epoch, err := strconv.ParseUint(headers["X-Mikan-Epoch"], 10, 64)
	if leaseID == "" || err != nil {
		return errors.New("missing lease headers")
	}
	return c.Server.Leases.Validate(entry.InstanceID, leaseID, epoch)
}

func splice(a net.Conn, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(b, a)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(a, b)
		done <- struct{}{}
	}()
	<-done
	a.Close()
	b.Close()
	<-done
}

type syncWriter struct {
	mu   sync.Mutex
	conn net.Conn
}

func (w *syncWriter) Write(payload []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.Write(payload)
}

type responseRecorder struct {
	status int
	header http.Header
	body   bytes.Buffer
}

func (r *responseRecorder) Header() http.Header { return r.header }

func (r *responseRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
}

func (r *responseRecorder) Write(payload []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.body.Write(payload)
}

func (r *responseRecorder) statusOr200() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}
