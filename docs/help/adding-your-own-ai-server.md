# Adding Your Own AI Server

You can run AI models on your own computer or server for maximum privacy. Plexo connects to your server and uses it for conversations and memory.

## What You Need

**Ollama** is a free tool that runs AI models locally. It works on Mac, Windows, and Linux.

1. Install Ollama from [ollama.com](https://ollama.com)
2. Open a terminal and install a conversation model:
   ```
   ollama pull llama3.2
   ```
3. Install a memory model:
   ```
   ollama pull snowflake-arctic-embed
   ```

## Connecting to Plexo

1. Go to **Intelligence** in your workspace settings
2. Click **Add provider** at the bottom of either section
3. Choose **Use an AI running on my own computer or server**
4. Enter your server address (usually `http://localhost:11434`)
5. Click **Test & Save**

Plexo will detect what models you have installed and use them automatically.

## Common Server Addresses

- **Same computer:** `http://localhost:11434`
- **Another computer on your network:** `http://192.168.x.x:11434` (replace with the computer's IP)
- **A remote server:** `https://your-server.example.com` (use HTTPS if exposed to the internet)

## Recommended Models

For conversation: `llama3.2` (2 GB, good general purpose) or `llama3.1:8b` (5 GB, better reasoning)

For memory: `snowflake-arctic-embed` (670 MB, best quality) or `nomic-embed-text` (274 MB, smaller)

## Troubleshooting

**"We couldn't reach that server"** — Make sure Ollama is running. In a terminal, run `ollama serve` to start it.

**"No models installed"** — Run `ollama pull llama3.2` in a terminal to install a model.

**Server on another computer** — Make sure Ollama is configured to accept connections from other machines. Set `OLLAMA_HOST=0.0.0.0` before starting Ollama.
