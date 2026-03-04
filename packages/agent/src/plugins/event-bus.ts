/**
 * Kapsel Event Bus — host implementation (§7)
 *
 * The Event Bus is the pub/sub backbone for all Kapsel extensions.
 * Extensions subscribe and publish via sdk.events.subscribe/publish.
 *
 * Namespace enforcement (§7.4):
 *   - Extensions may ONLY publish to  ext.<scope>.*
 *   - Host publishes to               plexo.*
 *   - System events live on           sys.*
 *   - Cross-extension subscriptions   allowed (read-only from other ext namespaces)
 *
 * Implementation:
 *   - In-process EventEmitter for same-process pub/sub
 *   - Redis pub/sub for cross-container fan-out (when REDIS_URL is set)
 *   - Max listeners raised to avoid Node.js warning in multi-extension scenarios
 *
 * Topic format: <namespace>.<scope>.<event>
 *   e.g. ext.acme_stripe-monitor.invoice_paid
 *        plexo.task.status_changed
 *        sys.extension.activated
 */
import { EventEmitter } from 'events'
import pino from 'pino'

const logger = pino({ name: 'kapsel-event-bus' })

// Standard Plexo host topics (§7.4 table)
export const TOPICS = {
    // Task lifecycle
    TASK_STATUS_CHANGED: 'plexo.task.status_changed',
    TASK_CREATED: 'plexo.task.created',
    TASK_COMPLETED: 'plexo.task.completed',
    TASK_FAILED: 'plexo.task.failed',

    // Message events
    MESSAGE_RECEIVED: 'plexo.message.received',
    MESSAGE_SENT: 'plexo.message.sent',

    // Extension lifecycle
    EXTENSION_ACTIVATED: 'sys.extension.activated',
    EXTENSION_DEACTIVATED: 'sys.extension.deactivated',
    EXTENSION_CRASHED: 'sys.extension.crashed',

    // Workspace events
    WORKSPACE_MEMBER_ADDED: 'plexo.workspace.member_added',
    WORKSPACE_MEMBER_REMOVED: 'plexo.workspace.member_removed',
} as const

export type StandardTopic = typeof TOPICS[keyof typeof TOPICS]

/** Create a validated extension-scoped custom topic */
export function extensionTopic(extensionName: string, event: string): string {
    // @acme/stripe-monitor → ext.acme_stripe-monitor.<event>
    const scope = extensionName.replace(/^@/, '').replace('/', '_')
    return `ext.${scope}.${event}`
}

/** Validate that an extension-scoped topic matches the expected namespace */
export function isValidExtensionTopic(extensionName: string, topic: string): boolean {
    const scope = extensionName.replace(/^@/, '').replace('/', '_')
    return topic.startsWith(`ext.${scope}.`)
}

// ── Bus implementation ────────────────────────────────────────────────────────

type Handler = (payload: unknown, topic: string) => void | Promise<void>

class KapselEventBus {
    private readonly emitter = new EventEmitter()
    private redis: { pub: unknown; sub: unknown } | null = null

    constructor() {
        this.emitter.setMaxListeners(200) // supports many concurrent extensions
    }

    /**
     * Subscribe to one or more topics.
     * Wildcards with '*' suffix supported: 'plexo.task.*' matches all plexo task events.
     * Returns an unsubscribe function.
     */
    subscribe(topic: string, handler: Handler): () => void {
        const listener = (payload: unknown) => {
            Promise.resolve(handler(payload, topic)).catch((err) =>
                logger.error({ err, topic }, 'Event handler threw'),
            )
        }
        this.emitter.on(topic, listener)
        return () => this.emitter.off(topic, listener)
    }

    /**
     * Publish an event. Enforces namespace rules:
     *   - extensionName = null  → host publish, any plexo.* or sys.* topic allowed
     *   - extensionName = '@a/b' → only ext.a_b.* topics allowed
     *
     * Throws on namespace violation (§7.4).
     */
    publish(topic: string, payload: unknown, extensionName?: string): void {
        if (extensionName) {
            if (!isValidExtensionTopic(extensionName, topic)) {
                const scope = extensionName.replace(/^@/, '').replace('/', '_')
                throw new Error(
                    `CAPABILITY_DENIED: extension "${extensionName}" may only publish to ext.${scope}.* (attempted: "${topic}")`,
                )
            }
        }

        // Emit exact topic
        this.emitter.emit(topic, payload)

        // Emit wildcard listeners: 'plexo.task.*' etc.
        const parts = topic.split('.')
        for (let i = parts.length - 1; i >= 1; i--) {
            const wildcard = parts.slice(0, i).join('.') + '.*'
            if (this.emitter.listenerCount(wildcard) > 0) {
                this.emitter.emit(wildcard, payload)
            }
        }

        logger.debug({ topic, ext: extensionName ?? 'host' }, 'Event published')
    }

    /** Emit a host-controlled lifecycle event */
    emitSystem(topic: StandardTopic, payload: unknown): void {
        this.publish(topic, payload)
    }

    listenerCount(topic: string): number {
        return this.emitter.listenerCount(topic)
    }
}

// Singleton — shared across all extensions in this process
export const eventBus = new KapselEventBus()
