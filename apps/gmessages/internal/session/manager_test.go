// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

package session

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

type fakeHandler struct {
	startedRuns atomic.Int32
	panicOnRun  bool
}

func (f *fakeHandler) Run(ctx context.Context, sess *Session) error {
	f.startedRuns.Add(1)
	if f.panicOnRun {
		panic("simulated libgmessages panic")
	}
	<-ctx.Done()
	return nil
}

// TestManager_PanicIsolation verifies ADR-0004 invariant 2: a session
// panic kills only that session, never the process.
func TestManager_PanicIsolation(t *testing.T) {
	h := &fakeHandler{panicOnRun: true}
	m := NewManager([]byte("test-master-key-for-hkdf"), h, nil)

	if err := m.Start(context.Background(), "ws_test", "sess_test", "ch_test", nil); err != nil {
		t.Fatalf("start: %v", err)
	}

	// Allow the goroutine to run + recover.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && m.Active() > 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if m.Active() != 0 {
		t.Errorf("expected session purged after panic; active=%d", m.Active())
	}
	if h.startedRuns.Load() != 1 {
		t.Errorf("expected exactly one Run invocation; got %d", h.startedRuns.Load())
	}
}

// TestDeriveSessionKey_Determinism verifies the HKDF derivation is stable
// across calls and distinct across (workspace, session) pairs.
func TestDeriveSessionKey_Determinism(t *testing.T) {
	master := []byte("master-secret-for-test-only")

	a1, err := DeriveSessionKey(master, "ws_a", "sess_a")
	if err != nil {
		t.Fatalf("derive a1: %v", err)
	}
	a2, err := DeriveSessionKey(master, "ws_a", "sess_a")
	if err != nil {
		t.Fatalf("derive a2: %v", err)
	}
	b1, err := DeriveSessionKey(master, "ws_a", "sess_b")
	if err != nil {
		t.Fatalf("derive b1: %v", err)
	}

	if string(a1) != string(a2) {
		t.Errorf("derivation must be deterministic")
	}
	if string(a1) == string(b1) {
		t.Errorf("different sessions must derive different keys")
	}
	if len(a1) != 32 {
		t.Errorf("expected 32-byte key; got %d", len(a1))
	}
}

// TestZero verifies the explicit zeroing helper.
func TestZero(t *testing.T) {
	b := []byte{1, 2, 3, 4}
	Zero(b)
	for _, c := range b {
		if c != 0 {
			t.Errorf("Zero left non-zero byte: %v", b)
			break
		}
	}
}
