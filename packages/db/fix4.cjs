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
const alterConstraintRegex = /ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" (FOREIGN KEY [^;]+);/g;
content = content.replace(alterConstraintRegex, (match) => {
  return `DO $block$ BEGIN EXECUTE $query$${match}$query$; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $block$;`;
});

// ALTER TABLE ADD COLUMN -> ADD COLUMN IF NOT EXISTS
content = content.replace(/ADD COLUMN "([^"]+)"/g, 'ADD COLUMN IF NOT EXISTS "$1"');

// ALTER TABLE DROP COLUMN -> DROP COLUMN IF EXISTS
content = content.replace(/DROP COLUMN "([^"]+)"/g, 'DROP COLUMN IF EXISTS "$1"');

// DROP TYPE -> DROP TYPE IF EXISTS
content = content.replace(/DROP TYPE "public"\."([^"]+)"/g, 'DROP TYPE IF EXISTS "public"."$1"');

fs.writeFileSync('drizzle/0016_productive_galactus.sql', content);
