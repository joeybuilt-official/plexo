// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Package liveness implements the layered probe schedule from ADR-0004:
//
//	Process health   10s   /health HTTP                  (the supervisor owns this)
//	Library probe    30s   libgmessages.Session.Ping()   (Phase 4 wires)
//	Flow heartbeat   60s   last-inbound + decode-error   (this package)
//
// The flow heartbeat is the truth signal Plexo Core's stale-session
// monitor reads, NOT the library probe. Mira's panel position prevailed
// (Phase 1 cross-conflict C5).
package liveness

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/log"
	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/pex"
)

// Counters is the per-session liveness state the connector's session
// goroutines update on each inbound libgmessages event. The HeartbeatLoop
// reads these and posts to /api/plexo/channels/gmessages/heartbeat.
type Counters struct {
	LastInboundAt    atomic.Int64 // Unix nanos
	DecodeErrorCount atomic.Int32
}

// MarkInbound is called from the session goroutine on each successfully
// decoded inbound event.
func (c *Counters) MarkInbound() {
	c.LastInboundAt.Store(time.Now().UnixNano())
}

// MarkDecodeError is called from the session goroutine on each decode
// failure (UTF-8 invalid, unknown action codes, etc — Mira's pattern).
func (c *Counters) MarkDecodeError() {
	c.DecodeErrorCount.Add(1)
}

// HeartbeatLoop posts a flow heartbeat for the given paired-session every
// `every` duration until ctx is cancelled. Phase 4 will call this once per
// active session goroutine.
func HeartbeatLoop(ctx context.Context, client *pex.Client, pairedSessionID string, c *Counters, every time.Duration) {
	logger := log.New().With("pairedSessionId", pairedSessionID)

	t := time.NewTicker(every)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			hb := pex.Heartbeat{
				PairedSessionID:  pairedSessionID,
				LastInboundAt:    time.Unix(0, c.LastInboundAt.Load()).UTC(),
				DecodeErrorCount: int(c.DecodeErrorCount.Load()),
			}
			if err := client.SendHeartbeat(ctx, hb); err != nil {
				logger.Warn("heartbeat post failed", "err", err.Error())
			}
		}
	}
}
