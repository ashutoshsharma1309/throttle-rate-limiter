# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /app

# Install deps against the lockfile first for layer caching.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Compile TS -> dist and copy Lua scripts alongside.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

# Production deps only.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY proto ./proto

EXPOSE 8080 50051
CMD ["node", "dist/index.js"]
