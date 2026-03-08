# AGENTS.md — Plexo Inference Gateway

## What This Is
Plexo Inference Gateway is the server-side proxy that sits between self-hosted Plexo instances and upstream LLM providers (Anthropic, OpenAI, Groq, Together, DeepSeek). It enables Mode 3 of Plexo's model selection system so users can route inference through Plexo's managed pool via a single Plexo API key.

## Architecture
- **Monorepo Structure**: Pnpm workspace containing two main packages:
  - `gateway`: Express 5 REST API handling routing, quota, authentication, and validation.
  - `admin`: Next.js 15 (App Router) admin dashboard for usage analytics and key management.
- **Database**: PostgreSQL 16 accessed via Drizzle ORM.
- **Caching/Rate Limiting**: Valkey (Redis-compatible).
- **Deployment**: Docker Compose on a fresh Hetzner VPS (Ubuntu 24.04 LTS), behind a Caddy reverse proxy providing TLS.

## Core Security Posture
1. **Key + Instance Binding**: Keys are strictly associated with unique instance IDs.
2. **Envelope Validation**: Proprietary payload envelope mandatory. Raw upstream payload shapes (e.g. standard OpenAI chat completions) are rejected.
3. **Signed Instances**: Valid `X-Plexo-Signature` HMAC header is required, featuring a 5-minute replay-prevention window.
4. **Upstream Keys Isolation**: Upstream provider keys exist strictly in environment variables on the gateway. Never returned to callers.
5. **Private Admin Routing**: Admin panel is served on a separate subdomain (configured via `ADMIN_URL`) with a `noindex` policy. Authentication is via a single admin user through Auth.js v5.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-07 | Express 5 for Gateway | Fast, simple native async handlers, and mature middleware ecosystem without the overhead of Next.js server components |
| 2026-03-07 | Next.js 15 for Admin  | Admin leverages Next.js ecosystem for rapid internal tool building (shadcn/ui + React Server Actions) |
| 2026-03-07 | Caddy Reverse Proxy | Automatic TLS certificates simplify deployment and renewal for multiple subdomains |
| 2026-03-07 | Drizzle ORM + Valkey | Light and type-safe database interactions with Valkey providing ultra-fast counters for quota/rate limiting |

## Known Issues
*None.*
