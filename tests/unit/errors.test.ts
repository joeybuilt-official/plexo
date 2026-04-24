import { describe, it, expect } from 'vitest'
import { PlexoError, NotImplementedError } from '../../packages/agent/src/errors.js'

describe('PlexoError', () => {
    it('extends Error', () => {
        const err = new PlexoError('test', 'TEST_CODE', 'system', 500)
        expect(err).toBeInstanceOf(Error)
    })

    it('sets name to PlexoError', () => {
        const err = new PlexoError('msg', 'CODE', 'user', 400)
        expect(err.name).toBe('PlexoError')
    })

    it('preserves category and statusCode', () => {
        const err = new PlexoError('upstream failed', 'UPSTREAM', 'upstream', 502)
        expect(err.category).toBe('upstream')
        expect(err.statusCode).toBe(502)
        expect(err.code).toBe('UPSTREAM')
    })

    it('message is accessible', () => {
        const err = new PlexoError('hello', 'HI', 'system', 500)
        expect(err.message).toBe('hello')
    })
})

describe('NotImplementedError', () => {
    it('extends PlexoError', () => {
        const err = new NotImplementedError('myMethod')
        expect(err).toBeInstanceOf(PlexoError)
    })

    it('has NOT_IMPLEMENTED code', () => {
        const err = new NotImplementedError('doSomething')
        expect(err.code).toBe('NOT_IMPLEMENTED')
        expect(err.statusCode).toBe(501)
    })

    it('includes method name in message', () => {
        const err = new NotImplementedError('executeAgent')
        expect(err.message).toContain('executeAgent')
    })
})
