// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

package pair

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
)

// pairStartResponse is the wire shape of POST /pair/start.
type pairStartResponse struct {
	PairingID string `json:"pairingId"`
	QRURL     string `json:"qrUrl"`
	ExpiresAt string `json:"expiresAt"` // RFC3339
}

// pairStatusResponse is the wire shape of GET /pair/status?id=…
//
// AuthBlob is included only when State=linked; it is base64-encoded JSON of
// the libgm AuthData. The Plexo API encrypts via crypto-util.ts AES-256-GCM
// before persisting to installed_connections.credentials.
type pairStatusResponse struct {
	PairingID   string `json:"pairingId"`
	State       string `json:"state"`
	AuthBlob    string `json:"authBlob,omitempty"`
	ErrorDetail string `json:"errorDetail,omitempty"`
	ExpiresAt   string `json:"expiresAt"`
}

// Handler returns an http.Handler that serves /pair/start, /pair/status,
// /pair/discard. Caller is responsible for wrapping it in HMAC auth.
func (m *Manager) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/pair/start", m.handleStart)
	mux.HandleFunc("/pair/status", m.handleStatus)
	mux.HandleFunc("/pair/discard", m.handleDiscard)
	return mux
}

func (m *Manager) handleStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":{"code":"METHOD_NOT_ALLOWED"}}`, http.StatusMethodNotAllowed)
		return
	}
	p, err := m.Start(r.Context())
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": map[string]string{"code": "PAIR_START_FAILED", "message": err.Error()},
		})
		return
	}
	writeJSON(w, http.StatusOK, pairStartResponse{
		PairingID: p.ID,
		QRURL:     p.QRURL,
		ExpiresAt: p.ExpiresAt.UTC().Format(rfc3339),
	})
}

func (m *Manager) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":{"code":"METHOD_NOT_ALLOWED"}}`, http.StatusMethodNotAllowed)
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, `{"error":{"code":"BAD_REQUEST","message":"id required"}}`, http.StatusBadRequest)
		return
	}
	snap, blob, ok := m.Status(id)
	if !ok {
		http.Error(w, `{"error":{"code":"NOT_FOUND"}}`, http.StatusNotFound)
		return
	}
	resp := pairStatusResponse{
		PairingID:   snap.ID,
		State:       string(snap.State),
		ErrorDetail: snap.ErrorDetail,
		ExpiresAt:   snap.ExpiresAt.UTC().Format(rfc3339),
	}
	if snap.State == StateLinked && len(blob) > 0 {
		resp.AuthBlob = base64.StdEncoding.EncodeToString(blob)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (m *Manager) handleDiscard(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":{"code":"METHOD_NOT_ALLOWED"}}`, http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		PairingID string `json:"pairingId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.PairingID == "" {
		http.Error(w, `{"error":{"code":"BAD_REQUEST","message":"pairingId required"}}`, http.StatusBadRequest)
		return
	}
	m.Discard(body.PairingID)
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

const rfc3339 = "2006-01-02T15:04:05Z07:00"
