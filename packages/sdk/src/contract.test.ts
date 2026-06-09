// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { PEX_CONTRACT_VERSION, isContractCompatible } from './contract.js'

describe('isContractCompatible', () => {
    it('same major → compatible (minor/patch skew tolerated)', () => {
        expect(isContractCompatible('0.4.0', '0.4.0')).toBe(true)
        expect(isContractCompatible('0.1.0', '0.9.5')).toBe(true)
        expect(isContractCompatible('0.4.0', PEX_CONTRACT_VERSION)).toBe(true)
    })
    it('different major → incompatible', () => {
        expect(isContractCompatible('0.4.0', '1.0.0')).toBe(false)
        expect(isContractCompatible('2.0.0', '1.0.0')).toBe(false)
    })
    it('unparseable → incompatible (fail-loud)', () => {
        expect(isContractCompatible('', '0.4.0')).toBe(false)
        expect(isContractCompatible('garbage', '0.4.0')).toBe(false)
    })
})
