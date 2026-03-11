// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { launchPersona } from '../runner.js'
import * as personas from '../personas/index.js'
import { Command } from 'commander'

const program = new Command()

program
  .name('simulate')
  .description('Run automated user simulations')
  .option('-p, --persona <id>', 'Persona ID to run')
  .option('-v, --viewport <width>x<height>', 'Viewport size', '1280x720')
  .option('--headless <boolean>', 'Run in headless mode', 'true')
  .option('--baseURL <url>', 'Base URL of the application', 'http://localhost:3000')

program.parse()

const options = program.opts()

async function main() {
    const list = Object.values(personas).filter(p => typeof p === 'object' && 'id' in p) as personas.Persona[]
    
    const target = options.persona ? list.find(p => p.id === options.persona) : null

    if (options.persona && !target) {
        console.error(`Persona "${options.persona}" not found. Available:`, list.map(p => p.id).join(', '))
        process.exit(1)
    }

    const toRun = target ? [target] : list

    console.log(`Starting simulation for ${toRun.length} personas...`)

    for (const p of toRun) {
        console.log(`[${p.id}] Running: ${p.name}...`)
        const [w, h] = (p.viewport ? `${p.viewport.width}x${p.viewport.height}` : options.viewport).split('x').map(Number)
        
        let handle: Awaited<ReturnType<typeof launchPersona>> | null = null
        try {
            handle = await launchPersona({
                personaId: p.id,
                headless: options.headless === 'true',
                viewport: { width: w, height: h },
                baseURL: options.baseURL,
                userAgent: p.userAgent
            })

            await handle.session.logEvent('simulation_started', { persona: p.id })
            
            await p.run(handle.page, handle.session)

            await handle.session.complete('Simulation completed successfully')
            console.log(`[${p.id}] Success!`)
        } catch (err) {
            console.error(`[${p.id}] Failed:`, err)
        } finally {
            if (handle) await handle.cleanup().catch(() => {})
        }
    }
}

main().catch(console.error).finally(() => process.exit(0))
