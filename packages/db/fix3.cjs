const fs = require('fs');

let content = fs.readFileSync('drizzle/0016_productive_galactus.sql', 'utf8');

// CREATE TYPE -> wrap in DO ... EXECUTE
content = content.replace(/CREATE TYPE "public"\."([^"]+)" AS ENUM\(([^)]+)\);/g, (match) => {
  return `DO $block$ BEGIN EXECUTE $query$${match}$query$; EXCEPTION WHEN duplicate_object THEN NULL; END $block$;`;
});

// CREATE TABLE -> CREATE TABLE IF NOT EXISTS
content = content.replace(/CREATE TABLE "([^"]+)" \(/g, 'CREATE TABLE IF NOT EXISTS "$1" (\n');

// CREATE INDEX -> CREATE INDEX IF NOT EXISTS
content = content.replace(/CREATE INDEX "([^"]+)" ON/g, 'CREATE INDEX IF NOT EXISTS "$1" ON');

// CREATE UNIQUE INDEX -> CREATE UNIQUE INDEX IF NOT EXISTS
content = content.replace(/CREATE UNIQUE INDEX "([^"]+)" ON/g, 'CREATE UNIQUE INDEX IF NOT EXISTS "$1" ON');

// ALTER TYPE ADD VALUE -> ADD VALUE IF NOT EXISTS
content = content.replace(/ADD VALUE '([^']+)'/g, "ADD VALUE IF NOT EXISTS '$1'");

// ALTER TABLE ADD CONSTRAINT -> wrap in DO ... EXECUTE
// There are multiple lines like:
// ALTER TABLE "task" ADD CONSTRAINT "task_proj_fk" FOREIGN KEY ("project_id") REFERENCES "public"."sprints"("id") ON DELETE set null ON UPDATE no action;
const alterConstraintRegex = /ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" (FOREIGN KEY [^;]+);/g;
content = content.replace(alterConstraintRegex, (match) => {
  return `DO $block$ BEGIN EXECUTE $query$${match}$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;`;
});

fs.writeFileSync('drizzle/0016_productive_galactus.sql', content);
