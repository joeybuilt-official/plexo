// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace membership + invite data-access repository.
 *
 * second repository (after nodes) extending the boundary.
 * Owns all persistence for the membership aggregate: workspace_members,
 * workspace_invites, plus the user-by-email lookup and workspace-owner read the
 * membership flows need. Route handlers (routes/members.ts) keep auth, role
 * checks, validation, audit logging, and the permission-graph shadow-writes —
 * only the SQL lives here.
 */
import { eq, and, desc, isNull } from 'drizzle-orm'
import { db } from '@plexo/db'
import { workspaceMembers, workspaceInvites, users, workspaces } from '@plexo/db'

type Role = typeof workspaceMembers.$inferInsert['role']
type Invite = typeof workspaceInvites.$inferSelect

export interface MemberWithUser {
    id: string
    userId: string
    role: Role
    joinedAt: Date
    name: string | null
    email: string
}

/** Members of a workspace with joined user info, newest first (capped 500). */
export async function listMembersWithUser(workspaceId: string): Promise<MemberWithUser[]> {
    return db
        .select({
            id: workspaceMembers.id,
            userId: workspaceMembers.userId,
            role: workspaceMembers.role,
            joinedAt: workspaceMembers.joinedAt,
            name: users.name,
            email: users.email,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(eq(workspaceMembers.workspaceId, workspaceId))
        .orderBy(desc(workspaceMembers.joinedAt))
        .limit(500) as Promise<MemberWithUser[]>
}

/** True when a user is a member of a workspace. */
export async function isMember(workspaceId: string, userId: string): Promise<boolean> {
    const [membership] = await db.select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
        .limit(1)
    return !!membership
}

/** Resolve a user id by email, or undefined. */
export async function findUserIdByEmail(email: string): Promise<string | undefined> {
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
    return user?.id
}

/** Upsert a membership row (insert, or update role on conflict). */
export async function upsertMember(workspaceId: string, userId: string, role: Role): Promise<void> {
    await db.insert(workspaceMembers).values({ workspaceId, userId, role }).onConflictDoUpdate({
        target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        set: { role },
    })
}

/** Update an existing member's role. */
export async function updateMemberRole(workspaceId: string, userId: string, role: Role): Promise<void> {
    await db
        .update(workspaceMembers)
        .set({ role })
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
}

/** Workspace owner id (for the remove-owner guard), or undefined. */
export async function getWorkspaceOwnerId(workspaceId: string): Promise<string | undefined> {
    const [ws] = await db.select({ ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    return ws?.ownerId ?? undefined
}

/** Remove a membership row. */
export async function deleteMember(workspaceId: string, userId: string): Promise<void> {
    await db
        .delete(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
}

export interface CreateInviteInput {
    workspaceId: string
    token: string
    invitedEmail: string | null
    role: Role
    invitedByUserId: string
    expiresAt: Date
}

/** Persist a new invite row. */
export async function createInvite(input: CreateInviteInput): Promise<void> {
    await db.insert(workspaceInvites).values(input)
}

export interface InviteWithWorkspace {
    id: string
    role: Role
    invitedEmail: string | null
    expiresAt: Date
    usedAt: Date | null
    workspaceId: string
    workspaceName: string
}

/** Invite joined with its workspace name (for the public invite-info page). */
export async function getInviteWithWorkspace(token: string): Promise<InviteWithWorkspace | undefined> {
    const [invite] = await db
        .select({
            id: workspaceInvites.id,
            role: workspaceInvites.role,
            invitedEmail: workspaceInvites.invitedEmail,
            expiresAt: workspaceInvites.expiresAt,
            usedAt: workspaceInvites.usedAt,
            workspaceId: workspaceInvites.workspaceId,
            workspaceName: workspaces.name,
        })
        .from(workspaceInvites)
        .innerJoin(workspaces, eq(workspaceInvites.workspaceId, workspaces.id))
        .where(eq(workspaceInvites.token, token))
        .limit(1)
    return invite as InviteWithWorkspace | undefined
}

/** Full invite row by token. */
export async function getInviteByToken(token: string): Promise<Invite | undefined> {
    const [invite] = await db.select().from(workspaceInvites).where(eq(workspaceInvites.token, token)).limit(1)
    return invite
}

/**
 * Accept an invite atomically: seat the member and consume the invite in one
 * transaction. The invite is consumed only when still unused (isNull guard),
 * closing the double-accept race.
 */
export async function acceptInviteTx(params: { token: string; userId: string; role: Role; workspaceId: string }): Promise<void> {
    const { token, userId, role, workspaceId } = params
    await db.transaction(async (tx) => {
        await tx.insert(workspaceMembers).values({ workspaceId, userId, role }).onConflictDoUpdate({
            target: [workspaceMembers.workspaceId, workspaceMembers.userId],
            set: { role },
        })
        await tx
            .update(workspaceInvites)
            .set({ usedAt: new Date(), usedByUserId: userId })
            .where(and(eq(workspaceInvites.token, token), isNull(workspaceInvites.usedAt)))
    })
}
