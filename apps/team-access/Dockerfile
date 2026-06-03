# Multi-stage build for the Team-access embedded app.
# Build context is the repo root (Coolify base_directory = /).

# --------------------------------------------------------------- builder
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9

COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/team-access ./apps/team-access

RUN pnpm install --no-frozen-lockfile

WORKDIR /work/apps/team-access
RUN pnpm exec vite build

# --------------------------------------------------------------- runtime
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git

COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/team-access/package.json ./apps/team-access/package.json
COPY --from=builder /work/apps/team-access/node_modules ./apps/team-access/node_modules
COPY --from=builder /work/apps/team-access/dist ./apps/team-access/dist

COPY apps/team-access/server.js ./apps/team-access/server.js

EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/team-access
CMD ["node", "server.js"]
