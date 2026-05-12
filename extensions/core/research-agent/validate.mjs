// Quick manifest validation sanity check.
// Run: node extensions/core/research-agent/validate.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(__dir, 'plexo.json'), 'utf8'))

const { validateManifest } = await import('../../../packages/sdk/src/index.ts')
const result = validateManifest(manifest, { hostComplianceLevel: 'full' })

console.log(JSON.stringify(result, null, 2))
if (!result.valid) process.exit(1)
