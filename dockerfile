FROM node:22-bookworm AS build

WORKDIR /app

RUN npm install --global pnpm@9.15.4

COPY . .

RUN pnpm install --frozen-lockfile
RUN NODE_OPTIONS="--max-old-space-size=4096" pnpm build

# Export a self-contained package with production dependencies only.
# Keep the existing directory layout used by calculate.mjs and its workers.
RUN pnpm --filter @aginnovationaustralia/emissions-calculators --prod deploy \
      --ignore-scripts /runtime/packages/calculators \
    && cp calculate.mjs server.mjs /runtime/ \
    && cp -R web /runtime/web \
    && cp LICENSE /runtime/LICENSE \
    && find /runtime/packages/calculators/dist -type f \
      \( -name '*.cjs' -o -name '*.map' -o -name '*.d.ts' \) -delete \
    && chmod -R a+rX /runtime

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    DISABLE_CALCULATOR_METRICS=true

# Exclude sources, tests, examples, build tools, caches and development packages.
COPY --from=build /runtime/ /app/

EXPOSE 8080

USER node

ENTRYPOINT ["node", "/app/calculate.mjs"]
