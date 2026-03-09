// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Kapsel Event Bus — host implementation (§7)
 *
 * v2: adds Redis pub/sub fan-out for multi-container deployments.
 *
 * Architecture:
 *   - In-process EventEmitter handles same-process subscriptions (always active)
 *   - Redis pub/sub broadcasts events to other containers when REDIS_URL is set
 *   - Events loop protection: messages received from Redis are NOT re-published to Redis
 *
 * Namespace enforcement (§7.4):
 *   - Extensions may ONLY publish to  ext.<scope>.*
 *   - Host publishes to               plexo.*
 *   - System events live on           sys.*
 *
 * Topic format: <namespace>.<scope>.<event>
 *   e.g. ext.acme_stripe-monitor.invoice_paid
 *        plexo.task.status_changed
 *        sys.extension.activated
 */
import { EventEmitter } from 'events'
import pino from 'pino'

const logger = pino({ name: 'kapsel-event-bus' })

export const TOPICS = {
    TASK_STATUS_CHANGED: 'plexo.task.status_changed',
    TASK_CREATED: 'plexo.task.created',
    TASK_COMPLETED: 'plexo.task.completed',
    TASK_FAILED: 'plexo.task.failed',
    MESSAGE_RECEIVED: 'plexo.message.received',
    MESSAGE_SENT: 'plexo.message.sent',
    EXTENSION_ACTIVATED: 'sys.extension.activated',
    EXTENSION_DEACTIVATED: 'sys.extension.deactivated',
    EXTENSION_CRASHED: 'sys.extension.crashed',
    WORKSPACE_MEMBER_ADDED: 'plexo.workspace.member_added',
    WORKSPACE_MEMBER_REMOVED: 'plexo.workspace.member_removed',
    OWD_PENDING: 'plexo.owd.pending',
    OWD_RESOLVED: 'plexo.owd.resolved',
} as const

export type StandardTopic = typeof TOPICS[keyof typeof TOPICS]

const REDIS_CHANNEL = 'kapsel:events'

export function extensionTopic(extensionName: string, event: string): string {
    const scope = extensionName.replace(/^@/, '').replace('/', '_')
    return `ext.${scope}.${event}`
}

export function isValidExtensionTopic(extensionName: string, topic: string): boolean {
    const scope = extensionName.replace(/^@/, '').replace('/', '_')
    return topic.startsWith(`ext.${scope}.`)
}

type Handler = (payload: unknown, topic: string) => void | Promise<void>

interface RedisLike {
    publish(channel: string, message: string): Promise<unknown>
    subscribe(channel: string, listener: (msg: string) => void): Promise<unknown>
    duplicate(): RedisLike
    connect(): Promise<void>
    quit(): Promise<void>
}

class KapselEventBus {
    private readonly emitter = new EventEmitter()
    private redisPub: RedisLike | null = null
    private redisSub: RedisLike | null = null
    private redisReady = false

    constructor() {
        this.emitter.setMaxListeners(200)
        // Connect to Redis in the background if REDIS_URL is set
        void this.initRedis()
    }

    private async initRedis() {
        const redisUrl = process.env.REDIS_URL
        if (!redisUrl) return // single-process mode is fine

        try {
            const { createClient } = await import('redis')
            const pub = createClient({ url: redisUrl }) as unknown as RedisLike
            const sub = pub.duplicate()
            pub.connect().catch((e: Error) => logger.error({ err: e }, 'Event bus Redis pub connect failed'))
            sub.connect().catch((e: Error) => logger.error({ err: e }, 'Event bus Redis sub connect failed'))

            // Receive events from other containers
            await sub.subscribe(REDIS_CHANNEL, (msg: string) => {
                try {
                    const { topic, payload } = JSON.parse(msg) as { topic: string; payload: unknown }
                    // Emit locally without re-publishing to Redis (loop protection)
                    this.emitLocal(topic, payload)
                } catch {
                    // Malformed message — ignore
                }
            })

            this.redisPub = pub
            this.redisSub = sub
            this.redisReady = true
            logger.info({ url: redisUrl.replace(/\/\/.*@/, '//***@') }, 'Event bus Redis fan-out active')
        } catch (err) {
            logger.warn({ err }, 'Event bus Redis init failed — single-process mode')
        }
    }

    subscribe(topic: string, handler: Handler): () => void {
        const listener = (payload: unknown) => {
            Promise.resolve(handler(payload, topic)).catch((err) =>
                logger.error({ err, topic }, 'Event handler threw'),
            )
        }
        this.emitter.on(topic, listener)
        return () => this.emitter.off(topic, listener)
    }

    publish(topic: string, payload: unknown, extensionName?: string): void {
        if (extensionName) {
            if (!isValidExtensionTopic(extensionName, topic)) {
                const scope = extensionName.replace(/^@/, '').replace('/', '_')
                throw new Error(
                    `CAPABILITY_DENIED: extension "${extensionName}" may only publish to ext.${scope}.* (attempted: "${topic}")`,
                )
            }
        }

        this.emitLocal(topic, payload)

        // Fan out to other containers via Redis
        if (this.redisReady && this.redisPub) {
            void this.redisPub.publish(REDIS_CHANNEL, JSON.stringify({ topic, payload })).catch((err: Error) =>
                logger.error({ err, topic }, 'Redis publish failed'),
            )
        }

        logger.debug({ topic, ext: extensionName ?? 'host' }, 'Event published')
    }

    private emitLocal(topic: string, payload: unknown): void {
        this.emitter.emit(topic, payload)
        // Wildcard matching: 'plexo.task.*' listeners get all plexo.task.* events
        const parts = topic.split('.')
        for (let i = parts.length - 1; i >= 1; i--) {
            const wildcard = parts.slice(0, i).join('.') + '.*'
            if (this.emitter.listenerCount(wildcard) > 0) {
                this.emitter.emit(wildcard, payload)
            }
        }
    }

    emitSystem(topic: StandardTopic, payload: unknown): void {
        this.publish(topic, payload)
    }

    listenerCount(topic: string): number {
        return this.emitter.listenerCount(topic)
    }

    async shutdown(): Promise<void> {
        try {
            await this.redisSub?.quit()
            await this.redisPub?.quit()
        } catch { /* best-effort */ }
    }
}

export const eventBus = new KapselEventBus()
