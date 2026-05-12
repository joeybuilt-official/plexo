# Connecting to a Server via SSH

Plexo can connect to your servers via SSH to run commands, deploy code, manage files, and monitor infrastructure — all from a conversation or task.

## Setting Up from Chat

The easiest way: just tell Plexo what you want to do.

> "Connect to my VPS at 203.0.113.1"

Plexo will ask for:
1. Your username (e.g., `root` or `deploy`)
2. How you authenticate (private key or password)
3. Your key or password

Once connected, Plexo confirms and you can immediately start giving it server tasks.

## Setting Up from the Connections Page

1. Go to **Settings → Connections**
2. Find **SSH Server** in the list
3. Fill in: host, port, username, authentication method, key/password
4. Choose an access level (Full Access or Read Only)
5. Click **Save & Test**

## What Plexo Can Do with SSH

- **Run commands:** "Check disk space on my server" → runs `df -h`
- **Deploy code:** "Pull the latest changes and restart the app"
- **Transfer files:** Upload configs, download logs
- **Monitor:** Check processes, read log files, verify services

## Access Levels

- **Full Access:** Run commands, upload files, download files, list directories
- **Read Only:** Run commands and download files only. No uploads. Good for monitoring servers.

## Multiple Servers

You can connect as many servers as you need. Each gets a nickname so Plexo knows which one you mean:

> "Check the status of nginx on the production server"
> "Deploy to staging"

## Security

- Your SSH credentials are encrypted at rest (AES-256-GCM)
- Private keys are only used during the connection — never stored in chat or logs
- Every command is logged to your workspace audit trail
- Plexo disconnects after each command — no persistent sessions
- You can set a command limit per task (default: 50 commands)
- Optional: block specific commands with a denylist

## Troubleshooting

**"Connection failed"** — Check that the host is reachable, the port is correct (default 22), and your credentials are valid.

**"Permission denied"** — The username or key/password is wrong. Try connecting manually with `ssh username@host` to verify.

**"Command timed out"** — Commands have a 90-second limit. For long-running tasks, consider running them in the background on the server.
