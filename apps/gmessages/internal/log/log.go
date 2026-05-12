// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Package log wraps log/slog with compile-time-redacted secret types
// (ADR-0004 invariant 3). Any field whose value is `Secret` or `SessionBlob`
// renders as `--redacted--` in JSON output regardless of how it lands in
// the logger — `slog.Any("session", blob)`, `Error{Detail: blob}`, etc.
//
// The deliberate choice to redact at the type level (not via runtime regex)
// is what survives a future refactor that adds new code paths logging the
// same secret. Compile-time means: the only way to log the inner value is
// to call .Reveal() and pass that explicitly, which is greppable.
package log

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"sync"
)

const redacted = "--redacted--"

// Secret wraps a sensitive string. Its MarshalJSON, String, and slog.LogValue
// implementations all return "--redacted--". Reveal() returns the inner
// value and exists so that explicit, greppable callsites can extract the
// secret when it's actually needed (HMAC signing, libgmessages calls).
type Secret string

func (s Secret) MarshalJSON() ([]byte, error)    { return json.Marshal(redacted) }
func (s Secret) String() string                  { return redacted }
func (s Secret) LogValue() slog.Value            { return slog.StringValue(redacted) }
func (s Secret) Reveal() string                  { return string(s) }

// SessionBlob is the libgmessages-session payload stored in
// installed_connections.credentials. Same semantics as Secret but with a
// distinct type so audit greps can find session-specific leaks separately
// from arbitrary secrets.
type SessionBlob []byte

func (b SessionBlob) MarshalJSON() ([]byte, error) { return json.Marshal(redacted) }
func (b SessionBlob) String() string               { return redacted }
func (b SessionBlob) LogValue() slog.Value         { return slog.StringValue(redacted) }
func (b SessionBlob) Reveal() []byte               { return b }

// New constructs a JSON slog.Logger writing to stderr — the same output
// shape Plexo Core's Pino logger emits, which the auto-deploy daemon's
// log capture handles uniformly.
var (
	once   sync.Once
	logger *slog.Logger
)

func New() *slog.Logger {
	once.Do(func() {
		logger = slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
			Level: slog.LevelInfo,
		}))
	})
	return logger
}

// WithSession returns a logger with workspace + session context attached
// to every emitted record. Note: only IDs are bound; the session blob and
// derived keys must never be passed here.
func WithSession(parent *slog.Logger, workspaceID, sessionID string) *slog.Logger {
	return parent.With(
		slog.String("workspaceId", workspaceID),
		slog.String("pairedSessionId", sessionID),
	)
}

// FromContext is reserved for a future request-scoped logger pattern; for
// now it just returns the package logger so callers don't depend on the
// stdlib slog.Default().
func FromContext(_ context.Context) *slog.Logger {
	return New()
}
