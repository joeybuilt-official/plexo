// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Guards the read-only cypher proxy (POST /v1/graph/cypher → graph.ts).
 * isWriteCypher MUST return true for any mutating clause so a service-key
 * caller can't write through this surface, AND must strip // and / * * /
 * comments first so a write keyword can't hide behind a comment.
 *
 * Security-critical: a false negative (write classified as read) would let a
 * write slip through the read-only surface.
 */

import { describe, it, expect } from 'vitest'
import { isWriteCypher, clampCypherLimit, MAX_CYPHER_LIMIT } from '../graph.js'

const READ_CASES: Array<[string, string]> = [
  ['plain match/return', 'MATCH (n:Entity)-[r:RELATES_TO]->(m:Entity) RETURN n, m LIMIT 500'],
  ['count aggregate', 'MATCH (n) RETURN count(n) AS c'],
  ['db.labels procedure', 'CALL db.labels()'],
  ['db.relationshipTypes procedure', 'CALL db.relationshipTypes()'],
  ['write hidden in block comment', 'MATCH (n) /* CREATE (x) */ RETURN n'],
  ['write hidden in line comment', 'MATCH (n) RETURN n // DELETE n'],
]

const WRITE_CASES: Array<[string, string]> = [
  ['CREATE', 'CREATE (x:Foo) RETURN x'],
  ['DETACH DELETE', 'MATCH (n) DETACH DELETE n'],
  ['MERGE', 'MERGE (a:X {id:1})'],
  ['SET', 'MATCH (n) SET n.x = 1'],
  ['REMOVE', 'MATCH (n) REMOVE n.x'],
  ['DROP', 'DROP INDEX foo'],
  ['FOREACH', 'FOREACH (x IN [1] | CREATE (:N))'],
  ['apoc.create', "CALL apoc.create.node(['L'], {})"],
  ['line-comment newline ends, CREATE real', 'MATCH (n) // ok\nCREATE (x)'],
]

describe('isWriteCypher — read-only (allowed) queries', () => {
  for (const [name, cypher] of READ_CASES) {
    it(`returns false for: ${name}`, () => {
      expect(isWriteCypher(cypher)).toBe(false)
    })
  }
})

describe('isWriteCypher — write (blocked) queries', () => {
  for (const [name, cypher] of WRITE_CASES) {
    it(`returns true for: ${name}`, () => {
      expect(isWriteCypher(cypher)).toBe(true)
    })
  }
})

function limitOf(cypher: string): number | null {
  const m = /\blimit\s+(\d+)\b/i.exec(cypher)
  return m ? Number(m[1]) : null
}

describe('clampCypherLimit — server-side row cap (defense-in-depth)', () => {
  it('leaves an in-range LIMIT untouched', () => {
    expect(limitOf(clampCypherLimit('MATCH (n) RETURN n LIMIT 500'))).toBe(500)
  })
  it('clamps an over-cap LIMIT down to the max', () => {
    expect(limitOf(clampCypherLimit('MATCH (n) RETURN n LIMIT 999999'))).toBe(MAX_CYPHER_LIMIT)
  })
  it('clamps a LIMIT equal to the boundary (no change)', () => {
    expect(limitOf(clampCypherLimit(`MATCH (n) RETURN n LIMIT ${MAX_CYPHER_LIMIT}`))).toBe(MAX_CYPHER_LIMIT)
  })
  it('appends a LIMIT when none is present', () => {
    expect(limitOf(clampCypherLimit('MATCH (n) RETURN n'))).toBe(MAX_CYPHER_LIMIT)
  })
  it('appends a LIMIT, stripping a trailing semicolon', () => {
    const out = clampCypherLimit('MATCH (n) RETURN n;')
    expect(out).not.toMatch(/;/)
    expect(limitOf(out)).toBe(MAX_CYPHER_LIMIT)
  })
  it('clamps the FINAL limit (e.g. after a subquery LIMIT)', () => {
    const out = clampCypherLimit('MATCH (n) WITH n LIMIT 10 RETURN n LIMIT 999999')
    expect(out).toMatch(/LIMIT 10\b/)
    expect(out.trimEnd().endsWith(`LIMIT ${MAX_CYPHER_LIMIT}`)).toBe(true)
  })
  it('ignores a commented-out LIMIT and appends a real cap', () => {
    const out = clampCypherLimit('MATCH (n) RETURN n // LIMIT 999999')
    expect(limitOf(out)).toBe(MAX_CYPHER_LIMIT)
    expect(out).not.toMatch(/999999/)
  })
})
