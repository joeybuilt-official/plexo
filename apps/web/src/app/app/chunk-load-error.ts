// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

// A ChunkLoadError means the browser requested a code-split chunk whose hash no
// longer exists on the server — almost always because a new build was deployed
// while this tab was open (the old client references chunk hashes the new build
// discarded). Detect it so the error boundary can self-heal with a single reload
// onto the current build instead of stranding the user on the error screen.
export function isChunkLoadError(error: Error): boolean {
    return (
        error.name === 'ChunkLoadError' ||
        /loading chunk|load chunk|dynamically imported module|importing a module script failed/i.test(
            error.message,
        )
    )
}
