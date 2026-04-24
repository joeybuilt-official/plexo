# PEX — Plexo Extension Protocol

PEX is the contract that lets the Plexo runtime load, isolate, and communicate with extensions.

## What PEX defines

- **Manifest format** — how an extension declares its capabilities, permissions, and trust requirements
- **Wire protocol** — the message format for host↔extension communication (`PexMessage`, `PexError`)
- **Lifecycle** — install, activate, invoke, deactivate, uninstall
- **Capability model** — what an extension can request and what the host can grant
- **Sandboxing contract** — how the host isolates extensions
- **Versioning** — how extensions declare compatibility (`minPexVersion`)

## Extensions

An extension is anything that follows PEX. Extensions come in several flavors:

- **Agents** — autonomous actors with their own tools, models, and behaviors
- **Tools** — function packages the host agent can invoke
- **Skills** — reusable behavior modules
- **Channels** — input/output adapters (Telegram, Slack, Discord, etc.)
- **Connectors** — credential-bearing integrations (Notion, GitHub, etc.)
- **MCP Servers** — Model Context Protocol bridges

All of these install via the same flow, declare PEX-compatible manifests, and run in the same sandbox.

## Versioning

Each PEX release is versioned. The current version is `PEX v0.4`.

Extensions declare the minimum PEX version they require:

```json
{
  "name": "@plexo/example",
  "type": "tool",
  "minPexVersion": "0.4.0",
  ...
}
```

The host refuses to load extensions that target a PEX version newer than itself.

## See also

- [PEX Specification](./SPEC.md) — full normative reference
- [Manifest Format](./MANIFEST.md) — manifest field reference
- [Plexo SDK](../../packages/sdk) — TypeScript SDK for building extensions
