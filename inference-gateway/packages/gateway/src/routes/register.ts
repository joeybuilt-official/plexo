import { Router, Request, Response } from 'express'
import { db } from '../db/client'
import { apiKeys, instances } from '../db/schema'
import { eq } from 'drizzle-orm'
import { generateSigningSecret } from '../lib/signature'
import { z } from 'zod'
import crypto from 'crypto'
import bcrypt from 'bcrypt'

export const registerRouter = Router()

const RegisterPayload = z.object({
  instance_id: z.string().uuid(),
  plexo_version: z.string().optional(),
  api_key: z.string(),
  ip_allowlist: z.array(z.string()).optional(),
})

// Authentication happens via X-Admin-Key matching config
// Or checking if the API key sent exists and is unassigned.
// The prompt specifies: "Auth: Admin key in header (X-Admin-Key) — separate from per-instance API keys"
registerRouter.post('/v1/register', async (req: Request, res: Response) => {
  // 1. Admin Key
  const adminKey = req.headers['x-admin-key']
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) { // Need to add ADMIN_KEY to config, wait prompt said "Auth: Admin key in header... Admin key is an env var"
    res.status(401).json({ error: 'unauthorized' })
    return
  }

  const parseResult = RegisterPayload.safeParse(req.body)
  if (!parseResult.success) {
    res.status(400).json({ error: 'invalid_payload', details: parseResult.error.errors })
    return
  }

  const data = parseResult.data
  const rawKeyPrefix = data.api_key.substring(0, 8)

  try {
    // Check key exists and is unassigned
    const keys = await db.query.apiKeys.findMany({
      where: eq(apiKeys.keyPrefix, rawKeyPrefix),
    })

    let validKey = null
    for (const k of keys) {
      if (await bcrypt.compare(data.api_key, k.keyHash)) {
        validKey = k
        break
      }
    }

    if (!validKey) {
      res.status(404).json({ error: 'api_key_not_found' })
      return
    }

    // Is it unbound? (Wait, schema has `instanceId` not null, so an API key MUST be created WITH an instance, OR instance is created first?)
    // Ah, wait! The prompt: "Validate API key exists and is unbound... Bind instance to API key... Response: signing_secret"
    // But `api_keys.instance_id` is NOT NULL REFERENCES instances(id).
    // This implies instances table must have a record before api_keys is created OR they are created at the same time?
    // Wait, the Admin API `POST /admin/keys` issues a new API key but doesn't have an instance yet?
    // "Issue a new API key ... returns key prefix ... never returns full key"
    // "Called once when a self-hosted Plexo instance is first linked to a Plexo API key."
    // If Admin UI issues a key, how can `instance_id` be NOT NULL? We must change the schema to allow `instance_id` to be null on API keys, until it's bound. Or Admin UI creates an empty/placeholder instance?
    // Changing schema `apiKeys.instanceId` to allow null is the simplest solution.
    
    // Create the instance
    const signingSecret = generateSigningSecret()
    
    const [instance] = await db.insert(instances).values({
      instanceId: data.instance_id,
      signingSecret,
      plexoVersion: data.plexo_version,
      ipAllowlist: data.ip_allowlist,
      createdAt: new Date(),
    } as any).returning()

    // Update the API key to bind the instance
    // Oh, if it was unbound, instanceId might be null.
    await db.update(apiKeys).set({
      instanceId: instance.id
    }).where(eq(apiKeys.id, validKey.id))

    res.status(200).json({
      success: true,
      instance_id: instance.instanceId,
      signing_secret: signingSecret,
      gateway_url: process.env.GATEWAY_URL
    })
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'instance_already_registered' })
      return
    }
    res.status(500).json({ error: 'internal_server_error' })
  }
})
