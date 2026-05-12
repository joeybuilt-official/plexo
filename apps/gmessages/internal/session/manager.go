// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

package session

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"runtime/debug"
	"sync"
	"time"

	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/liveness"
	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/log"
	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/pex"
)

// MaxBufferedEvents is the per-session bounded channel capacity. ADR-0004
// "Event ordering + backpressure": the connector buffers up to this many
// inbound events; on overflow events drop and the sidecar emits a
// telemetry burst. libgmessages will replay missed events on next sync.
const MaxBufferedEvents = 1000

// HardSessionTimeout is the per-session wall-clock cap. Phase 4 will tune;
// ADR-0004 §"Failure modes" sets 24h as the failsafe.
const HardSessionTimeout = 24 * time.Hour

// CmdKind is the discriminator on Cmd — the per-session command channel
// the HTTP handlers write to and the libgm-driving goroutine reads.
//
// ADR-0004 invariant: libgm.Client is owned by exactly one goroutine. HTTP
// requests must hand work to the owning goroutine via this channel, never
// touch the Client directly.
type CmdKind int

const (
	CmdSend CmdKind = iota + 1
	CmdRefresh
)

// CmdResult is the synchronous reply the owning goroutine sends back. For
// CmdSend, MessageID is the libgm-side TmpID we assigned (which echoes back
// on the eventual *libgm.WrappedMessage event for ack). For CmdRefresh,
// MessageID is empty.
type CmdResult struct {
	MessageID string
	Err       error
}

// Cmd is the unit of work the HTTP layer hands to the owning goroutine.
// Reply is a buffered (cap=1) channel so the handler goroutine never blocks
// posting the result if the requester gives up.
type Cmd struct {
	Kind     CmdKind
	ThreadID string // Send: target conversation
	Text     string // Send: plain body
	IdemKey  string // Send: optional dedupe key (also used as TmpID)
	Reply    chan CmdResult
}

// CmdChannelCapacity caps the per-session command queue. Outbound rate is
// human-typing-bound, so 32 is comfortable headroom; overflow returns
// ErrSendQueueFull at the HTTP layer.
const CmdChannelCapacity = 32

// Session is one workspace's paired libgmessages connection running on a
// dedicated goroutine. The DerivedKey field carries the HKDF-derived
// per-session key (see crypto.go). It is zeroed on session.End().
//
// AuthBlob is the JSON-marshaled libgm.AuthData for this paired session,
// already decrypted by the caller (Plexo API → restore-list endpoint
// returns ciphertext; the sidecar decrypts via the shared
// ENCRYPTION_SECRET workspace-key derivation before calling Manager.Start).
// The Handler unmarshals this into a libgm.AuthData and instantiates a
// libgm.Client.
//
// Counters carry the inbound + decode-error tallies the heartbeat loop
// posts to Plexo Core every 60s (ADR-0004 §"Liveness: layered, both
// signals"). The Handler writes; HeartbeatLoop reads.
//
// Cmds is the per-session inbox the HTTP handlers post to (Phase 5: send +
// refresh). Only the goroutine running the Handler reads from it.
type Session struct {
	ID          string
	WorkspaceID string
	ChannelID   string
	DerivedKey  []byte
	AuthBlob    []byte
	Counters    *liveness.Counters
	Events      chan pex.ChannelEvent
	Cmds        chan Cmd

	cancel context.CancelFunc
	once   sync.Once
}

// End zeroes the session key and closes the events channel. Idempotent.
func (s *Session) End() {
	s.once.Do(func() {
		Zero(s.DerivedKey)
		// runtime.KeepAlive ensures the compiler doesn't elide the write
		// loop — see ADR-0004 invariant 1.
		runtime.KeepAlive(s.DerivedKey)
		close(s.Events)
		if s.cancel != nil {
			s.cancel()
		}
	})
}

// Handler is the per-session work loop the Manager runs inside a recovered
// goroutine. Phase 4 wires libgmessages here; Phase 3 ships an interface so
// tests can substitute a fake.
type Handler interface {
	Run(ctx context.Context, sess *Session) error
}

// HeartbeatInterval is the cadence of the per-session flow-heartbeat post
// to Plexo Core (ADR-0004 §"Liveness: layered, both signals").
const HeartbeatInterval = 60 * time.Second

// Manager owns the per-session goroutine pool. Single-process multi-tenant
// per ADR-0004; per-workspace scaling is a Phase 6+ concern.
//
// PexClient is shared across all sessions for outbound posts (heartbeats +
// inbound events + state changes). Nil-safe: if PexClient is nil the
// HeartbeatLoop is skipped — handy for unit tests using a stub Handler.
type Manager struct {
	mu        sync.Mutex
	sessions  map[string]*Session
	handler   Handler
	master    []byte
	pexClient *pex.Client
}

// NewManager constructs a manager with the master key used to derive
// per-session keys via HKDF and the shared pex client used by the
// heartbeat loop.
func NewManager(masterKey []byte, h Handler, pexClient *pex.Client) *Manager {
	return &Manager{
		sessions:  make(map[string]*Session),
		handler:   h,
		master:    masterKey,
		pexClient: pexClient,
	}
}

// Start spawns a goroutine for the (workspaceID, sessionID, channelID)
// triple, seeded with the libgm AuthData blob (already decrypted by the
// caller). Returns an error if the session is already running. The
// goroutine is panic-isolated per ADR-0004 invariant 2 — a panic kills
// only this session, never the process.
func (m *Manager) Start(ctx context.Context, workspaceID, sessionID, channelID string, authBlob []byte) error {
	m.mu.Lock()
	if _, exists := m.sessions[sessionID]; exists {
		m.mu.Unlock()
		return errors.New("session already running")
	}

	key, err := DeriveSessionKey(m.master, workspaceID, sessionID)
	if err != nil {
		m.mu.Unlock()
		return fmt.Errorf("derive key: %w", err)
	}

	sessCtx, cancel := context.WithTimeout(ctx, HardSessionTimeout)
	sess := &Session{
		ID:          sessionID,
		WorkspaceID: workspaceID,
		ChannelID:   channelID,
		DerivedKey:  key,
		AuthBlob:    authBlob,
		Counters:    &liveness.Counters{},
		Events:      make(chan pex.ChannelEvent, MaxBufferedEvents),
		Cmds:        make(chan Cmd, CmdChannelCapacity),
		cancel:      cancel,
	}
	m.sessions[sessionID] = sess
	m.mu.Unlock()

	go m.runSession(sessCtx, sess)
	return nil
}

// runSession is the panic-isolated entry point. Any panic inside the
// handler kills only this goroutine; the manager records the failure so
// the operator-facing UX surfaces re-pair (ADR-0004 §"Restart semantics").
//
// Spawns a sibling HeartbeatLoop goroutine that posts the session's flow
// heartbeat to Plexo Core every HeartbeatInterval (60s). The heartbeat
// goroutine shares the same ctx — both unwind on session end.
func (m *Manager) runSession(ctx context.Context, sess *Session) {
	logger := log.WithSession(log.New(), sess.WorkspaceID, sess.ID)

	defer func() {
		if r := recover(); r != nil {
			logger.Error("session panic recovered",
				"panic", fmt.Sprintf("%v", r),
				"stack", string(debug.Stack()),
			)
		}
		m.mu.Lock()
		delete(m.sessions, sess.ID)
		m.mu.Unlock()
		sess.End()
	}()

	if m.pexClient != nil && sess.Counters != nil {
		go liveness.HeartbeatLoop(ctx, m.pexClient, sess.ID, sess.Counters, HeartbeatInterval)
	}

	if err := m.handler.Run(ctx, sess); err != nil {
		logger.Warn("session handler returned error", "err", err.Error())
	}
}

// Stop ends the session by ID. Idempotent; returns false if not running.
func (m *Manager) Stop(sessionID string) bool {
	m.mu.Lock()
	sess, ok := m.sessions[sessionID]
	m.mu.Unlock()
	if !ok {
		return false
	}
	sess.End()
	return true
}

// Active returns the count of running sessions (for telemetry).
func (m *Manager) Active() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

// Get returns the running Session for sessionID, or nil if not running.
// The returned pointer is safe to retain — Session.End is idempotent and
// Cmds is read by the owning goroutine; senders just need to handle a
// closed-channel panic by recovering or by checking Manager.Get freshness.
// In practice the HTTP handler does the lookup-then-send under the same
// HTTP request, well within the session lifetime.
func (m *Manager) Get(sessionID string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[sessionID]
}

// Range invokes fn for each running session. The fn must not block — it
// holds the manager's mutex.
func (m *Manager) Range(fn func(sess *Session)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		fn(s)
	}
}
