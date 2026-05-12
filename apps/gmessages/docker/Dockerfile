# Plexo Google Messages connector — multi-stage Go build.
# Pinned to Go 1.25 (matches go.mod). Bumped in lockstep with the
# libgm bump runbook (Phase 6 ops). Phase 4 raised this from 1.23 → 1.25
# because go.mau.fi/mautrix-gmessages v0.2604.0 requires Go ≥1.25.

# ---- builder ---------------------------------------------------------------
FROM golang:1.25-alpine AS builder

WORKDIR /src
RUN apk add --no-cache git ca-certificates

# Cache go.mod/go.sum layer for faster rebuilds.
COPY apps/gmessages/go.mod ./apps/gmessages/
# go.sum may not exist yet on Phase 3 skeleton; tolerate either case.
COPY apps/gmessages/go.sum* ./apps/gmessages/

WORKDIR /src/apps/gmessages
RUN go mod download || true

COPY apps/gmessages/ ./

# Static, stripped binary — runs in scratch.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/gmessages ./cmd/gmessages

# ---- runtime ---------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /out/gmessages /gmessages

# Default port matches main.go's defaultPort. Override via PORT env.
EXPOSE 3010

USER nonroot:nonroot
ENTRYPOINT ["/gmessages"]
