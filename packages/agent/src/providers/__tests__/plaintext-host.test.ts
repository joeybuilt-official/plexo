// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { isPlaintextHttpHost } from '../registry.js'

describe('isPlaintextHttpHost', () => {
    it('keeps internal / private hosts on plaintext http', () => {
        expect(isPlaintextHttpHost('ollama')).toBe(true)          // docker service name
        expect(isPlaintextHttpHost('localhost')).toBe(true)
        expect(isPlaintextHttpHost('127.0.0.1')).toBe(true)
        expect(isPlaintextHttpHost('10.0.5.2')).toBe(true)
        expect(isPlaintextHttpHost('192.168.1.50')).toBe(true)
        expect(isPlaintextHttpHost('172.18.0.30')).toBe(true)
        expect(isPlaintextHttpHost('100.64.0.1')).toBe(true)   // Tailscale CGNAT
        expect(isPlaintextHttpHost('example.ts.net')).toBe(true)
        expect(isPlaintextHttpHost('nas.local')).toBe(true)
        expect(isPlaintextHttpHost('server.lan')).toBe(true)
    })

    it('upgrades public dotted hosts', () => {
        expect(isPlaintextHttpHost('ollama.example.com')).toBe(false)
        expect(isPlaintextHttpHost('34.120.59.49')).toBe(false)   // public IP
        expect(isPlaintextHttpHost('100.20.1.1')).toBe(false)     // public 100.x outside CGNAT /10
        expect(isPlaintextHttpHost('172.32.0.1')).toBe(false)     // outside 172.16/12
    })
})
