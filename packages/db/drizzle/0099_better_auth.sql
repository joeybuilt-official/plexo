-- Better Auth schema bootstrap.
-- Better Auth (better-auth ^1.5.6) connects with `SET search_path TO auth`,
-- but the migrate runner connects with the default `public` search_path so
-- every CREATE statement here is fully qualified with `auth.<table>`.
-- All statements use IF NOT EXISTS so re-running on a partially-applied DB
-- is safe.

CREATE SCHEMA IF NOT EXISTS auth;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS auth."user" (
    "id"            UUID        PRIMARY KEY,
    "email"         TEXT        NOT NULL UNIQUE,
    "emailVerified" BOOLEAN     NOT NULL DEFAULT false,
    "name"          TEXT,
    "image"         TEXT,
    "createdAt"     TIMESTAMP   NOT NULL DEFAULT now(),
    "updatedAt"     TIMESTAMP   NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS auth."session" (
    "id"        UUID        PRIMARY KEY,
    "userId"    UUID        NOT NULL REFERENCES auth."user"("id") ON DELETE CASCADE,
    "expiresAt" TIMESTAMP   NOT NULL,
    "token"     TEXT        NOT NULL UNIQUE,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP   NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP   NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON auth."session" ("userId");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS auth."account" (
    "id"                     UUID        PRIMARY KEY,
    "userId"                 UUID        NOT NULL REFERENCES auth."user"("id") ON DELETE CASCADE,
    "accountId"              TEXT        NOT NULL,
    "providerId"             TEXT        NOT NULL,
    "accessToken"            TEXT,
    "refreshToken"           TEXT,
    "idToken"                TEXT,
    "accessTokenExpiresAt"   TIMESTAMP,
    "refreshTokenExpiresAt"  TIMESTAMP,
    "scope"                  TEXT,
    "password"               TEXT,
    "createdAt"              TIMESTAMP   NOT NULL DEFAULT now(),
    "updatedAt"              TIMESTAMP   NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "account_providerId_accountId_idx" ON auth."account" ("providerId", "accountId");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS auth."verification" (
    "id"         UUID        PRIMARY KEY,
    "identifier" TEXT        NOT NULL,
    "value"      TEXT        NOT NULL,
    "expiresAt"  TIMESTAMP   NOT NULL,
    "createdAt"  TIMESTAMP   NOT NULL DEFAULT now(),
    "updatedAt"  TIMESTAMP   NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON auth."verification" ("identifier");
