// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Plexo Google Messages connector — Go sidecar entrypoint.
//
// Phase 4b: real libgm-backed session.Handler, pair lifecycle endpoints,
// and boot-time session restoration. On startup the sidecar fetches the
// list of paired sessions in state IN ('active','refreshing') from
// Plexo Core's /api/plexo/channels/gmessages/restore-list, decrypts the
// per-workspace AuthData blob locally, and calls session.Manager.Start
// for each — re-establishing the long-lived libgm.Client without
// requiring the user to re-pair.
package main

import (
	"context"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/rs/zerolog"

	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/cryptosvc"
	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/health"
	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/httpauth"
	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/log"
	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/pair"
	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/pex"
	"github.com/joeybuilt-official/plexo/apps/gmessages/internal/session"
)

const version = "0.0.5-phase-6-ops"

const (
	defaultPort      = "3010"
	defaultPlexoBase = "http://api:3001"
	appID            = "gmessages-sidecar"
)

func main() {
	probeFlag := flag.Bool("healthcheck", false, "probe /health on localhost and exit (Docker HEALTHCHECK target)")
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *versionFlag {
		fmt.Println(version)
		return
	}
	if *probeFlag {
		os.Exit(runHealthcheckProbe())
	}

	logger := log.New()
	logger.Info("plexo-gmessages booting", "version", version)

	cfg := loadConfig(logger)

	pexClient := pex.NewClient(cfg.PlexoBaseURL, cfg.ServiceKey.Reveal(), appID)
	zlog := zerolog.New(os.Stderr).Level(zerolog.WarnLevel)
	handler := &session.LibgmHandler{PexClient: pexClient, Zerolog: zlog}
	manager := session.NewManager([]byte(cfg.MasterKey.Reveal()), handler, pexClient)
	pairMgr := pair.NewManager(zlog)

	mux := http.NewServeMux()
	probe := health.Probe{
		StartedAt: time.Now(),
		Active:    manager.Active,
	}
	mux.Handle("/health", probe.Handler())
	mux.Handle("/pair/", httpauth.RequireHMAC(cfg.ServiceKey.Reveal(), pairMgr.Handler()))
	mux.Handle("/sessions/", httpauth.RequireHMAC(cfg.ServiceKey.Reveal(), manager.Handler()))

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	go func() {
		logger.Info("http listener up", "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http listen failed", "err", err.Error())
			cancel()
		}
	}()

	// Phase 6: synchronous HMAC self-check. A persistent 401 against Plexo
	// Core means PLEXO_SERVICE_KEY is wrong on the sidecar relative to the
	// api container — RUNBOOK §4 footgun. Exit 1 here rather than emit 401
	// storms during normal session work.
	runStartupSelfCheck(ctx, cfg, logger)

	if cfg.SyntheticBoot {
		go runSyntheticBoot(ctx, cfg, logger)
	}

	// Boot restore (ADR-0004 §"Restart semantics"): fetch all paired
	// sessions in state IN ('active','refreshing') from Plexo Core, decrypt
	// their AuthBlobs, and re-Start each in the session manager so the
	// long-poll connection re-establishes without user intervention.
	go runBootRestore(ctx, cfg, manager, logger)

	<-ctx.Done()
	logger.Info("shutting down")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("http shutdown failed", "err", err.Error())
	}
}

type Config struct {
	Port          string
	PlexoBaseURL  string
	ServiceKey    log.Secret
	MasterKey     log.Secret
	SyntheticBoot bool
}

func loadConfig(logger *slog.Logger) Config {
	c := Config{
		Port:          envOr("PORT", defaultPort),
		PlexoBaseURL:  envOr("PLEXO_BASE_URL", defaultPlexoBase),
		ServiceKey:    log.Secret(os.Getenv("PLEXO_SERVICE_KEY")),
		MasterKey:     log.Secret(envOr("GMESSAGES_MASTER_KEY", os.Getenv("ENCRYPTION_SECRET"))),
		SyntheticBoot: os.Getenv("GMESSAGES_SYNTHETIC_BOOT") == "1",
	}
	if c.ServiceKey == "" {
		logger.Error("PLEXO_SERVICE_KEY required")
		os.Exit(1)
	}
	if c.MasterKey == "" {
		logger.Error("GMESSAGES_MASTER_KEY (or ENCRYPTION_SECRET) required")
		os.Exit(1)
	}
	return c
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// runHealthcheckProbe is the binary's self-probe used as the Docker
// HEALTHCHECK target. Distroless images have no shell or curl; the
// binary calling itself is the canonical pattern.
func runHealthcheckProbe() int {
	port := envOr("PORT", defaultPort)
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/health")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

// runStartupSelfCheck does an HMAC-authed GET against Plexo Core before
// any session work begins. A persistent HTTP 401 means the sidecar's
// PLEXO_SERVICE_KEY doesn't match the api container's value (RUNBOOK §4).
// We exit 1 with a fix-pointer rather than scroll the operator through
// 401 storms.
//
// Network errors / timeouts / 5xx are treated as "api still booting" —
// we retry within a 20s budget. After that the main boot-restore
// goroutine handles natural retry.
func runStartupSelfCheck(ctx context.Context, cfg Config, logger *slog.Logger) {
	client := pex.NewClient(cfg.PlexoBaseURL, cfg.ServiceKey.Reveal(), appID)

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return
		}
		attemptCtx, cancelAttempt := context.WithTimeout(ctx, 4*time.Second)
		_, err := client.FetchRestoreList(attemptCtx)
		cancelAttempt()
		if err == nil {
			logger.Info("startup HMAC self-check passed")
			return
		}
		if strings.Contains(err.Error(), "-> 401:") {
			logger.Error("startup HMAC self-check failed: HTTP 401",
				"fix", "PLEXO_SERVICE_KEY must match the api container's value",
				"verify", "docker compose exec gmessages env | grep PLEXO_SERVICE_KEY")
			os.Exit(1)
		}
		time.Sleep(3 * time.Second)
	}
	logger.Warn("startup HMAC self-check inconclusive (no 401 but no success in 20s); continuing")
}

// runBootRestore re-establishes long-poll connections for every paired
// session Plexo Core reports in state IN ('active','refreshing'). The
// sidecar holds ENCRYPTION_SECRET (via GMESSAGES_MASTER_KEY env, see
// loadConfig) so per-workspace decryption happens locally — Plexo API
// never returns the plaintext AuthData blob.
//
// Failures decrypt-side or libgm-side post a state change to errored on
// that paired session and continue with the rest. ADR-0004 §"Restart
// semantics."
func runBootRestore(ctx context.Context, cfg Config, mgr *session.Manager, logger *slog.Logger) {
	// Brief delay so the api container is reachable when started together.
	select {
	case <-ctx.Done():
		return
	case <-time.After(3 * time.Second):
	}

	client := pex.NewClient(cfg.PlexoBaseURL, cfg.ServiceKey.Reveal(), appID)
	entries, err := client.FetchRestoreList(ctx)
	if err != nil {
		logger.Warn("boot restore: fetch list failed", "err", err.Error())
		return
	}
	logger.Info("boot restore: rehydrating sessions", "count", len(entries))

	for _, entry := range entries {
		blob, err := cryptosvc.Decrypt(entry.EncryptedAuthBlob, cfg.MasterKey.Reveal(), entry.WorkspaceID)
		if err != nil {
			logger.Warn("boot restore: decrypt failed",
				"pairedSessionId", entry.PairedSessionID,
				"err", err.Error())
			postRestoreFailure(ctx, client, entry.PairedSessionID, "decrypt: "+err.Error())
			continue
		}

		// AuthBlob from /pair-status came base64-encoded into the API; we
		// stored it as that base64 string inside the encrypted envelope.
		// Decode here so the Handler unmarshals the raw JSON.
		raw, err := decodeAuthBlobBase64(blob)
		if err != nil {
			logger.Warn("boot restore: blob base64 decode failed",
				"pairedSessionId", entry.PairedSessionID,
				"err", err.Error())
			postRestoreFailure(ctx, client, entry.PairedSessionID, "blob decode: "+err.Error())
			continue
		}

		if err := mgr.Start(ctx, entry.WorkspaceID, entry.PairedSessionID, entry.ChannelID, raw); err != nil {
			logger.Warn("boot restore: manager.Start failed",
				"pairedSessionId", entry.PairedSessionID,
				"err", err.Error())
			postRestoreFailure(ctx, client, entry.PairedSessionID, "start: "+err.Error())
			continue
		}
	}
}

func postRestoreFailure(ctx context.Context, client *pex.Client, pairedSessionID, detail string) {
	_ = client.SendStateChange(ctx, pex.StateChange{
		PairedSessionID: pairedSessionID,
		State:           pex.StateErrored,
		ErrorDetail:     detail,
	})
}

// decodeAuthBlobBase64 reverses the base64-encode the sidecar applied in
// internal/pair/http.go before handing the blob to the Plexo API. The API
// stored the base64 string inside its encrypted envelope unchanged.
func decodeAuthBlobBase64(b64 []byte) ([]byte, error) {
	s := strings.TrimSpace(string(b64))
	return base64.StdEncoding.DecodeString(s)
}

// runSyntheticBoot posts a single ChannelInbound stub to Plexo Core. It
// is the Phase 3 end-to-end smoke test — proves HMAC headers, JSON
// encoding, and route mounting are all correct without requiring a real
// paired phone. Phase 4 removes this scaffold.
func runSyntheticBoot(ctx context.Context, cfg Config, logger *slog.Logger) {
	client := pex.NewClient(cfg.PlexoBaseURL, cfg.ServiceKey.Reveal(), appID)

	// Wait briefly for Plexo Core to be ready when launched together.
	select {
	case <-ctx.Done():
		return
	case <-time.After(5 * time.Second):
	}

	inbound := pex.ChannelInbound{
		WorkspaceID:    os.Getenv("GMESSAGES_SYNTHETIC_WORKSPACE_ID"),
		ChannelID:      os.Getenv("GMESSAGES_SYNTHETIC_CHANNEL_ID"),
		ThreadID:       "+15555550100",
		GmessagesMsgID: "synthetic-boot-" + time.Now().UTC().Format("20060102T150405"),
		Text:           "Phase 3 synthetic boot event",
		SentAt:         time.Now().UTC(),
	}
	if err := client.SendInbound(ctx, inbound); err != nil {
		logger.Warn("synthetic boot inbound failed", "err", err.Error())
		return
	}
	logger.Info("synthetic boot inbound posted")
}
