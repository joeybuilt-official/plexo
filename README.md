# Plexo

Plexo is a self-hosted AI agent platform. You describe an objective -- in the dashboard, Telegram, Slack, or Discord -- and Plexo plans the work, executes it autonomously with tool calls, and delivers structured results. It handles software engineering, business operations, and deep research tasks without requiring you to stay in the loop.

Built on Node.js, TypeScript, PostgreSQL + pgvector, and the Vercel AI SDK. Supports Anthropic, OpenAI, DeepSeek, Groq, Mistral, Google Gemini, Ollama, and any OpenAI-compatible provider.

> **Screenshots:** See the [platform walkthrough](#platform-screenshots) below.

## Quick Start

```bash
git clone https://github.com/joeybuilt-official/plexo.git
cd plexo
bash scripts/install.sh --domain=plexo.yourdomain.com
docker compose up -d
# Open https://plexo.yourdomain.com
```

The install script generates all secrets. The setup wizard walks you through connecting an AI provider.

For manual setup or detailed instructions, see the [self-hosting guide](docs/self-host.md).

## Documentation

- [Self-Hosting Guide](docs/self-host.md) -- Prerequisites, setup, verification, troubleshooting
- [Configuration Reference](docs/configuration.md) -- Every environment variable documented
- [Concepts](docs/concepts.md) -- Workspaces, tasks, agent behavior, how messages become tasks
- [Architecture](docs/architecture.md) -- Package structure, data flow, technology choices
- [Deployment](docs/deploy.md) -- VPS sizing, TLS, Coolify/Portainer, updates, rollback, backups
- [Plexo Fabric SDK](docs/fabric/SPEC.md) -- Extension development specification
- [FAQ](docs/faq.md)

## Platform Screenshots

<details>
<summary>Expand to view</summary>
<br/>

<img src="images/overview.png" alt="Plexo Dashboard" width="100%" />

<img src="images/tasks.png" alt="Task Introspection" width="100%" />

<img src="images/conversations.png" alt="Conversations" width="100%" />

<img src="images/approvals.png" alt="Escalation and Approvals" width="100%" />

<img src="images/agent_settings.png" alt="Agent Configuration" width="100%" />

</details>

## License

[AGPL-3.0](LICENSE). You can use, modify, and self-host freely. If you modify Plexo and offer it as a network service, you must publish your modifications under the same license.

Commercial licensing: [licensing@getplexo.com](mailto:licensing@getplexo.com)
