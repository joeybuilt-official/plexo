// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Package httpauth provides the HMAC verification middleware the sidecar's
// pair endpoints sit behind. Mirrors apps/api/src/middleware/hmac-service.ts:
// the Plexo API signs the request body with PLEXO_SERVICE_KEY (sha256) and
// the sidecar verifies on receive. 5-minute timestamp skew per ADR-0002.
package httpauth

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"io"
	"net/http"
	"strings"
	"time"
)

const TimestampSkew = 5 * time.Minute

type ctxKey int

const appIDKey ctxKey = 0

// AppIDFromContext returns the verified caller App-Id, set by RequireHMAC.
func AppIDFromContext(r *http.Request) string {
	if v, ok := r.Context().Value(appIDKey).(string); ok {
		return v
	}
	return ""
}

// RequireHMAC wraps next, returning 401 on signature/timestamp/header
// failure. On success the request body is replaced with a fresh reader so
// downstream handlers can re-read.
func RequireHMAC(serviceKey string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serviceKey == "" {
			http.Error(w, `{"error":{"code":"CONFIG_ERROR","message":"service auth not configured"}}`, http.StatusInternalServerError)
			return
		}

		sig := r.Header.Get("X-Plexo-Signature")
		ts := r.Header.Get("X-Plexo-Timestamp")
		appID := r.Header.Get("X-App-Id")
		if sig == "" || ts == "" || appID == "" {
			http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"missing HMAC headers"}}`, http.StatusUnauthorized)
			return
		}

		t, err := time.Parse(time.RFC3339, ts)
		if err != nil {
			http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"bad timestamp"}}`, http.StatusUnauthorized)
			return
		}
		if drift := time.Since(t); drift > TimestampSkew || drift < -TimestampSkew {
			http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"timestamp skew"}}`, http.StatusUnauthorized)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, `{"error":{"code":"BAD_REQUEST","message":"body read"}}`, http.StatusBadRequest)
			return
		}
		_ = r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(body))

		mac := hmac.New(sha256.New, []byte(serviceKey))
		mac.Write(body)
		expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
		if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(sig)), []byte(expected)) != 1 {
			http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"bad signature"}}`, http.StatusUnauthorized)
			return
		}

		ctx := r.Context()
		// Stash app id for downstream handlers.
		r2 := r.WithContext(contextWithAppID(ctx, appID))
		next.ServeHTTP(w, r2)
	})
}
