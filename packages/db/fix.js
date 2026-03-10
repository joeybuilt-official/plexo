const fs = require('fs');
let content = fs.readFileSync('drizzle/0016_productive_galactus.sql', 'utf8');

// Replace CREATE TABLE
content = content.replace(/CREATE TABLE "([^"]+)"/g, 'CREATE TABLE IF NOT EXISTS "$1"');

// Replace CREATE INDEX
content = content.replace(/CREATE INDEX "([^"]+)"/g, 'CREATE INDEX IF NOT EXISTS "$1"');

// Replace CREATE UNIQUE INDEX
content = content.replace(/CREATE UNIQUE INDEX "([^"]+)"/g, 'CREATE UNIQUE INDEX IF NOT EXISTS "$1"');

// Replace CREATE TYPE (using regex to find CREATE TYPE "public"."...." AS ENUM(...) )
// and wrap it in DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;
content = content.replace(/CREATE TYPE "public"\."([^"]+)" AS ENUM\(([^)]+)\);/g, 'DO $$ BEGIN CREATE TYPE "public"."$1" AS ENUM($2); EXCEPTION WHEN duplicate_object THEN NULL; END $$;');

// Replace ADD VALUE
content = content.replace(/ADD VALUE '([^']+)'/g, "ADD VALUE IF NOT EXISTS '$1'");

// There are ALTER TABLE ... ADD CONSTRAINT.
// PostgreSQL does not support ADD CONSTRAINT IF NOT EXISTS cleanly. But if tables already existed...
// Actually, if the constraints already exist, it will throw.
// Let's wrap ALTER TABLE ... ADD CONSTRAINT in a DO block.
content = content.replace(/ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" (FOREIGN KEY [^;]+);/g, `DO $$ BEGIN ALTER TABLE "$1" ADD CONSTRAINT "$2" $3; EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN others THEN IF SQLSTATE = '42710' THEN NULL; ELSE RAISE; END IF; END $$;`);

fs.writeFileSync('drizzle/0016_productive_galactus.sql', content);
