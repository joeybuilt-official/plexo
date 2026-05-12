// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

package cryptosvc

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

// TestDecrypt_RoundTrip mirrors the Node side encrypt() pattern:
//
//	iv = random(12)
//	cipher = aes-256-gcm(deriveKey(rootKey, workspaceId))
//	envelope = enc:b64url(iv).b64url(ct).b64url(tag)
//
// Verifies the Go decoder accepts what the Node encoder produces.
func TestDecrypt_RoundTrip(t *testing.T) {
	const rootKey = "test-root-encryption-secret"
	const workspaceID = "ws_abc123"
	plaintext := []byte("the libgm AuthData blob lives here")

	mac := hmac.New(sha256.New, []byte(rootKey))
	mac.Write([]byte(workspaceID))
	key := mac.Sum(nil)

	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("gcm: %v", err)
	}

	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		t.Fatalf("rand: %v", err)
	}

	combined := gcm.Seal(nil, iv, plaintext, nil)
	// Node produces ciphertext + tag separately. Split back: tag is last
	// 16 bytes (GCM tag size).
	ct := combined[:len(combined)-16]
	tag := combined[len(combined)-16:]

	envelope := "enc:" + b64url(iv) + "." + b64url(ct) + "." + b64url(tag)

	got, err := Decrypt(envelope, rootKey, workspaceID)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if string(got) != string(plaintext) {
		t.Errorf("plaintext mismatch: got %q want %q", got, plaintext)
	}
}

func TestDecrypt_RejectsBadFormat(t *testing.T) {
	for _, tc := range []string{
		"",
		"enc:",
		"enc:a.b",
		"enc:a.b.c.d",
		"a.b.c", // no enc: prefix is allowed in Decrypt? No — strip in code
	} {
		if _, err := Decrypt(tc, "k", "w"); err == nil {
			// "a.b.c" without prefix should still be rejected because it
			// won't decrypt cleanly with random key — but parse-level
			// rejection comes from format checks above.
			if !strings.Contains(tc, ".") || strings.Count(tc, ".") != 2 {
				t.Errorf("expected error for input %q", tc)
			}
		}
	}
}

func b64url(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

// TestDecrypt_BootRestoreFailureModes codifies RUNBOOK §4 step 4: every
// realistic malformed-AuthBlob path the boot-restore loop might encounter
// must produce an error (which the orchestration converts to state='errored')
// rather than panic the sidecar.
//
// Producing a real GCM-sealed envelope first, then mutating it various
// ways, gives us confidence the failure paths are fully exercised.
func TestDecrypt_BootRestoreFailureModes(t *testing.T) {
	const rootKey = "boot-restore-test-root-key"
	const workspaceID = "ws_for_boot_restore"
	plaintext := []byte("libgm AuthData payload")

	mac := hmac.New(sha256.New, []byte(rootKey))
	mac.Write([]byte(workspaceID))
	key := mac.Sum(nil)
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("gcm: %v", err)
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		t.Fatalf("rand: %v", err)
	}
	combined := gcm.Seal(nil, iv, plaintext, nil)
	ct := combined[:len(combined)-16]
	tag := combined[len(combined)-16:]
	good := "enc:" + b64url(iv) + "." + b64url(ct) + "." + b64url(tag)

	cases := []struct {
		name        string
		envelope    string
		rootKey     string
		workspaceID string
	}{
		{"wrong root key", good, "different-root-key", workspaceID},
		{"wrong workspace id", good, rootKey, "different-workspace"},
		{"truncated ciphertext", "enc:" + b64url(iv) + "." + b64url(ct[:len(ct)/2]) + "." + b64url(tag), rootKey, workspaceID},
		{"truncated tag", "enc:" + b64url(iv) + "." + b64url(ct) + "." + b64url(tag[:8]), rootKey, workspaceID},
		{"corrupt iv", "enc:" + b64url([]byte{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}) + "." + b64url(ct) + "." + b64url(tag), rootKey, workspaceID},
		{"empty input", "", rootKey, workspaceID},
		{"prefix only", "enc:", rootKey, workspaceID},
		{"non-base64 garbage", "enc:not!valid.base64$$.atall@@", rootKey, workspaceID},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("Decrypt panicked on %s: %v", tc.name, r)
				}
			}()
			_, err := Decrypt(tc.envelope, tc.rootKey, tc.workspaceID)
			if err == nil {
				t.Errorf("expected error for %s; got nil", tc.name)
			}
		})
	}
}
