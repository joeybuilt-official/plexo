const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) { 
            results = results.concat(walk(file));
        } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
            results.push(file);
        }
    });
    return results;
}

const files = walk('./apps/web/src');
let changedCount = 0;

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    
    // Replace API/api/ with API/api/v1/ or /api/ with /api/v1/
    // We want to replace paths that start with `/api/` or `${API}/api/` strings in fetch calls.
    // Specifically, let's look for expressions like `fetch(`${API_BASE}/api/...` or `fetch('/api/...`
    // but ONLY those that match the v1 routes!
    // The v1 routes: sse, auth, oauth, tasks, sprints, dashboard, approvals, channels, memory, connections, workspaces, settings, cron, users, invites, plugins, registry, audit, telemetry, debug, chat, behavior
    const v1Routes = ['sse', 'auth', 'oauth', 'tasks', 'sprints', 'dashboard', 'approvals', 'channels', 'memory', 'connections', 'workspaces', 'settings', 'cron', 'users', 'invites', 'plugins', 'registry', 'audit', 'telemetry', 'debug', 'chat', 'behavior', 'agent'];
    
    // Regular expression to match `/api/` followed by any of the v1 routes.
    // It captures the prefix (e.g., tick mark, quote, or template var) and the matched route
    // Note: Do not match if it's already `/api/v1/`
    const regex = new RegExp(`(\\/api\\/)(?!v1\\/)(${v1Routes.join('|')})`, 'g');
    
    let newContent = content.replace(regex, '/api/v1/$2');
    
    if (newContent !== content) {
        fs.writeFileSync(file, newContent, 'utf8');
        changedCount++;
        console.log(`Updated ${file}`);
    }
});
console.log(`Finished updating ${changedCount} files.`);
