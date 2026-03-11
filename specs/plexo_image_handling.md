# Spec: Plexo Image Handling & Visual Capabilities

## Why
Plexo users often request visual information (e.g., "Find an image of X", "Screenshot the dashboard", "Show me Y"). Currently, if an agent is running a text-only model or interacting via a text-only channel (like Telegram without vision context), it cannot fulfill these requests easily. We need to bridge this gap by enabling the agent to "see" via web screenshots and "find" via image search, and then deliver these visual assets back to the user.

## How

### 1. Database & Schema
- Add `attachments` (JSONB) to the `conversations` table. This will store metadata for images (URL, type, alt text) sent in a conversation turn.
- Update `packages/db/src/schema.ts` to include the `attachments` column.
- Create a migration file `0022_conversation_attachments.sql`.

### 2. Conversation & Channel Routing
- Update `RecordConversationParams` and `recordConversation` in `apps/api/src/conversation-log.ts` to support `attachments`.
- Update `replyToChannel` in `apps/api/src/conversation-log.ts` to handle `attachments`. For Telegram, it will use `sendPhoto` if an image attachment is found.
- Update Telegram adapter (`apps/api/src/routes/telegram.ts`) to correctly handle incoming photos and outgoing agent-generated images.

### 3. Agent Tools (Executor)
- **`web_screenshot`**: Captures a screenshot of a given URL using Playwright. Saves it as an asset and returns the URL.
- **`image_search`**: Searches the web for images matching a query. Returns a list of image URLs and their sources.

### 4. Manifest & Prompting
- Update `packages/agent/src/capabilities/manifest.ts` to include these new tools in `BUILTIN_TOOLS`.
- Update system prompts to inform the agent that it can now "see" the web via screenshots and "deliver" images via `attachments`.

## Risks
- **Large Assets**: Generating many screenshots can consume disk space. We will use the existing `/tmp/plexo-assets` and `@plexo/storage` (S3/MinIO) for persistence.
- **Privacy**: Screenshots might capture sensitive information on pages. Agents should be cautioned to only screenshot public or safe-to-view internal pages.
- **OpenAI/Anthropic Context**: Sending image URLs to models that don't support vision may still require a "description" of the image. The tools should provide a textual summary where possible.

## Verification
- **Unit Tests**: Test `recordConversation` with attachments.
- **Integration Tests**: Verify `web_screenshot` captures a page locally.
- **Manual Verification**: 
    1. Ask regular "do this" task.
    2. Ask "Screenshot google.com".
    3. Ask "Find an image of a red panda".
    4. Verify images appear in Chat UI and Telegram.

---
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
