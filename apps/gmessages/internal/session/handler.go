// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

package session

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"

	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/log"
	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/pex"
)

// LibgmHandler is the production session.Handler that drives a paired
// libgm.Client for one session goroutine. It hydrates the libgm AuthData
// from the session's AuthBlob, opens the long-poll connection, and bumps
// the session's liveness counters on each inbound event.
//
// Phase 4b scope: receive loop + counter accounting + clean shutdown.
// Phase 5 fills in the inbound message normalization → pex.SendInbound
// → message_dedupe → memory pipeline. The TODO comments in
// dispatchEvent mark the seams.
//
// PexClient is the same shared client the Manager carries; the heartbeat
// loop already uses it. We keep a reference here so Phase 5 can post
// inbound events from inside dispatchEvent without plumbing it through
// Session.
type LibgmHandler struct {
	PexClient *pex.Client
	Zerolog   zerolog.Logger
}

// Run implements session.Handler. Decodes the AuthBlob, instantiates a
// libgm.Client, calls Connect, sets the event handler, and blocks until
// ctx cancels.
func (h *LibgmHandler) Run(ctx context.Context, sess *Session) error {
	if len(sess.AuthBlob) == 0 {
		return fmt.Errorf("LibgmHandler: empty AuthBlob — cannot hydrate libgm.Client")
	}

	auth := &libgm.AuthData{}
	if err := json.Unmarshal(sess.AuthBlob, auth); err != nil {
		return fmt.Errorf("LibgmHandler: unmarshal AuthBlob: %w", err)
	}

	zlog := h.Zerolog.With().Str("workspaceId", sess.WorkspaceID).Str("sessionId", sess.ID).Logger()
	client := libgm.NewClient(auth, nil, zlog)
	client.SetEventHandler(func(evt any) {
		h.dispatchEvent(ctx, sess, evt)
	})

	if err := client.Connect(); err != nil {
		// Connection refusal at boot likely means the session is expired
		// or revoked. Surface via state-change so Plexo Core flips the
		// paired_sessions row and the UI shows the reconnect banner.
		h.postStateChange(ctx, sess.ID, pex.StateExpired, err.Error())
		return fmt.Errorf("libgm Connect: %w", err)
	}
	defer client.Disconnect()

	// Active = libgm.Client connected and listening.
	h.postStateChange(ctx, sess.ID, pex.StateActive, "")

	// Command-processing loop. The libgm.Client is owned by this goroutine
	// (ADR-0004 invariant 4); HTTP handlers post to sess.Cmds rather than
	// touch the client across goroutines.
	for {
		select {
		case <-ctx.Done():
			return nil
		case cmd, ok := <-sess.Cmds:
			if !ok {
				return nil
			}
			h.handleCmd(ctx, sess, client, cmd)
		}
	}
}

// handleCmd dispatches one Cmd on the owning goroutine.
func (h *LibgmHandler) handleCmd(ctx context.Context, sess *Session, client *libgm.Client, cmd Cmd) {
	logger := log.WithSession(log.New(), sess.WorkspaceID, sess.ID)
	switch cmd.Kind {
	case CmdSend:
		tmpID := strings.TrimSpace(cmd.IdemKey)
		if tmpID == "" {
			tmpID = uuid.NewString()
		}
		req := &gmproto.SendMessageRequest{
			ConversationID: cmd.ThreadID,
			TmpID:          tmpID,
			MessagePayload: &gmproto.MessagePayload{
				ConversationID: cmd.ThreadID,
				TmpID:          tmpID,
				MessagePayloadContent: &gmproto.MessagePayloadContent{
					MessageContent: &gmproto.MessageContent{
						Content: cmd.Text,
					},
				},
			},
		}
		_, err := client.SendMessage(req)
		if err != nil {
			logger.Warn("libgm SendMessage failed", "err", err.Error())
			cmd.replyAsync(CmdResult{Err: err})
			return
		}
		cmd.replyAsync(CmdResult{MessageID: tmpID})
	case CmdRefresh:
		h.postStateChange(ctx, sess.ID, pex.StateRefreshing, "")
		_, err := client.RefreshPhoneRelay()
		if err != nil {
			logger.Warn("libgm RefreshPhoneRelay failed", "err", err.Error())
			h.postStateChange(ctx, sess.ID, pex.StateErrored, err.Error())
			cmd.replyAsync(CmdResult{Err: err})
			return
		}
		h.postStateChange(ctx, sess.ID, pex.StateActive, "")
		cmd.replyAsync(CmdResult{})
	default:
		cmd.replyAsync(CmdResult{Err: fmt.Errorf("unknown cmd kind %d", cmd.Kind)})
	}
}

// replyAsync sends r on Reply if the channel exists and isn't full.
// Non-blocking by design — the requester may have already given up.
func (c Cmd) replyAsync(r CmdResult) {
	if c.Reply == nil {
		return
	}
	select {
	case c.Reply <- r:
	default:
	}
}

// dispatchEvent is invoked from libgm's long-poll goroutine on every
// inbound event. Counters are bumped on every recognized event so
// HeartbeatLoop sees fresh activity. Message-bearing events
// (*libgm.WrappedMessage) are normalized into pex.ChannelInbound and
// posted to Plexo Core for the message_dedupe → memory pipeline.
func (h *LibgmHandler) dispatchEvent(ctx context.Context, sess *Session, evt any) {
	logger := log.WithSession(log.New(), sess.WorkspaceID, sess.ID)

	switch e := evt.(type) {
	case *events.ClientReady:
		logger.Info("libgm ClientReady")
	case *events.AuthTokenRefreshed:
		logger.Debug("libgm AuthTokenRefreshed")
	case *events.GaiaLoggedOut:
		logger.Warn("libgm GaiaLoggedOut — session revoked")
		h.postStateChange(ctx, sess.ID, pex.StateRevoked, "")
	case *events.ListenFatalError:
		logger.Error("libgm ListenFatalError", "err", e.Error.Error())
		sess.Counters.MarkDecodeError()
	case *events.HTTPError:
		logger.Warn("libgm HTTPError")
		sess.Counters.MarkDecodeError()
	case *libgm.WrappedMessage:
		h.handleWrappedMessage(ctx, sess, e)
	default:
		// Anything else is treated as live inbound activity (presence,
		// typing, settings, conversation deltas). Phase 6+ will normalize
		// typing/read-receipts; for Phase 5 we just keep the heartbeat
		// signal alive.
		sess.Counters.MarkInbound()
	}
}

// handleWrappedMessage normalizes a libgm.WrappedMessage into a
// pex.ChannelInbound and posts it. Skips IsOld replays so the dedupe table
// in Plexo Core never sees the same gmessagesMsgId twice from the
// reconnect path. On any decode pathology that prevents normalization the
// session's decode-error counter is bumped (ADR-0004 invariant) and the
// event is dropped — libgm will replay on the next sync if the underlying
// message is still in scope.
func (h *LibgmHandler) handleWrappedMessage(ctx context.Context, sess *Session, wm *libgm.WrappedMessage) {
	logger := log.WithSession(log.New(), sess.WorkspaceID, sess.ID)
	if wm == nil || wm.Message == nil {
		sess.Counters.MarkDecodeError()
		return
	}
	if wm.IsOld {
		// Replay from Connect — already delivered on a prior session.
		return
	}

	msgID := wm.Message.GetMessageID()
	convoID := wm.Message.GetConversationID()
	if msgID == "" || convoID == "" {
		sess.Counters.MarkDecodeError()
		return
	}

	text := extractMessageText(wm.Message)

	sess.Counters.MarkInbound()

	inbound := pex.ChannelInbound{
		WorkspaceID:    sess.WorkspaceID,
		ChannelID:      sess.ChannelID,
		ThreadID:       convoID,
		GmessagesMsgID: msgID,
		Text:           text,
		SentAt:         libgmTimestampToTime(wm.Message.GetTimestamp()),
		SenderID:       wm.Message.GetParticipantID(),
	}

	if h.PexClient == nil {
		return
	}
	if err := h.PexClient.SendInbound(ctx, inbound); err != nil {
		logger.Warn("inbound post failed", "err", err.Error(), "gmessagesMsgId", msgID)
	}
}

// extractMessageText concatenates all MessageContent segments on a libgm
// Message. Media-only messages return "" — Phase 6+ will surface
// attachments separately.
func extractMessageText(m *gmproto.Message) string {
	var b strings.Builder
	for _, info := range m.GetMessageInfo() {
		if c := info.GetMessageContent(); c != nil {
			b.WriteString(c.GetContent())
		}
	}
	return b.String()
}

// libgmTimestampToTime converts libgm's microsecond-precision Unix
// timestamp into time.Time. Returns zero-time on a nil/zero input.
func libgmTimestampToTime(ts int64) time.Time {
	if ts <= 0 {
		return time.Now().UTC()
	}
	// libgm exposes microseconds since epoch on Message.Timestamp.
	return time.Unix(0, ts*int64(time.Microsecond)).UTC()
}

// postStateChange is fire-and-forget; failures log only.
func (h *LibgmHandler) postStateChange(ctx context.Context, pairedSessionID string, state pex.ConnectionState, errorDetail string) {
	if h.PexClient == nil {
		return
	}
	logger := log.New().With("pairedSessionId", pairedSessionID, "state", string(state))
	if err := h.PexClient.SendStateChange(ctx, pex.StateChange{
		PairedSessionID: pairedSessionID,
		State:           state,
		ErrorDetail:     errorDetail,
	}); err != nil {
		logger.Warn("state change post failed", "err", err.Error())
	}
}
