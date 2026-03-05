# Plan: System Integrations Section in Settings

## Why
The user desires a dedicated section within the existing settings to represent, manage, and provide necessary information regarding Plexo's MCP, API, and CLI based on the instance environment.

## How
1. **Add "System" Tab to Settings**
   - Update `apps/web/src/app/(dashboard)/settings/page.tsx`.
   - Add a new section called "System" (with a `Server` icon) in the `SECTIONS` array.
2. **Retrieve Instance Environment Info**
   - Utilize existing `API_BASE` (`process.env.NEXT_PUBLIC_API_URL` / `http://localhost:3001`).
3. **Build UI Cards for MCP, API, and CLI (Best Practices)**
   - **System Status:** Call `/health` from the API to show version, status, and uptime.
   - **API Connection:** Show the current instance API URL. Explain how to authenticate using workspace API keys (which are already saved in the API Keys tab). Provide a fetch example and copy button for the base URL.
   - **CLI Configuration:** Provide instructions on how to install and connect the CLI to this specific instance. For example, `npm install -g @plexo/cli` and `plexo login --url <API_BASE>`.
   - **MCP Setup:** Provide instructions on configuring Anthropic Claude Desktop or Cursor to point to this instance's MCP server. Display the JSON config snippet that includes the correct env vars and executable path pointing to this instance's URL. Include a copy-to-clipboard function for the config snippet.
4. **Style according to existing UI context**
   - Use the `lucide-react` icons and the existing glassmorphic/dark theme components. Include copy to clipboard `lucide-react` icons `Copy` and `CheckCheck`.

## Risks
- Incorrect `API_BASE` or `localhost` paths when running in production might confuse users if the environment variables aren't strictly aligned with the public-facing URLs.
- *Mitigation:* Explicitly render the detected base URL so users see exactly what the front-end will tell the clients to use. We will also allow them to edit or override the displayed URL locally if needed.

## Verification
- We will visit `/settings` via the dev server.
- The "System" tab should appear on the left.
- Upon clicking, the distinct regions (Status, API, CLI, MCP) display correctly formatted instructions.
- All instructions should correctly populate the environment's `API_BASE`.
