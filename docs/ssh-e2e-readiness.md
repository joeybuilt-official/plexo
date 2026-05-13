# SSH End-to-End Readiness Check

**Date:** 2026-04-08
**Status:** INFRASTRUCTURE READY — awaiting operator E2E test

## Pre-flight Checks

- [x] Migration 0060 applied — SSH in connections_registry
- [x] SSH tools registered: ssh__exec, ssh__upload, ssh__download, ssh__list_dir
- [x] setup_ssh_connection in buildWorkspaceTools() — available from all channels
- [x] SSH client wrapper at packages/agent/src/ssh/client.ts — tested with 5 unit tests
- [x] SSH tool factory at packages/agent/src/connections/factories/ssh.ts — tested with 9 unit tests
- [x] SSH test endpoint at POST /api/connections/ssh/test
- [x] Capability manifest includes SSH awareness
- [x] Telegram adapter has editMessage + progress event handling

## Manual Test Script (for operator)

From Telegram, send these messages to Plexobot:

1. "Set up a connection to my VPS at 203.0.113.1"
   - Agent should ask for username and auth method
   
2. Provide: username=root, auth=key, paste private key
   - Agent should test connection, install, confirm

3. "Check disk space on my server"
   - Agent should use ssh__exec with `df -h`

4. "List files in /opt/plexo"
   - Agent should use ssh__list_dir

5. Verify in web UI: Settings → Connections shows the SSH connection
