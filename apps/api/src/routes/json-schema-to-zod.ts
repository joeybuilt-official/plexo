// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Minimal runtime JSON Schema → Zod converter, scoped to the subset that
 * Graphiti emits via Pydantic `model_json_schema()`:
 *   - object/array/string/number/integer/boolean/null
 *   - properties + required + additionalProperties:false
 *   - items
 *   - enum
 *   - anyOf / oneOf (treated as union)
 *   - $ref / $defs (Pydantic nested models)
 *   - description
 *   - nullable via {type: [..., "null"]} or anyOf with {type:"null"}
 *
 * Out of scope (will throw): allOf, conditional schemas, format/pattern
 * validation, dependentSchemas, propertyNames, prefixItems. Those don't
 * appear in Graphiti's extraction schemas as of 2026-05-09.
 *
 * Why hand-rolled: the available runtime libs (json-schema-to-zod is
 * codegen-only; @n8n/json-schema-to-zod ships an ESM build that Node's
 * strict resolver rejects) are wrong tools for the job. The subset above
 * is small enough that owning the conversion is cheaper than fighting
 * a third-party ESM bug.
 */

import { z, ZodTypeAny } from 'zod'

export interface JSONSchema {
    type?: string | string[]
    properties?: Record<string, JSONSchema>
    required?: string[]
    additionalProperties?: boolean | JSONSchema
    items?: JSONSchema | JSONSchema[]
    enum?: unknown[]
    const?: unknown
    anyOf?: JSONSchema[]
    oneOf?: JSONSchema[]
    $ref?: string
    $defs?: Record<string, JSONSchema>
    definitions?: Record<string, JSONSchema>
    description?: string
    default?: unknown
    minLength?: number
    maxLength?: number
    minimum?: number
    maximum?: number
    nullable?: boolean
}

interface Ctx {
    defs: Record<string, JSONSchema>
}

export function jsonSchemaToZod(schema: JSONSchema): ZodTypeAny {
    const defs = { ...(schema.$defs ?? {}), ...(schema.definitions ?? {}) }
    return convert(schema, { defs })
}

function convert(s: JSONSchema, ctx: Ctx): ZodTypeAny {
    if (s.$ref) return resolveRef(s.$ref, ctx)
    if (s.const !== undefined) return z.literal(s.const as never)
    if (Array.isArray(s.enum) && s.enum.length > 0) return enumSchema(s.enum)
    if (Array.isArray(s.anyOf) && s.anyOf.length > 0) return unionOf(s.anyOf, ctx)
    if (Array.isArray(s.oneOf) && s.oneOf.length > 0) return unionOf(s.oneOf, ctx)

    const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : []
    const nullable = types.includes('null') || s.nullable === true
    const nonNull = types.filter((t) => t !== 'null')

    let base: ZodTypeAny
    if (nonNull.length === 0) {
        base = z.unknown()
    } else if (nonNull.length === 1) {
        base = convertScalar(nonNull[0]!, s, ctx)
    } else {
        base = z.union(nonNull.map((t) => convertScalar(t, s, ctx)) as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]])
    }

    if (s.description) base = base.describe(s.description)
    if (nullable) base = base.nullable()
    return base
}

function convertScalar(type: string, s: JSONSchema, ctx: Ctx): ZodTypeAny {
    switch (type) {
        case 'string': {
            let zs = z.string()
            if (typeof s.minLength === 'number') zs = zs.min(s.minLength)
            if (typeof s.maxLength === 'number') zs = zs.max(s.maxLength)
            return zs
        }
        case 'integer': {
            let zn = z.number().int()
            if (typeof s.minimum === 'number') zn = zn.gte(s.minimum)
            if (typeof s.maximum === 'number') zn = zn.lte(s.maximum)
            return zn
        }
        case 'number': {
            let zn = z.number()
            if (typeof s.minimum === 'number') zn = zn.gte(s.minimum)
            if (typeof s.maximum === 'number') zn = zn.lte(s.maximum)
            return zn
        }
        case 'boolean':
            return z.boolean()
        case 'null':
            return z.null()
        case 'array': {
            const itemSchema: JSONSchema = Array.isArray(s.items) ? (s.items[0] ?? {}) : (s.items ?? {})
            return z.array(convert(itemSchema, ctx))
        }
        case 'object': {
            const shape: Record<string, ZodTypeAny> = {}
            const required = new Set(s.required ?? [])
            for (const [k, v] of Object.entries(s.properties ?? {})) {
                let field = convert(v, ctx)
                if (!required.has(k)) field = field.optional()
                shape[k] = field
            }
            const obj = z.object(shape)
            if (s.additionalProperties === false) return obj.strict()
            if (s.additionalProperties === true || s.additionalProperties === undefined) return obj.passthrough()
            return obj.catchall(convert(s.additionalProperties, ctx))
        }
        default:
            return z.unknown()
    }
}

function unionOf(branches: JSONSchema[], ctx: Ctx): ZodTypeAny {
    const zs = branches.map((b) => convert(b, ctx))
    if (zs.length === 1) return zs[0]!
    return z.union(zs as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]])
}

function enumSchema(values: unknown[]): ZodTypeAny {
    if (values.every((v) => typeof v === 'string')) {
        return z.enum(values as [string, ...string[]])
    }
    if (values.length === 1) return z.literal(values[0] as never)
    const literals = values.map((v) => z.literal(v as never)) as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]
    return z.union(literals)
}

function resolveRef(ref: string, ctx: Ctx): ZodTypeAny {
    const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref)
    if (!m) throw new Error(`unsupported $ref: ${ref}`)
    const target = ctx.defs[m[1]!]
    if (!target) throw new Error(`unresolved $ref: ${ref}`)
    return convert(target, ctx)
}
