// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace membership + invite API
 *
 * GET    /api/workspaces/:id/members           List members with user info
 * POST   /api/workspaces/:id/members           Add existing user by email
 * PATCH  /api/workspaces/:id/members/:userId   Update member role
 * DELETE /api/workspaces/:id/members/:userId   Remove member
 * POST   /api/workspaces/:id/invite            Create invite link (7-day expiry)
 * GET    /api/invites/:token                   Get invite info (workspace name, role)
 * POST   /api/invites/:token/accept            Accept invite, create membership
 */
import { Router, type Router as RouterType } from 'express'
import { randomBytes } from 'crypto'
import { logger } from '../logger.js'
import { audit } from '../audit.js'
import { UUID_RE } from '../validation.js'
import { mirrorMembershipUpsert, mirrorMembershipDelete } from '../lib/permission-graph.js'
import * as membersRepo from '../repositories/members.repository.js'

export const membersRouter: RouterType = Router({ mergeParams: true })
export const invitesRouter: RouterType = Router({ mergeParams: true })

type MemberRole = 'owner' | 'admin' | 'member' | 'viewer'
const VALID_ROLES: MemberRole[] = ['owner', 'admin', 'member', 'viewer']

// ── GET /api/workspaces/:id/members ────────────────────────────────────────────

membersRouter.get('/', async (req, res) => {
    const workspaceId = (req.params as { id: string }).id
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required' } })
        return
    }
    try {
        const rows = await membersRepo.listMembersWithUser(workspaceId)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'GET members failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list members' } })
    }
})

// ── POST /api/workspaces/:id/members (add by email) ────────────────────────────

membersRouter.post('/', async (req, res) => {
    const workspaceId = (req.params as { id: string }).id
    const { email, role = 'member' } = req.body as { email?: string; role?: string }

    // SEC-013: Only admins and owners can add members
    if (req.workspaceRole !== 'admin' && req.workspaceRole !== 'owner') {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin or owner role required' } })
        return
    }

    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required' } })
        return
    }
    if (!email) {
        res.status(400).json({ error: { code: 'MISSING_EMAIL', message: 'email required' } })
        return
    }
    if (!VALID_ROLES.includes(role as MemberRole)) {
        res.status(400).json({ error: { code: 'INVALID_ROLE', message: `role must be one of: ${VALID_ROLES.join(', ')}` } })
        return
    }

    try {
        const foundUserId = await membersRepo.findUserIdByEmail(email)
        if (!foundUserId) {
            res.status(404).json({ error: { code: 'USER_NOT_FOUND', message: 'No user with that email' } })
            return
        }

        await membersRepo.upsertMember(workspaceId, foundUserId, role as MemberRole)
        // Phase C1 (ADR 0022) shadow-write to permission graph.
        void mirrorMembershipUpsert({ workspaceId, userId: foundUserId, role })

        logger.info({ workspaceId, userId: foundUserId, role }, 'Member added')
        audit(req, { workspaceId, action: 'member.add', resource: 'workspace_members', resourceId: foundUserId, metadata: { role, email } })
        res.status(201).json({ ok: true, userId: foundUserId })
    } catch (err) {
        logger.error({ err }, 'POST members failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to add member' } })
    }
})

// ── PATCH /api/workspaces/:id/members/:userId ──────────────────────────────────

membersRouter.patch('/:userId', async (req, res) => {
    const workspaceId = (req.params as { id: string; userId: string }).id
    const userId = (req.params as { id: string; userId: string }).userId
    const { role } = req.body as { role?: string }

    // SEC-013: Only admins and owners can change roles
    if (req.workspaceRole !== 'admin' && req.workspaceRole !== 'owner') {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin or owner role required' } })
        return
    }

    if (!UUID_RE.test(workspaceId) || !UUID_RE.test(userId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    if (!role || !VALID_ROLES.includes(role as MemberRole)) {
        res.status(400).json({ error: { code: 'INVALID_ROLE', message: `role must be one of: ${VALID_ROLES.join(', ')}` } })
        return
    }
    if (role === 'owner') {
        res.status(400).json({ error: { code: 'CANNOT_ASSIGN_OWNER', message: 'Use workspace transfer to change owner' } })
        return
    }

    try {
        await membersRepo.updateMemberRole(workspaceId, userId, role as MemberRole)
        // Phase C1 (ADR 0022) shadow-write — role change.
        void mirrorMembershipUpsert({ workspaceId, userId, role })

        audit(req, { workspaceId, action: 'member.role_change', resource: 'workspace_members', resourceId: userId, metadata: { role } })
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'PATCH member failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── DELETE /api/workspaces/:id/members/:userId ─────────────────────────────────

membersRouter.delete('/:userId', async (req, res) => {
    const workspaceId = (req.params as { id: string; userId: string }).id
    const userId = (req.params as { id: string; userId: string }).userId

    // SEC-013: Only admins and owners can remove members
    if (req.workspaceRole !== 'admin' && req.workspaceRole !== 'owner') {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin or owner role required' } })
        return
    }

    if (!UUID_RE.test(workspaceId) || !UUID_RE.test(userId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }

    try {
        // Prevent removing the owner
        const ownerId = await membersRepo.getWorkspaceOwnerId(workspaceId)
        if (ownerId === userId) {
            res.status(400).json({ error: { code: 'CANNOT_REMOVE_OWNER', message: 'Cannot remove workspace owner' } })
            return
        }

        await membersRepo.deleteMember(workspaceId, userId)
        // Phase C1 (ADR 0022) shadow-write — membership deletion.
        void mirrorMembershipDelete({ workspaceId, userId })

        logger.info({ workspaceId, userId }, 'Member removed')
        audit(req, { workspaceId, action: 'member.remove', resource: 'workspace_members', resourceId: userId })
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'DELETE member failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Remove failed' } })
    }
})

// ── POST /api/workspaces/:id/invite ───────────────────────────────────────────

membersRouter.post('/invite', async (req, res) => {
    const workspaceId = (req.params as { id: string }).id
    const { email, role = 'member', invitedByUserId } = req.body as {
        email?: string
        role?: string
        invitedByUserId?: string
    }

    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required' } })
        return
    }
    if (!invitedByUserId) {
        res.status(400).json({ error: { code: 'MISSING_USER', message: 'invitedByUserId required' } })
        return
    }
    if (!UUID_RE.test(invitedByUserId)) {
        res.status(400).json({ error: { code: 'INVALID_USER', message: 'Valid UUID required for invitedByUserId' } })
        return
    }
    if (!VALID_ROLES.includes(role as MemberRole)) {
        res.status(400).json({ error: { code: 'INVALID_ROLE', message: `role must be one of: ${VALID_ROLES.join(', ')}` } })
        return
    }

    try {
        const token = randomBytes(24).toString('hex')
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

        await membersRepo.createInvite({
            workspaceId,
            token,
            invitedEmail: email ?? null,
            role: role as MemberRole,
            invitedByUserId,
            expiresAt,
        })

        const publicUrl = process.env.PUBLIC_URL ?? 'http://localhost:3000'
        const inviteUrl = `${publicUrl}/invite/${token}`

        logger.info({ workspaceId, tokenPrefix: token.slice(0, 8) + '...', role }, 'Invite created')
        audit(req, { workspaceId, userId: invitedByUserId, action: 'invite.create', resource: 'workspace_invites', resourceId: token, metadata: { role, email: email ?? null } })
        res.status(201).json({ token, inviteUrl, expiresAt })
    } catch (err) {
        logger.error({ err }, 'POST invite failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create invite' } })
    }
})

// ── GET /api/invites/:token ────────────────────────────────────────────────────

invitesRouter.get('/:token', async (req, res) => {
    const { token } = req.params

    try {
        const invite = await membersRepo.getInviteWithWorkspace(token)

        if (!invite) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invite not found' } })
            return
        }
        if (invite.usedAt) {
            res.status(410).json({ error: { code: 'INVITE_USED', message: 'This invite has already been used' } })
            return
        }
        if (new Date(invite.expiresAt) < new Date()) {
            res.status(410).json({ error: { code: 'INVITE_EXPIRED', message: 'This invite has expired' } })
            return
        }

        res.json({
            workspaceId: invite.workspaceId,
            workspaceName: invite.workspaceName,
            role: invite.role,
            invitedEmail: invite.invitedEmail,
            expiresAt: invite.expiresAt,
        })
    } catch (err) {
        logger.error({ err }, 'GET invite failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get invite' } })
    }
})

// ── POST /api/invites/:token/accept ───────────────────────────────────────────

invitesRouter.post('/:token/accept', async (req, res) => {
    const { token } = req.params
    const { userId } = req.body as { userId?: string }

    if (!userId) {
        res.status(400).json({ error: { code: 'MISSING_USER', message: 'userId required' } })
        return
    }
    if (!UUID_RE.test(userId)) {
        res.status(400).json({ error: { code: 'INVALID_USER', message: 'Valid UUID required for userId' } })
        return
    }

    try {
        const invite = await membersRepo.getInviteByToken(token)

        if (!invite) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invite not found' } })
            return
        }
        if (invite.usedAt) {
            res.status(410).json({ error: { code: 'INVITE_USED', message: 'Already used' } })
            return
        }
        if (new Date(invite.expiresAt) < new Date()) {
            res.status(410).json({ error: { code: 'INVITE_EXPIRED', message: 'Expired' } })
            return
        }

        // Atomic seat-member + consume-invite (transaction + isNull guard) lives in
        // the repository so a crash between the two writes can't leave inconsistent
        // membership/invite state and the double-accept race stays closed.
        await membersRepo.acceptInviteTx({ token, userId, role: invite.role, workspaceId: invite.workspaceId })
        // Phase C1 (ADR 0022) shadow-write — invite acceptance.
        void mirrorMembershipUpsert({ workspaceId: invite.workspaceId, userId, role: invite.role })

        logger.info({ tokenPrefix: token.slice(0, 8) + '...', userId, workspaceId: invite.workspaceId }, 'Invite accepted')
        audit(req, { workspaceId: invite.workspaceId, userId, action: 'invite.accept', resource: 'workspace_invites', resourceId: token, metadata: { role: invite.role } })
        res.json({ ok: true, workspaceId: invite.workspaceId })
    } catch (err) {
        logger.error({ err }, 'POST invite/accept failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Accept failed' } })
    }
})
