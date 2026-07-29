// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Google Messages connection data-access repository (write-only).
 *
 * owns the three-row paired-connection transaction
 * (installed_connections + channels + paired_sessions). The route keeps
 * credential encryption, audit, and analytics side-effects.
 */
import { db, installedConnections, channels, pairedSessions } from '@plexo/db'

/** Atomically seed the installed connection, channel, and paired session. */
export async function insertPairedConnection(args: {
    workspaceId: string
    registryId: string
    encryptedCreds: { encrypted: string }
}): Promise<{ installedConnectionId: string; channelId: string; pairedSessionId: string }> {
    const { workspaceId, registryId, encryptedCreds } = args
    return await db.transaction(async (tx) => {
        // The unique index is (workspaceId, registryId, label); a timestamp-
        // suffixed label lets multiple paired phones coexist.
        const label = `phone-${Date.now().toString(36)}`

        const [installed] = await tx.insert(installedConnections).values({
            workspaceId,
            registryId,
            name: 'Google Messages',
            label,
            credentials: encryptedCreds,
            status: 'active',
            lastVerifiedAt: new Date(),
        }).returning({ id: installedConnections.id })

        if (!installed) throw new Error('failed to insert installed_connection')

        const [channel] = await tx.insert(channels).values({
            workspaceId,
            type: 'gmessages',
            name: 'Google Messages',
            config: { connectionId: installed.id },
            enabled: true,
        }).returning({ id: channels.id })

        if (!channel) throw new Error('failed to insert channel')

        // state='active' (not 'paired') so the sidecar's boot-restore picks
        // this row up on its next start and calls manager.Start with the
        // decrypted AuthBlob — the long-poll session goes live.
        const [paired] = await tx.insert(pairedSessions).values({
            workspaceId,
            installedConnectionId: installed.id,
            channelId: channel.id,
            state: 'active',
            pairStartedAt: new Date(),
            pairedAt: new Date(),
        }).returning({ id: pairedSessions.id })

        if (!paired) throw new Error('failed to insert paired_session')

        return {
            installedConnectionId: installed.id,
            channelId: channel.id,
            pairedSessionId: paired.id,
        }
    })
}
