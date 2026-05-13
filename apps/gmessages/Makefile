# Plexo Google Messages connector — Go sidecar.
#
# Local dev requires Go 1.23+. For environments without local Go, use
# `make docker-dev` to build + run via the Dockerfile.

GO ?= go
BIN := bin/gmessages
PKG := ./cmd/gmessages

.PHONY: dev build test vet tidy clean docker-build docker-dev

dev:
	@$(GO) run $(PKG)

build:
	@mkdir -p bin
	@CGO_ENABLED=0 $(GO) build -trimpath -ldflags="-s -w" -o $(BIN) $(PKG)

test:
	@$(GO) test ./...

vet:
	@$(GO) vet ./...

tidy:
	@$(GO) mod tidy

clean:
	@rm -rf bin dist

docker-build:
	@docker build -t plexo-gmessages -f docker/Dockerfile ../..

docker-dev: docker-build
	@docker run --rm -e PLEXO_SERVICE_KEY=$$PLEXO_SERVICE_KEY \
	  -e GMESSAGES_MASTER_KEY=$$ENCRYPTION_SECRET \
	  -p 3010:3010 plexo-gmessages
