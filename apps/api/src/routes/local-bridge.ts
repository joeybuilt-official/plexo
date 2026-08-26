// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Local Bridge Nodes — workspace-scoped device registration for the desktop
 * bridge (fs + shell). Stored in workspaces.settings.plexoNodes (JSONB) to
 * avoid a migration in V1. Promote to a proper table when multi-node UI
 * or RLS is needed.
 *
 * POST   /api/v1/workspaces/:workspaceId/local-nodes  — register/upsert
 * GET    /api/v1/workspaces/:workspaceId/local-nodes  — list
 * DELETE /api/v1/workspaces/:workspaceId/local-nodes/:nodeId — remove
 */

import { Router, type Router as RouterType } from 'express'
import { z } from 'zod'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import * as workspacesRepo from '../repositories/workspaces.repository.js'

export const localBridgeRouter: RouterType = Router({ mergeParams: true })

const registerSchema = z.object({
  nodeId: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  address: z.string().min(1).max(200), // Tailscale IP or hostname
  port: z.number().int().min(1).max(65535),
  token: z.string().min(8).max(200), // bearer token (stored as-is for executor to use)
  capabilities: z.array(z.string()).default(['fs', 'shell']),
})

localBridgeRouter.post('/', async (req, res) => {
  const { workspaceId } = req.params as { workspaceId: string }
  if (!UUID_RE.test(workspaceId)) {
    return res.status(400).json({ error: { code: 'INVALID_ID', message: 'workspaceId must be a UUID' } })
  }
  if (!(await ensureWorkspaceAccess(req, res, workspaceId))) return

  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid body', details: parsed.error.flatten().fieldErrors } })
  }

  const { nodeId, name, address, port, token, capabilities } = parsed.data

  const row = await workspacesRepo.getSettingsRow(workspaceId)
  if (row === undefined) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
  }
  const settings = (row?.settings ?? {}) as Record<string, unknown>
  const nodes = Array.isArray(settings.plexoNodes) ? (settings.plexoNodes as any[]) : []

  const now = new Date().toISOString()
  const existingIdx = nodes.findIndex((n) => n.nodeId === nodeId)
  const entry = {
    nodeId,
    name,
    address,
    port,
    token,
    capabilities,
    updatedAt: now,
    ...(existingIdx === -1 ? { createdAt: now } : { createdAt: nodes[existingIdx].createdAt }),
  }

  if (existingIdx === -1) nodes.push(entry)
  else nodes[existingIdx] = entry

  settings.plexoNodes = nodes
  await workspacesRepo.updateSettings(workspaceId, settings)

  logger.info({ workspaceId, nodeId, address, port }, 'local-bridge node registered')
  return res.json({ ok: true, node: { nodeId, name, address, port, capabilities, updatedAt: now } })
})

localBridgeRouter.get('/', async (req, res) => {
  const { workspaceId } = req.params as { workspaceId: string }
  if (!UUID_RE.test(workspaceId)) {
    return res.status(400).json({ error: { code: 'INVALID_ID', message: 'workspaceId must be a UUID' } })
  }
  if (!(await ensureWorkspaceAccess(req, res, workspaceId))) return

  const row = await workspacesRepo.getSettingsRow(workspaceId)
  if (row === undefined) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
  }
  const settings = (row?.settings ?? {}) as Record<string, unknown>
  const nodes = Array.isArray(settings.plexoNodes) ? (settings.plexoNodes as any[]) : []
  // Never return raw tokens over the wire — redact to last 4
  const safe = nodes.map((n: any) => ({
    nodeId: n.nodeId,
    name: n.name,
    address: n.address,
    port: n.port,
    capabilities: n.capabilities,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    tokenHint: typeof n.token === 'string' ? `…${n.token.slice(-4)}` : null,
  }))
  return res.json({ items: safe, total: safe.length })
})

localBridgeRouter.delete('/:nodeId', async (req, res) => {
  const { workspaceId, nodeId } = req.params as { workspaceId: string; nodeId: string }
  if (!UUID_RE.test(workspaceId)) {
    return res.status(400).json({ error: { code: 'INVALID_ID', message: 'workspaceId must be a UUID' } })
  }
  if (!(await ensureWorkspaceAccess(req, res, workspaceId))) return

  const row = await workspacesRepo.getSettingsRow(workspaceId)
  if (row === undefined) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
  }
  const settings = (row?.settings ?? {}) as Record<string, unknown>
  const nodes = Array.isArray(settings.plexoNodes) ? (settings.plexoNodes as any[]) : []
  const next = nodes.filter((n: any) => n.nodeId !== nodeId)
  if (next.length === nodes.length) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Node not found' } })
  }
  settings.plexoNodes = next
  await workspacesRepo.updateSettings(workspaceId, settings)
  logger.info({ workspaceId, nodeId }, 'local-bridge node removed')
  return res.json({ ok: true })
})
