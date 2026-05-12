import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'connect/index': 'src/connect/index.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    // platform:'node' + post-build prefix restore. esbuild (even with platform:'node')
    // strips the `node:` prefix from external imports during ESM emit, which breaks
    // Next.js webpack + edge bundling at consumer sites (they can't resolve bare `crypto`).
    // The onSuccess hook rewrites bare `from "crypto"` → `from "node:crypto"` in dist.
    platform: 'node',
    target: 'node22',
    external: ['node:crypto'],
    onSuccess: async () => {
        const { readFile, writeFile, readdir } = await import('node:fs/promises')
        const { join } = await import('node:path')
        async function walk(dir: string): Promise<string[]> {
            const entries = await readdir(dir, { withFileTypes: true })
            const out: string[] = []
            for (const e of entries) {
                const p = join(dir, e.name)
                if (e.isDirectory()) out.push(...(await walk(p)))
                else if (e.isFile() && p.endsWith('.js')) out.push(p)
            }
            return out
        }
        const files = await walk('dist')
        const NODE_BUILTINS = ['crypto', 'fs', 'path', 'os', 'http', 'https', 'url', 'stream']
        const re = new RegExp(
            `from\\s+(['"])(?!node:)(${NODE_BUILTINS.join('|')})(['"])`,
            'g',
        )
        for (const file of files) {
            const src = await readFile(file, 'utf8')
            const out = src.replace(re, 'from $1node:$2$3')
            if (out !== src) await writeFile(file, out)
        }
    },
})
