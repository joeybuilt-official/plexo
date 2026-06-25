import { db, workspaces, workspaceMembers, DEFAULT_INTELLIGENCE_SETTINGS, DEFAULT_WORKSPACE_SETTINGS } from './src/index.js';
const userId = '00000000-0000-0000-0000-000000000002';
const workspaceId = '00000000-0000-0000-0000-000000000003';

async function run() {
    try {
        await db.insert(workspaces).values({
            id: workspaceId,
            name: 'Default Workspace',
            ownerId: userId,
            settings: DEFAULT_WORKSPACE_SETTINGS,
            intelligenceSettings: DEFAULT_INTELLIGENCE_SETTINGS,
        });
        await db.insert(workspaceMembers).values({
            workspaceId,
            userId,
            role: 'owner'
        });
        console.log('Workspace seeded successfully');
    } catch (e) {
        console.error('Seeding failed', e);
    }
}
run();
