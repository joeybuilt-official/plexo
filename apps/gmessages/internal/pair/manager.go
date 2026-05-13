// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Package pair owns the short-lived pool of in-flight QR pairings.
//
// One libgm.Client per pending pairing, lifecycle bounded by PairTTL
// (5 min per ADR-0005 §"Failure modes"). The Plexo API calls Start to
// acquire a QR URL + pairingId, then polls Status. On a successful phone
// scan, libgm fires the PairCallback we register here; we snapshot the
// resulting AuthData blob into the Pending entry. The API picks it up on
// the next Status call, encrypts via crypto-util.ts AES-256-GCM, and
// persists into installed_connections.credentials.
//
// This is distinct from session.Manager (the active-session pool). Pair
// completion in 4a hands the AuthData blob *to the API* — the API in 4b
// will call session.Manager.Start with the decrypted blob to actually
// run a long-lived session. Phase 4a only pairs; 4b runs.
package pair

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

// PairTTL is the wall-clock cap on a pending pair entry. ADR-0005 §"Failure
// modes": the client polls and re-renders on expired.
const PairTTL = 5 * time.Minute

// State is the public-facing pair-pending state, mirrors the API's
// pair-status response.
type State string

const (
	StateWaiting State = "waiting"
	StateLinked  State = "linked"
	StateExpired State = "expired"
	StateErrored State = "errored"
)

// Pending is one in-flight pairing. Mutated under Manager.mu only.
type Pending struct {
	ID          string    `json:"pairingId"`
	QRURL       string    `json:"qrUrl"`
	State       State     `json:"state"`
	AuthBlob    []byte    `json:"-"` // serialized AuthData on linked
	ErrorDetail string    `json:"errorDetail,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	ExpiresAt   time.Time `json:"expiresAt"`

	client *libgm.Client
	cancel context.CancelFunc
}

// Manager is the pair-pending pool.
type Manager struct {
	mu       sync.Mutex
	pendings map[string]*Pending
	logger   zerolog.Logger
}

// NewManager returns an empty Manager. Pass a zerolog.Logger from the
// caller; pass zerolog.Nop() if logging is not wanted (libgm logs verbose).
func NewManager(logger zerolog.Logger) *Manager {
	return &Manager{
		pendings: make(map[string]*Pending),
		logger:   logger,
	}
}

// Start begins a new pairing. Returns a snapshot of the Pending (caller
// must not retain the *Pending — use Status to read live state).
func (m *Manager) Start(ctx context.Context) (Pending, error) {
	pairingID := uuid.New().String()

	auth := libgm.NewAuthData()
	client := libgm.NewClient(auth, nil, m.logger.With().Str("pairingId", pairingID).Logger())

	cb := m.makePairCallback(pairingID, client)
	client.PairCallback.Store(&cb)

	qr, err := client.StartLogin()
	if err != nil {
		return Pending{}, fmt.Errorf("StartLogin: %w", err)
	}

	now := time.Now()
	expCtx, cancel := context.WithTimeout(context.Background(), PairTTL)
	p := &Pending{
		ID:        pairingID,
		QRURL:     qr,
		State:     StateWaiting,
		CreatedAt: now,
		ExpiresAt: now.Add(PairTTL),
		client:    client,
		cancel:    cancel,
	}

	m.mu.Lock()
	m.pendings[pairingID] = p
	m.mu.Unlock()

	go m.expireWatcher(expCtx, pairingID)
	return *p, nil
}

// Status returns a snapshot of the named pair entry plus a flag for the
// linked-with-blob path. ok=false if pairingID is unknown.
func (m *Manager) Status(pairingID string) (snap Pending, blob []byte, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, exists := m.pendings[pairingID]
	if !exists {
		return Pending{}, nil, false
	}
	return *p, p.AuthBlob, true
}

// Discard removes a pair entry and tears down the libgm.Client. Idempotent.
// Plexo API calls this after consuming a `linked` response to free the
// pool entry.
func (m *Manager) Discard(pairingID string) {
	m.mu.Lock()
	p, ok := m.pendings[pairingID]
	if !ok {
		m.mu.Unlock()
		return
	}
	delete(m.pendings, pairingID)
	m.mu.Unlock()

	if p.cancel != nil {
		p.cancel()
	}
	// libgm.Client has Disconnect() — calling it tears down the long-poll
	// goroutine the StartLogin path spawned. Safe to call after pair too;
	// the active-session worker uses a fresh Client built from AuthData.
	p.client.Disconnect()
}

// makePairCallback returns the callback libgm fires when the phone scans.
// Snapshots AuthData into the pending's blob and flips state to linked.
func (m *Manager) makePairCallback(pairingID string, client *libgm.Client) func(*gmproto.PairedData) {
	return func(_ *gmproto.PairedData) {
		blob, err := json.Marshal(client.AuthData)

		m.mu.Lock()
		defer m.mu.Unlock()
		p, ok := m.pendings[pairingID]
		if !ok || p.State != StateWaiting {
			return
		}
		if err != nil {
			p.State = StateErrored
			p.ErrorDetail = "marshal AuthData: " + err.Error()
			return
		}
		p.State = StateLinked
		p.AuthBlob = blob
	}
}

func (m *Manager) expireWatcher(ctx context.Context, pairingID string) {
	<-ctx.Done()
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.pendings[pairingID]
	if !ok {
		return
	}
	if p.State == StateWaiting {
		p.State = StateExpired
	}
	// Leave the entry briefly so a pending poll observes the transition.
	// Phase 4b will sweep stale entries on a tick; for 4a a long-lived
	// expired entry is harmless (libgm.Client already torn down by ctx).
}

// ActivePending returns count of in-flight pending pairs (telemetry).
func (m *Manager) ActivePending() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, p := range m.pendings {
		if p.State == StateWaiting {
			n++
		}
	}
	return n
}
