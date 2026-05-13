// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

package session

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/log"
	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/pex"
)

// CmdDispatchTimeout caps how long an HTTP handler waits for the per-session
// goroutine to drain a Cmd off the inbox. If the inbox is full the channel
// send blocks; we prefer to fast-fail the request rather than hold an HTTP
// connection open while the session is wedged.
const CmdDispatchTimeout = 5 * time.Second

// SendReplyTimeout caps how long the HTTP handler waits for the libgm.Client
// SendMessage round-trip to land. libgm posts to Google's tachyon RPC; the
// realistic 95th-percentile is ~1s, so 15s leaves comfortable headroom.
const SendReplyTimeout = 15 * time.Second

// RefreshReplyTimeout caps how long the HTTP handler waits for
// RefreshPhoneRelay to return. Refresh involves an HTTP round-trip to
// Google's relay; 30s is the upstream library's typical envelope.
const RefreshReplyTimeout = 30 * time.Second

// errSessionNotRunning is returned to the API when the requested
// pairedSessionId isn't in the manager's pool. The API should re-attempt
// after a re-pair if the user re-establishes the connection.
var errSessionNotRunning = errors.New("session not running")

// Handler returns an http.Handler for the per-session POST routes added in
// Phase 5: /sessions/:pairedSessionId/send and
// /sessions/:pairedSessionId/refresh. The caller is responsible for
// wrapping it in HMAC auth.
func (m *Manager) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/sessions/", m.handleSessionRoute)
	return mux
}

// handleSessionRoute parses /sessions/:id/{send|refresh} from the path and
// dispatches accordingly. We hand-roll the routing because net/http stdlib
// 1.22+ has pattern matching but the existing pair routes use plain
// HandleFunc — staying consistent with that style.
func (m *Manager) handleSessionRoute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "")
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/sessions/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "")
		return
	}
	sessionID := parts[0]
	switch parts[1] {
	case "send":
		m.handleSend(w, r, sessionID)
	case "refresh":
		m.handleRefresh(w, r, sessionID)
	default:
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "")
	}
}

type sendRequest struct {
	ThreadID       string `json:"threadId"`
	Text           string `json:"text"`
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
}

type sendResponse struct {
	MessageID string `json:"messageId"`
}

func (m *Manager) handleSend(w http.ResponseWriter, r *http.Request, sessionID string) {
	logger := log.New().With("pairedSessionId", sessionID, "route", "send")

	var body sendRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON")
		return
	}
	if strings.TrimSpace(body.ThreadID) == "" || strings.TrimSpace(body.Text) == "" {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "threadId and text required")
		return
	}

	sess := m.Get(sessionID)
	if sess == nil {
		writeErr(w, http.StatusNotFound, "SESSION_NOT_RUNNING", errSessionNotRunning.Error())
		return
	}

	reply := make(chan CmdResult, 1)
	cmd := Cmd{
		Kind:     CmdSend,
		ThreadID: body.ThreadID,
		Text:     body.Text,
		IdemKey:  body.IdempotencyKey,
		Reply:    reply,
	}

	ctx := r.Context()
	if err := dispatchCmd(ctx, sess, cmd); err != nil {
		logger.Warn("send dispatch failed", "err", err.Error())
		writeErr(w, http.StatusServiceUnavailable, "SEND_QUEUE_FULL", err.Error())
		return
	}

	res, err := awaitReply(ctx, reply, SendReplyTimeout)
	if err != nil {
		logger.Warn("send reply timeout/cancel", "err", err.Error())
		writeErr(w, http.StatusGatewayTimeout, "SEND_TIMEOUT", err.Error())
		return
	}
	if res.Err != nil {
		logger.Warn("libgm send returned error", "err", res.Err.Error())
		writeErr(w, http.StatusBadGateway, "SEND_FAILED", res.Err.Error())
		return
	}

	writeJSON(w, http.StatusAccepted, sendResponse{MessageID: res.MessageID})
}

type refreshResponse struct {
	State string `json:"state"`
}

func (m *Manager) handleRefresh(w http.ResponseWriter, r *http.Request, sessionID string) {
	logger := log.New().With("pairedSessionId", sessionID, "route", "refresh")

	// Body is intentionally unused (currently `{}`); read+discard so HMAC
	// signature verification has a definite body and downstream parsers
	// don't trip on a non-JSON payload.
	_ = json.NewDecoder(r.Body).Decode(&struct{}{})

	sess := m.Get(sessionID)
	if sess == nil {
		writeErr(w, http.StatusNotFound, "SESSION_NOT_RUNNING", errSessionNotRunning.Error())
		return
	}

	reply := make(chan CmdResult, 1)
	cmd := Cmd{Kind: CmdRefresh, Reply: reply}

	ctx := r.Context()
	if err := dispatchCmd(ctx, sess, cmd); err != nil {
		logger.Warn("refresh dispatch failed", "err", err.Error())
		writeErr(w, http.StatusServiceUnavailable, "REFRESH_QUEUE_FULL", err.Error())
		return
	}

	res, err := awaitReply(ctx, reply, RefreshReplyTimeout)
	if err != nil {
		logger.Warn("refresh reply timeout/cancel", "err", err.Error())
		// The refresh was kicked off; the session goroutine will still post
		// the terminal state change to Plexo Core when it lands.
		writeJSON(w, http.StatusAccepted, refreshResponse{State: string(pex.StateRefreshing)})
		return
	}
	if res.Err != nil {
		logger.Warn("libgm refresh returned error", "err", res.Err.Error())
		writeJSON(w, http.StatusAccepted, refreshResponse{State: string(pex.StateErrored)})
		return
	}
	writeJSON(w, http.StatusAccepted, refreshResponse{State: string(pex.StateActive)})
}

func dispatchCmd(ctx context.Context, sess *Session, cmd Cmd) error {
	timer := time.NewTimer(CmdDispatchTimeout)
	defer timer.Stop()
	select {
	case sess.Cmds <- cmd:
		return nil
	case <-timer.C:
		return errors.New("session command queue full or stalled")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func awaitReply(ctx context.Context, reply <-chan CmdResult, timeout time.Duration) (CmdResult, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case r := <-reply:
		return r, nil
	case <-timer.C:
		return CmdResult{}, errors.New("timeout waiting for libgm reply")
	case <-ctx.Done():
		return CmdResult{}, ctx.Err()
	}
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, code int, errCode, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	payload := map[string]any{"error": map[string]string{"code": errCode}}
	if message != "" {
		payload["error"].(map[string]string)["message"] = message
	}
	_ = json.NewEncoder(w).Encode(payload)
}
