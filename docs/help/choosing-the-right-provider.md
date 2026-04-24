# Choosing the Right Provider

Different AI providers have different strengths. Here's how to pick.

## If You Want the Best Quality

**Anthropic** (Claude) is excellent for reasoning, writing, and complex tasks. Pair it with **OpenAI** or **Voyage** for memory, since Anthropic doesn't provide memory models.

## If You Want Free

**Plexo's built-in AI** works with no setup and no cost. For better quality at no cost, install **Ollama** on your computer — it's free and runs locally.

**Google Gemini** has a generous free tier that includes both conversation and memory.

## If You Want Privacy

Run **Ollama** on your own computer or server. Your data never leaves your hardware. Install both a conversation model and a memory model for full functionality.

## If You Want Speed

**Groq** provides ultra-fast inference for conversation. Pair it with another provider for memory (Groq doesn't support memory models).

## What About Memory?

Not every provider supports memory models. If your main provider doesn't, Plexo automatically uses another provider that does — either one you've configured or the built-in AI.

Providers with memory support: OpenAI, Google, Mistral, Voyage, Cohere, Ollama (with a memory model installed).

Providers without memory support: Anthropic, DeepSeek, Groq, xAI.

## Multiple Providers

You can add as many providers as you want. Plexo uses them in the order you set — top provider first, falling through to the next if something goes wrong. This gives you automatic failover with no manual intervention.
