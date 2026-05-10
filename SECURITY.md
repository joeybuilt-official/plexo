# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Older releases | No |

Only the latest release receives security patches. Upgrade to stay protected.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **security@getplexo.com** with:
- Description of the vulnerability
- Steps to reproduce or proof of concept
- Affected component(s) and version(s)
- Impact assessment (if known)

### What qualifies

- Authentication or authorization bypasses
- SQL injection, XSS, CSRF, SSRF
- Secrets exposure or leakage
- Privilege escalation
- Remote code execution
- Dependency vulnerabilities with exploitable path

### What does not qualify

- Feature requests
- Denial-of-service without amplification
- Social engineering
- Issues in unrelated third-party services

## Response SLOs

| Stage | Timeline |
|-------|----------|
| Acknowledgment | 48 hours |
| Assessment and severity rating | 7 days |
| Fix or mitigation | Based on severity |
| Coordinated public disclosure | 90 days max |

## Secret Rotation Guidance

Plexo deployments manage these secret categories:
- **Database credentials** — rotate via environment variables, restart services
- **Session/JWT signing keys** — rotate key, existing sessions expire naturally
- **API keys (provider credentials)** — rotate in provider dashboard, update env
- **Encryption keys (at-rest)** — rotate with key versioning, re-encrypt active data

All secrets are configured via environment variables. Never hardcode secrets. See `.env.example` for the full list.

## Credit

Security reporters are credited in the published advisory by default. Let us know if you prefer to remain anonymous.

## Contact

security@getplexo.com
