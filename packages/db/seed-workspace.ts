import { db, workspaces, workspaceMembers } from './src/index.js';
const userId = '32920f1a-99dd-4baa-be01-3b107035b903';
const workspaceId = '8200ac67-a6b9-4958-8a4e-e5ec87fffe9b';

async function run() {
    try {
        await db.insert(workspaces).values({
            id: workspaceId,
            name: 'Default Workspace',
            ownerId: userId,
            settings: {}
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
