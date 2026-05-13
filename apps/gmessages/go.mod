// Plexo Google Messages connector — Go sidecar (ADR-0001).
//
// The upstream Google Messages Web protocol library is mautrix-gmessages's
// pkg/libgm package (NOT "libgmessages" as the Phase 1 design doc named it
// — the actual import path is go.mau.fi/mautrix-gmessages/pkg/libgm).
// Pinned per Phase 1 §3.6 pin policy: specific git tag, monthly bump
// cadence minimum, 5% canary for 24h with decode-error counter watch
// before broad rollout.
//
// Go 1.25 is required because mautrix-gmessages v0.2604.0 requires it.
// Bumped from Phase 3's 1.23 in lockstep with the first libgm pin.

module github.com/joeybuilt-official/plexo/apps/gmessages

go 1.25.0

require (
	github.com/google/uuid v1.6.0
	github.com/rs/zerolog v1.35.1
	go.mau.fi/mautrix-gmessages v0.2604.0
)

require (
	github.com/mattn/go-colorable v0.1.14 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	go.mau.fi/util v0.9.8 // indirect
	golang.org/x/crypto v0.50.0 // indirect
	golang.org/x/exp v0.0.0-20260410095643-746e56fc9e2f // indirect
	golang.org/x/sys v0.43.0 // indirect
	google.golang.org/protobuf v1.36.11 // indirect
)
