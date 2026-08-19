// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pure image-validation use-case for the webchat message route.
 *
 * Extracted verbatim from `routes/chat.ts` so the validation rules (max 5
 * images, max 10MB, base64 data URL, SVG rejected) are unit-testable and
 * free of Express/Drizzle. The route parses `req.body.images`, calls this,
 * and translates a non-`ok` result into a 400 — see the call site for the
 * exact status/error shape.
 */

export type ChatImage = { data: string; mimeType: string; name: string }

export type ValidateImagesResult =
    | { ok: true; validImages: ChatImage[] }
    | { ok: false; code: 'TOO_MANY_IMAGES' | 'INVALID_IMAGE' | 'IMAGE_TOO_LARGE'; message: string }

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10MB

/**
 * Validate the `images` field from the chat message body.
 *
 * Accepts `undefined` (no images sent) or an array; any other shape is
 * treated as no images. Mirrors the original route behavior: a non-array
 * skips validation entirely and yields zero valid images.
 */
export function validateImages(images: unknown): ValidateImagesResult {
    const validImages: ChatImage[] = []
    if (Array.isArray(images)) {
        if (images.length > 5) {
            return { ok: false, code: 'TOO_MANY_IMAGES', message: 'Maximum 5 images per message' }
        }
        for (const img of images) {
            if (typeof img.data !== 'string' || !img.data.startsWith('data:image/')) {
                return { ok: false, code: 'INVALID_IMAGE', message: 'Images must be base64 data URLs (data:image/...)' }
            }
            if (img.data.length > MAX_IMAGE_BYTES) {
                return { ok: false, code: 'IMAGE_TOO_LARGE', message: 'Image too large (max 10MB)' }
            }
            // Block SVG from the image path — it must go through the text path
            if (img.mimeType === 'image/svg+xml') {
                return { ok: false, code: 'INVALID_IMAGE', message: 'SVG must be sent as a text document, not an image' }
            }
            validImages.push(img)
        }
    }
    return { ok: true, validImages }
}