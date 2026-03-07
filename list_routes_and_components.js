const fs = require('fs');
console.log("Existing API Routes (apps/api/src/routes):");
const routes = fs.readdirSync('./apps/api/src/routes');
console.log(routes.join(', '));

console.log("\nExisting Web UI Components (apps/web/src/components):");
const collectFiles = (dir) => {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = dir + '/' + file;
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) { 
      results = results.concat(collectFiles(file));
    } else { 
      results.push(file);
    }
  });
  return results;
}
console.log(collectFiles('./apps/web/src/components').map(f => f.replace('./apps/web/src/components/', '')).join(', '));
