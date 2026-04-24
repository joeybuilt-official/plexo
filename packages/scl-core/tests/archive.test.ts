import { describe, it, expect } from 'vitest'
import { boot } from '../src/boot.js'
import { archive } from '../src/archive.js'
import { mutate } from '../src/mutate.js'
import { V_IDENTITY, V_OPERATOR, V_CODING, TEST_WORKSPACE } from './fixtures/vectors.js'

describe('archive', () => {
    it('removes attractor from record', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'A', type: 'entity', position: V_IDENTITY },
                { label: 'B', type: 'entity', position: V_OPERATOR },
            ],
        })

        const targetId = record.attractors[0]!.id
        const { record: newRecord } = archive(record, targetId)

        expect(newRecord.attractors).toHaveLength(1)
        expect(newRecord.attractors.find(a => a.id === targetId)).toBeUndefined()
    })

    it('creates LedgerPointer with position at archival', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'Identity', type: 'entity', position: V_IDENTITY },
            ],
        })

        const targetId = record.attractors[0]!.id
        const { pointer } = archive(record, targetId)

        expect(pointer.ghostLabel).toBe('Identity')
        expect(pointer.positionAtArchival).toEqual(V_IDENTITY)
        expect(pointer.archivedAt).toBeGreaterThan(0)
        expect(pointer.externalRef).toBeTruthy()
    })

    it('adds pointer to ledgerRefs', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'A', type: 'entity', position: V_IDENTITY },
            ],
        })

        const { record: newRecord, pointer } = archive(record, record.attractors[0]!.id)

        expect(newRecord.ledgerRefs).toHaveLength(1)
        expect(newRecord.ledgerRefs[0]!.externalRef).toBe(pointer.externalRef)
    })

    it('throws for unknown attractor ID', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [{ label: 'A', type: 'entity', position: V_IDENTITY }],
        })

        expect(() => archive(record, 'nonexistent')).toThrow('not found')
    })

    it('does not modify the original record', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [
                { label: 'A', type: 'entity', position: V_IDENTITY },
                { label: 'B', type: 'entity', position: V_OPERATOR },
            ],
        })

        const originalCount = record.attractors.length
        archive(record, record.attractors[0]!.id)

        expect(record.attractors).toHaveLength(originalCount) // original unchanged
    })

    it('updates lastMutatedAt', () => {
        const record = boot({
            workspaceId: TEST_WORKSPACE,
            spiritAnchors: [{ label: 'A', type: 'entity', position: V_IDENTITY }],
        })

        const before = record.lastMutatedAt
        const { record: newRecord } = archive(record, record.attractors[0]!.id)

        expect(newRecord.lastMutatedAt).toBeGreaterThanOrEqual(before)
    })
})
