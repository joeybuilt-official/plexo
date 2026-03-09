// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Config management — ~/.plexo/config.json
 *
 * Supports multiple named profiles via --profile flag.
 * Env vars override config file values (for CI/CD).
 */
import Conf from 'conf'
import os from 'node:os'
import path from 'node:path'

export interface PlexoProfile {
    host: string
    token: string        // opaque auth token stored by `plexo auth login`
    userId: string       // user UUID — sent as x-user-id header
    workspace: string    // workspace UUID
    defaultChannel?: 'telegram' | 'slack' | 'discord'
}

interface ConfigSchema {
    activeProfile: string
    profiles: Record<string, PlexoProfile>
}

const conf = new Conf<ConfigSchema>({
    projectName: 'plexo',
    cwd: path.join(os.homedir(), '.plexo'),
    defaults: {
        activeProfile: 'default',
        profiles: {},
    },
})

export function getProfileName(override?: string): string {
    return override ?? (process.env.PLEXO_PROFILE || conf.get('activeProfile'))
}

export function getProfile(profileName?: string): PlexoProfile | null {
    const name = getProfileName(profileName)
    const profiles = conf.get('profiles')
    const stored = profiles[name] ?? null

    // Env vars always win — useful for CI/CD
    const host = process.env.PLEXO_HOST || stored?.host
    const token = process.env.PLEXO_TOKEN || stored?.token
    const userId = process.env.PLEXO_USER_ID || stored?.userId
    const workspace = process.env.PLEXO_WORKSPACE || stored?.workspace

    if (!host || !token || !userId || !workspace) return null
    return { host, token, userId, workspace, defaultChannel: stored?.defaultChannel }
}

export function requireProfile(profileName?: string): PlexoProfile {
    const p = getProfile(profileName)
    if (!p) {
        console.error('Not logged in. Run: plexo auth login')
        process.exit(4)
    }
    return p
}

export function saveProfile(name: string, profile: PlexoProfile): void {
    const profiles = conf.get('profiles')
    profiles[name] = profile
    conf.set('profiles', profiles)
}

export function setActiveProfile(name: string): void {
    conf.set('activeProfile', name)
}

export function deleteProfile(name: string): void {
    const profiles = conf.get('profiles')
    delete profiles[name]
    conf.set('profiles', profiles)
    if (conf.get('activeProfile') === name) {
        conf.set('activeProfile', 'default')
    }
}

export function listProfiles(): Array<{ name: string; active: boolean; host: string }> {
    const profiles = conf.get('profiles')
    const active = conf.get('activeProfile')
    return Object.entries(profiles).map(([name, p]) => ({
        name,
        active: name === active,
        host: p.host,
    }))
}

export function setConfigValue(key: string, value: string, profileName?: string): void {
    const name = getProfileName(profileName)
    const profiles = conf.get('profiles')
    const profile = profiles[name] ?? { host: '', token: '', userId: '', workspace: '' }
        ; (profile as unknown as Record<string, unknown>)[key] = value
    profiles[name] = profile as PlexoProfile
    conf.set('profiles', profiles)
}

export function showConfig(profileName?: string): Record<string, unknown> {
    return {
        configFile: path.join(os.homedir(), '.plexo', 'config.json'),
        activeProfile: getProfileName(profileName),
        profiles: conf.get('profiles'),
    }
}
