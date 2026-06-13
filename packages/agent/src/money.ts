// A6 cutover helper. Treat USD money as integer micro-USD (bigint) to keep
// compares + accumulation lossless once pg numeric(18,6) columns are in play.
// pg returns numeric as JS string; this module accepts string | number | null.
//
// Display path still uses Number(); precision loss is fine for human output.
// The point of integer micro is the compare/accumulate path that gates spend.
//
// 6 decimal places matches DRAFT_money_numeric.sql (numeric(18,6)).

const MICRO_PER_UNIT = 1_000_000n
const SCALE = 6

/**
 * Parse a money value as integer micro-USD. Accepts:
 *   - pg numeric string ("5.390990", "-0.000001", "1e3")
 *   - number (multiplied by 1e6 then rounded — only safe for in-range values)
 *   - null/undefined → 0n
 * Throws on unparseable strings. Anything beyond 6 decimal digits is rounded
 * (banker-style isn't worth it here; plain trunc-of-microstring is enough).
 */
export function toMicro(v: string | number | bigint | null | undefined): bigint {
    if (v == null) return 0n
    if (typeof v === 'bigint') return v
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return 0n
        return BigInt(Math.round(v * 1_000_000))
    }
    const s = v.trim()
    if (s === '' || s === 'NaN') return 0n
    // Handle scientific notation by routing through Number() (acceptable for
    // models_knowledge per-token rates, which are well within IEEE-754 range).
    if (/[eE]/.test(s)) return BigInt(Math.round(Number(s) * 1_000_000))
    const neg = s.startsWith('-')
    const body = neg ? s.slice(1) : (s.startsWith('+') ? s.slice(1) : s)
    const parts = body.split('.')
    const intPartRaw = parts[0] ?? ''
    const fracPartRaw = parts[1] ?? ''
    const intPart = intPartRaw === '' ? '0' : intPartRaw
    if (!/^\d+$/.test(intPart) || (fracPartRaw && !/^\d+$/.test(fracPartRaw))) {
        throw new TypeError(`toMicro: unparseable money string "${v}"`)
    }
    const fracPadded = (fracPartRaw + '000000').slice(0, SCALE)
    const micro = BigInt(intPart) * MICRO_PER_UNIT + BigInt(fracPadded)
    return neg ? -micro : micro
}

export function addMicro(a: bigint, b: bigint): bigint {
    return a + b
}

export function cmpMicro(a: bigint, b: bigint): -1 | 0 | 1 {
    return a < b ? -1 : a > b ? 1 : 0
}

/** Format integer micro-USD as a fixed-decimal string ("5.39", "0.123456"). */
export function fmtMicroUsd(micro: bigint, decimals = 2): string {
    const neg = micro < 0n
    const abs = neg ? -micro : micro
    const int = abs / MICRO_PER_UNIT
    const frac = abs % MICRO_PER_UNIT
    const fracStr = frac.toString().padStart(SCALE, '0')
    const fracShown = decimals === 0 ? '' : '.' + fracStr.slice(0, decimals).padEnd(decimals, '0')
    return (neg ? '-' : '') + int.toString() + fracShown
}

/** Convenience: display micro as a number (only for logs/UI, never for compare). */
export function microToNumber(micro: bigint): number {
    return Number(micro) / 1_000_000
}
