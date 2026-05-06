// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Package health serves the connector's /health endpoint. Coolify polls
// this every 10 seconds (ADR-0004 layered liveness — "Process health"
// row). The library probe (libgmessages.Ping) and the flow heartbeat
// (last-inbound + decode-error counter) live in package liveness because
// they belong to the connector→Plexo direction, not to the supervisor's
// keepalive.
package health

import (
	"encoding/json"
	"net/http"
	"time"
)

type Probe struct {
	StartedAt time.Time
	Active    func() int // returns active session count
}

func (p Probe) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":         true,
			"service":    "plexo-gmessages",
			"uptimeSec":  int(time.Since(p.StartedAt).Seconds()),
			"activeSessions": p.Active(),
		})
	}
}
