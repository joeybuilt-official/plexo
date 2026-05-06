// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Package pex mirrors the @plexo/sdk channel envelope types in Go (ADR-0002).
//
// The TS canonical definitions live in
// /home/dustin/dev/plexo/packages/sdk/src/types/channel.ts. JSON field names
// here MUST match the TS encoder output exactly so a fixture written by one
// side parses cleanly on the other; the round-trip compat test in
// types_compat_test.go enforces this.
//
// When the TS side adds a field, mirror it here in the same commit, refresh
// the fixture under apps/gmessages/testdata/fixtures, and re-run
// `go test ./internal/pex/...`.
package pex

import "time"

// PexVersion is the Pex protocol version this sidecar speaks. Plexo SPEC is
// pinned at 0.4.0 per Phase 1 cross-conflict C7; the subscription contract
// (ADR-0002) is host-side surface, not a SPEC bump.
const PexVersion = "0.4.0"

// ChannelType mirrors the TS ChannelType union. Adding a value requires the
// matching channel_type Postgres enum extension (see migration 0116).
type ChannelType string

const (
	ChannelTypeGmessages ChannelType = "gmessages"
)

// ConnectionState mirrors plexo_gmessages.paired_session_state.
type ConnectionState string

const (
	StatePaired     ConnectionState = "paired"
	StateActive     ConnectionState = "active"
	StateRefreshing ConnectionState = "refreshing"
	StateExpired    ConnectionState = "expired"
	StateRevoked    ConnectionState = "revoked"
	StateErrored    ConnectionState = "errored"
)

// MessageDirection mirrors the TS ChannelMessage.direction field.
type MessageDirection string

const (
	DirectionInbound  MessageDirection = "inbound"
	DirectionOutbound MessageDirection = "outbound"
)

// ChannelAttachmentRef matches @plexo/sdk ChannelAttachmentRef.
type ChannelAttachmentRef struct {
	ID          string `json:"id"`
	MimeType    string `json:"mimeType,omitempty"`
	Filename    string `json:"filename,omitempty"`
	SizeBytes   int64  `json:"sizeBytes,omitempty"`
	ThumbnailID string `json:"thumbnailId,omitempty"`
}

// ChannelMessage matches @plexo/sdk ChannelMessage.
//
// SentAt is encoded as RFC3339 (`time.Time` MarshalJSON default) to match
// the TS ISO-8601 string contract.
type ChannelMessage struct {
	ID          string                 `json:"id"`
	ChannelID   string                 `json:"channelId"`
	ThreadID    string                 `json:"threadId"`
	Direction   MessageDirection       `json:"direction"`
	Text        string                 `json:"text"`
	Attachments []ChannelAttachmentRef `json:"attachments,omitempty"`
	SenderID    string                 `json:"senderId"`
	SenderName  string                 `json:"senderName,omitempty"`
	SentAt      time.Time              `json:"sentAt"`
	Metadata    map[string]any         `json:"metadata,omitempty"`
	PexVersion  string                 `json:"pexVersion"`
}

// ChannelEventType mirrors the TS ChannelEvent discriminator.
type ChannelEventType string

const (
	EventMessageReceived         ChannelEventType = "message.received"
	EventMessageSent             ChannelEventType = "message.sent"
	EventConnectionStateChanged  ChannelEventType = "connection.state_changed"
)

// ChannelEvent is the union sent over the SSE subscription stream and the
// connector→Plexo inbound POST.
type ChannelEvent struct {
	Type       ChannelEventType `json:"type"`
	ChannelID  string           `json:"channelId"`
	ThreadID   string           `json:"threadId,omitempty"`
	Message    *ChannelMessage  `json:"message,omitempty"`
	State      ConnectionState  `json:"state,omitempty"`
	PexVersion string           `json:"pexVersion"`
}

// InboundAttachment is the optional attachment ref carried on
// ChannelInbound. Phase 5 surfaces only what libgm exposes synchronously
// in the WrappedMessage event; attachment fetch/decrypt/re-upload is
// Phase 6+.
type InboundAttachment struct {
	URL      string `json:"url"`
	MimeType string `json:"mimeType,omitempty"`
	Filename string `json:"filename,omitempty"`
}

// ChannelInbound is the connector→Plexo inbound envelope posted to
// /api/plexo/channels/gmessages/inbound. Phase 5 wires the message
// normalization pipeline; Phase 3's skeleton just exercises the surface.
//
// SenderID and Attachments are optional per the Phase 5 frozen envelope
// contract. The Plexo API ignores unknown fields, so adding them ahead of
// the API-side consumer is safe.
type ChannelInbound struct {
	WorkspaceID    string              `json:"workspaceId"`
	ChannelID      string              `json:"channelId"`
	ThreadID       string              `json:"threadId"`
	GmessagesMsgID string              `json:"gmessagesMsgId"`
	Text           string              `json:"text"`
	SentAt         time.Time           `json:"sentAt"`
	SenderID       string              `json:"senderId,omitempty"`
	Attachments    []InboundAttachment `json:"attachments,omitempty"`
}

// StateChange is the connector→Plexo state-transition envelope posted to
// /api/plexo/channels/gmessages/state.
type StateChange struct {
	PairedSessionID string          `json:"pairedSessionId"`
	State           ConnectionState `json:"state"`
	ErrorDetail     string          `json:"errorDetail,omitempty"`
}

// Heartbeat is the flow-heartbeat envelope posted to
// /api/plexo/channels/gmessages/heartbeat (ADR-0004 layered liveness).
type Heartbeat struct {
	PairedSessionID  string    `json:"pairedSessionId"`
	LastInboundAt    time.Time `json:"lastInboundAt,omitempty"`
	DecodeErrorCount int       `json:"decodeErrorCount"`
}
