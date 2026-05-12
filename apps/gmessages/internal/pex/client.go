// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

package pex

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client posts envelopes to Plexo Core's connector-facing routes
// (/api/plexo/channels/gmessages/*). HMAC body signature + X-App-Id +
// X-Plexo-Timestamp matches the contract enforced by
// apps/api/src/middleware/hmac-service.ts.
type Client struct {
	BaseURL    string
	ServiceKey string
	AppID      string
	HTTP       *http.Client
}

// NewClient returns a Client with a sane default HTTP timeout.
func NewClient(baseURL, serviceKey, appID string) *Client {
	return &Client{
		BaseURL:    baseURL,
		ServiceKey: serviceKey,
		AppID:      appID,
		HTTP: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// SendInbound posts a ChannelInbound envelope.
func (c *Client) SendInbound(ctx context.Context, in ChannelInbound) error {
	return c.post(ctx, "/api/plexo/channels/gmessages/inbound", in, nil)
}

// SendStateChange posts a StateChange envelope.
func (c *Client) SendStateChange(ctx context.Context, sc StateChange) error {
	return c.post(ctx, "/api/plexo/channels/gmessages/state", sc, nil)
}

// SendHeartbeat posts a Heartbeat envelope.
func (c *Client) SendHeartbeat(ctx context.Context, hb Heartbeat) error {
	return c.post(ctx, "/api/plexo/channels/gmessages/heartbeat", hb, nil)
}

// RestoreEntry is the wire shape of one element in the restore-list
// response — one row per paired session in state IN ('active','refreshing').
type RestoreEntry struct {
	PairedSessionID   string `json:"pairedSessionId"`
	WorkspaceID       string `json:"workspaceId"`
	ChannelID         string `json:"channelId"`
	EncryptedAuthBlob string `json:"encryptedAuthBlob"`
}

// FetchRestoreList GETs the list of paired sessions the sidecar should
// re-establish on boot (ADR-0004 §"Restart semantics").
func (c *Client) FetchRestoreList(ctx context.Context) ([]RestoreEntry, error) {
	var out struct {
		Entries []RestoreEntry `json:"entries"`
	}
	if err := c.get(ctx, "/api/plexo/channels/gmessages/restore-list", &out); err != nil {
		return nil, err
	}
	return out.Entries, nil
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return fmt.Errorf("pex: new request: %w", err)
	}

	mac := hmac.New(sha256.New, []byte(c.ServiceKey))
	mac.Write(nil) // empty body matches Node-side hmac-service.ts treatment of bodyless requests
	req.Header.Set("X-App-Id", c.AppID)
	req.Header.Set("X-Plexo-Timestamp", time.Now().UTC().Format(time.RFC3339))
	req.Header.Set("X-Plexo-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("pex: do: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		detail, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("pex: GET %s -> %d: %s", path, resp.StatusCode, string(detail))
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return fmt.Errorf("pex: decode: %w", err)
		}
	}
	return nil
}

func (c *Client) post(ctx context.Context, path string, payload any, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("pex: marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("pex: new request: %w", err)
	}

	mac := hmac.New(sha256.New, []byte(c.ServiceKey))
	mac.Write(body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-App-Id", c.AppID)
	req.Header.Set("X-Plexo-Timestamp", time.Now().UTC().Format(time.RFC3339))
	req.Header.Set("X-Plexo-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("pex: do: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		detail, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("pex: %s %s -> %d: %s", req.Method, path, resp.StatusCode, string(detail))
	}

	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return fmt.Errorf("pex: decode: %w", err)
		}
	}
	return nil
}
