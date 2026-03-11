# Implementation Plan - Multi-Channel Audio Support Fixes

## Problem
The Telegram bot fails to transcribe audio messages ("couldn't understand the audio"). The root cause is likely brittle error handling in `telegram.ts` and potentially restrictive parameters in `voice.ts`.

## Proposed Changes

### 1. Robust Voice Transcription (`apps/api/src/routes/voice.ts`)
- Use `detect_language=true` instead of hardcoded `en` for Deepgram transcription.
- Ensure manual raw body parsing is only used for audio content types.
- Log specific Deepgram error messages for easier debugging.

### 2. Telegram Audio Handling (`apps/api/src/routes/telegram.ts`)
- Check `transcribeRes.ok` explicitly before parsing.
- Report specific transcription failures (e.g., config error, service downtime) to the user instead of a generic "couldn't understand".
- Handle `audio/ogg` specifically if Deepgram reports it's problematic without a more specific codec.

### 3. Verification
- Manual verification via the Telegram bot.
- API test path using a small local audio file.

## Risks
- `detect_language` may slightly increase initial transcription latency.
- No changes to DB schema or existing API contracts.
