# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change does not re-run npm ci.
COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Production dependencies only. The build stage pulls in TypeScript, Vitest and
# the rest; carrying those into the runtime image roughly triples its size.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The generated Prisma client lives in node_modules and is platform-specific,
# so copy it from the build stage rather than regenerating.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY scripts ./scripts

# Gender-inference weights (~2.6 MB) are not in git. Fetching them at build
# time means the image is self-contained; without them the provider falls back
# to the mock, which does not look at the image at all.
RUN node scripts/fetch-models.mjs && chown -R node:node /app/models

# Run unprivileged. The base image ships a `node` user for exactly this.
USER node

EXPOSE 3001

# Render (and any orchestrator) uses this to decide whether the instance is
# serving. /health reports 503 when Redis is unreachable, so a node that cannot
# see the shared queue is pulled out rather than silently accepting traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply pending migrations before serving. `migrate deploy` is the deployment
# counterpart of `migrate dev`: it never prompts and never drops data, so it is
# safe to run on every boot — already-applied migrations are a no-op.
CMD ["npm", "run", "start"]
