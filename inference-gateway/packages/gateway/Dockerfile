FROM node:22-alpine AS base
WORKDIR /app
RUN npm i -g pnpm

# Install dependencies
FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY packages/gateway/package.json ./packages/gateway/
COPY packages/admin/package.json ./packages/admin/
RUN pnpm install

# Build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
WORKDIR /app/packages/gateway
RUN pnpm build

# Runner
FROM base AS runner
WORKDIR /app
ENV NODE_ENV production
ENV PORT 3001

COPY --from=builder /app/packages/gateway/package.json ./packages/gateway/
COPY --from=builder /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3001
WORKDIR /app/packages/gateway
CMD ["sh", "-c", "npm run db:migrate && node dist/index.js"]
