FROM docker.io/oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

FROM deps AS build
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY prisma ./prisma
COPY public ./public
COPY scripts ./scripts
COPY types ./types
COPY components.json ./components.json
COPY next.config.ts ./next.config.ts
COPY postcss.config.mjs ./postcss.config.mjs
COPY prisma.config.ts ./prisma.config.ts
COPY tsconfig.json ./tsconfig.json
ENV NODE_ENV=production
RUN bun run db:generate
RUN bun run build

FROM docker.io/oven/bun:1 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl netcat-openbsd \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bun.lock ./bun.lock
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/lib ./lib
COPY --from=build /app/app ./app
COPY --from=build /app/components ./components
COPY --from=build /app/types ./types
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/postcss.config.mjs ./postcss.config.mjs
COPY --from=build /app/components.json ./components.json
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/next-env.d.ts ./next-env.d.ts

RUN chmod +x /app/scripts/docker-entrypoint.sh

EXPOSE 3000

CMD ["bun", "run", "start:docker"]
