// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Package cryptosvc decrypts workspace-scoped credentials produced by
// apps/api/src/crypto.ts. Same algorithm — AES-256-GCM with a workspace-
// derived key — so the sidecar can read libgm AuthData blobs directly
// without round-tripping through the Plexo API for decryption (which
// would require giving the API the AuthData in plaintext just to hand
// it back).
//
// Format produced by Node side (crypto-util.ts):
//
//	enc:<b64url(iv)>.<b64url(ciphertext)>.<b64url(authTag)>
//
// Key derivation:
//
//	key = HMAC-SHA256(ENCRYPTION_SECRET, workspaceId)
//
// AES-256-GCM: 12-byte IV, 16-byte auth tag.
package cryptosvc

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

const prefix = "enc:"

// Decrypt parses the Node-side envelope and returns the plaintext bytes.
// rootKey is the ENCRYPTION_SECRET (same string both Node and Go read);
// workspaceID is the per-workspace HKDF input.
func Decrypt(token, rootKey, workspaceID string) ([]byte, error) {
	raw := strings.TrimPrefix(token, prefix)
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return nil, errors.New("cryptosvc: invalid token format — expected 3 dot-separated parts")
	}

	iv, err := decodeB64URL(parts[0])
	if err != nil {
		return nil, fmt.Errorf("cryptosvc: iv decode: %w", err)
	}
	ct, err := decodeB64URL(parts[1])
	if err != nil {
		return nil, fmt.Errorf("cryptosvc: ciphertext decode: %w", err)
	}
	tag, err := decodeB64URL(parts[2])
	if err != nil {
		return nil, fmt.Errorf("cryptosvc: tag decode: %w", err)
	}

	key := deriveKey(rootKey, workspaceID)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("cryptosvc: aes: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("cryptosvc: gcm: %w", err)
	}

	// Go's gcm.Open expects ciphertext || tag concatenated.
	combined := make([]byte, 0, len(ct)+len(tag))
	combined = append(combined, ct...)
	combined = append(combined, tag...)

	plain, err := gcm.Open(nil, iv, combined, nil)
	if err != nil {
		return nil, fmt.Errorf("cryptosvc: open: %w", err)
	}
	return plain, nil
}

func deriveKey(rootKey, workspaceID string) []byte {
	mac := hmac.New(sha256.New, []byte(rootKey))
	mac.Write([]byte(workspaceID))
	return mac.Sum(nil)
}

func decodeB64URL(s string) ([]byte, error) {
	// Node side strips padding; Go's RawURLEncoding handles that.
	return base64.RawURLEncoding.DecodeString(s)
}
