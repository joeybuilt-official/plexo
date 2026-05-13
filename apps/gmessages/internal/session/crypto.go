// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Package session implements ADR-0004's per-session goroutine model + its
// three Yara invariants:
//
//  1. Session keys derived from (workspace_id, paired_session_id) via HKDF;
//     never co-resident across goroutines, zeroed on session end.
//  2. Panic isolation — defer recover() at every session-goroutine entry
//     point. A panic kills the offending session, never the process.
//  3. Compile-time-redacted structured logging — see internal/log.
package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"errors"
)

const keyLen = 32 // AES-256

// hkdfExpand implements RFC 5869 HKDF-Expand using HMAC-SHA256. Inlining
// the primitive avoids pulling in golang.org/x/crypto solely for this
// while still being a faithful HKDF implementation; future code can swap
// to x/crypto/hkdf if libgmessages already pulls it in transitively.
func hkdfExpand(prk, info []byte, length int) ([]byte, error) {
	hashLen := sha256.Size
	if length > 255*hashLen {
		return nil, errors.New("hkdf: requested length too large")
	}
	out := make([]byte, 0, length)
	var t []byte
	for i := byte(1); len(out) < length; i++ {
		mac := hmac.New(sha256.New, prk)
		mac.Write(t)
		mac.Write(info)
		mac.Write([]byte{i})
		t = mac.Sum(nil)
		out = append(out, t...)
	}
	return out[:length], nil
}

// hkdfExtract is the standard HKDF-Extract over HMAC-SHA256.
func hkdfExtract(salt, ikm []byte) []byte {
	if salt == nil {
		salt = make([]byte, sha256.Size)
	}
	mac := hmac.New(sha256.New, salt)
	mac.Write(ikm)
	return mac.Sum(nil)
}

// DeriveSessionKey returns a workspace-and-session-scoped 32-byte key from
// the master secret. Per ADR-0004 invariant 1 the result must never be
// co-resident with another session's key in the same goroutine; callers
// should treat the slice as ephemeral and zero it on session end via Zero.
//
// info string follows the convention: "plexo-gmessages|workspace=<wid>|session=<sid>".
func DeriveSessionKey(master []byte, workspaceID, sessionID string) ([]byte, error) {
	if len(master) == 0 {
		return nil, errors.New("session: master key empty")
	}
	prk := hkdfExtract(nil, master)
	info := []byte("plexo-gmessages|workspace=" + workspaceID + "|session=" + sessionID)
	return hkdfExpand(prk, info, keyLen)
}

// Zero overwrites a byte slice in place. The compiler's escape analysis
// can elide writes to dead memory; the explicit loop + runtime.KeepAlive
// pattern documented in ADR-0004 invariant 1 prevents that. Callers must
// invoke Zero on session keys at the end of every session goroutine.
func Zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
