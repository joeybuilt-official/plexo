# FAQ

## What AI providers does Plexo support?

Anthropic, OpenAI, Google Gemini, Groq, Mistral, xAI, DeepSeek, OpenRouter, and Ollama (local). Configure multiple providers and Plexo falls back automatically if the primary is unavailable.

## Do I need an AI API key to start?

No. You can start Plexo without any API key. The setup wizard will prompt you to add one when you're ready.

## Is my data sent to Plexo's servers?

No. Plexo is self-hosted. Your data stays on your infrastructure. The only external calls are to the AI provider you configure (Anthropic, OpenAI, etc.). Telemetry is opt-in and limited to anonymous crash reports.

## How much does it cost to run?

Plexo itself is free and open-source (AGPL-3.0). The only costs are your server ($5-20/month for a VPS) and the AI provider API usage — typically $0.01-0.10 per task depending on the model.

## Can multiple people use the same instance?

Yes. Plexo supports multiple workspaces with separate users, each with their own AI provider configuration, agent rules, and task history.

## What happens if the agent crashes mid-task?

The stabilized engine (v0.8+) checkpoints after every tool call. If the process dies, the task resumes from the last checkpoint automatically within 90 seconds. After 3 failed attempts, the task is marked blocked with a visible error.

## Can I use Ollama / local models?

Yes. Configure Ollama as a provider with its base URL. Plexo supports any OpenAI-compatible API endpoint.

## What's a one-way door?

An irreversible action — like a database migration or force push. The agent pauses and asks for your approval before proceeding. You can approve from the dashboard or via Telegram/Slack.

## How do I update Plexo?

```bash
git pull && docker compose up -d --build
```

Migrations run automatically on startup.
