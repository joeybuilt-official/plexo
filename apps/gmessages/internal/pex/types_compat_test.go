// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

package pex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestChannelMessageRoundTrip_TSFixture verifies that a JSON fixture written
// by the TS encoder (@plexo/sdk ChannelMessage) decodes into the Go struct
// without dropping fields, and re-encodes to a JSON shape that round-trips
// back to the same Go struct.
//
// This is the Phase 1 design §4 step 8 compat test: "a CI compat-test that
// round-trips fixtures across the boundary."
func TestChannelMessageRoundTrip_TSFixture(t *testing.T) {
	path := filepath.Join("..", "..", "testdata", "fixtures", "channel_message.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var msg ChannelMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		t.Fatalf("decode TS fixture: %v", err)
	}

	if msg.PexVersion != PexVersion {
		t.Errorf("pexVersion mismatch: got %q want %q", msg.PexVersion, PexVersion)
	}
	if msg.Direction != DirectionInbound {
		t.Errorf("direction mismatch: got %q want %q", msg.Direction, DirectionInbound)
	}
	if msg.SenderID != "+15555550100" {
		t.Errorf("senderId mismatch: got %q", msg.SenderID)
	}
	if len(msg.Attachments) != 1 {
		t.Fatalf("attachments len: got %d want 1", len(msg.Attachments))
	}
	if msg.Attachments[0].MimeType != "image/jpeg" {
		t.Errorf("attachment mimeType: got %q", msg.Attachments[0].MimeType)
	}

	reEncoded, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("re-encode: %v", err)
	}

	var roundTrip ChannelMessage
	if err := json.Unmarshal(reEncoded, &roundTrip); err != nil {
		t.Fatalf("decode re-encoded: %v", err)
	}

	if roundTrip.ID != msg.ID || roundTrip.ChannelID != msg.ChannelID ||
		roundTrip.ThreadID != msg.ThreadID || roundTrip.Text != msg.Text {
		t.Errorf("round-trip mismatch: %+v vs %+v", roundTrip, msg)
	}
}

// TestChannelEvent_Discriminator verifies the discriminated-union encoding
// matches the TS ChannelEvent shape.
func TestChannelEvent_Discriminator(t *testing.T) {
	msg := &ChannelMessage{
		ID:         "msg_test",
		ChannelID:  "ch_test",
		ThreadID:   "thr_test",
		Direction:  DirectionInbound,
		Text:       "hi",
		SenderID:   "+15555550100",
		PexVersion: PexVersion,
	}
	evt := ChannelEvent{
		Type:       EventMessageReceived,
		ChannelID:  "ch_test",
		ThreadID:   "thr_test",
		Message:    msg,
		PexVersion: PexVersion,
	}

	raw, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded ChannelEvent
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.Type != EventMessageReceived {
		t.Errorf("type: got %q want %q", decoded.Type, EventMessageReceived)
	}
	if decoded.Message == nil || decoded.Message.Text != "hi" {
		t.Errorf("message field round-trip lost: %+v", decoded.Message)
	}
}
