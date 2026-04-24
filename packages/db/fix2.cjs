const fs = require('fs');
let content = fs.readFileSync('drizzle/0016_productive_galactus.sql', 'utf8');

// Replace CREATE TABLE "..." (
content = content.replace(/CREATE TABLE "([^"]+)" \(/g, 'CREATE TABLE IF NOT EXISTS "$1" (\n');

// Replace CREATE INDEX "..." ON
content = content.replace(/CREATE INDEX (?!IF NOT EXISTS)"([^"]+)" ON/g, 'CREATE INDEX IF NOT EXISTS "$1" ON');

// Replace CREATE UNIQUE INDEX "..." ON
content = content.replace(/CREATE UNIQUE INDEX (?!IF NOT EXISTS)"([^"]+)" ON/g, 'CREATE UNIQUE INDEX IF NOT EXISTS "$1" ON');

// Replace CREATE TYPE "public"."...." AS ENUM(...);
content = content.replace(/CREATE TYPE "public"\."([^"]+)" AS ENUM\(([^)]+)\);/g, 'DO $$ BEGIN CREATE TYPE "public"."$1" AS ENUM($2); EXCEPTION WHEN duplicate_object THEN NULL; END $$;');

// Replace ADD VALUE '...'
content = content.replace(/ADD VALUE '([^']+)'/g, "ADD VALUE IF NOT EXISTS '$1'");

// Replace ALTER TABLE "..." ADD CONSTRAINT "..." FOREIGN KEY ...;
// We will wrap this in a DO block. The syntax is:
content = content.replace(/ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" (FOREIGN KEY [^;]+);/g, 
  `DO $$ BEGIN ALTER TABLE "$1" ADD CONSTRAINT "$2" $3; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $$;`);

fs.writeFileSync('drizzle/0016_productive_galactus.sql', content);
