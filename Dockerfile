# ===========================================================================
# God's Eye View — production image for a self-hosted NAS (ZimaOS/CasaOS)
# behind Nginx Proxy Manager.
#
# THREE DESIGN DECISIONS THAT LOOK WRONG AND ARE NOT
# ==================================================
#
# 1. SINGLE STAGE, AND devDependencies ARE INSTALLED.
#    `vite` is a devDependency, but it is a RUNTIME dependency of this
#    deployment: server/production-server.mjs does `import { preview } from
#    'vite'` and serves every /api/* route out of Vite middleware. So
#    `npm ci --omit=dev` (or ENV NODE_ENV=production, which makes npm omit
#    dev deps implicitly) produces an image that cannot boot. NODE_ENV is
#    therefore deliberately NOT pinned to production anywhere below.
#
# 2. THE SOURCE TREE SHIPS, NOT JUST dist/.
#    vite.config.js is loaded by Vite at runtime and statically imports
#    ./src/data/*.js, ./src/hudSummaryResponse.js, ./src/keySetup*.mjs,
#    ./src/voice/voiceCost.js and ./scripts/pinokio-environment.mjs; the CCTV
#    proxy reads ./config/cctv_sources.*.json per request. A multi-stage build
#    that copied only dist/ + node_modules would 500 on the CCTV layer and
#    fail to import at boot. Since "prune the build stage" would end up
#    copying src/, scripts/, config/, server/, vite.config.js, package.json
#    AND the full (dev-inclusive) node_modules — i.e. everything — a second
#    stage buys nothing but a way to get it subtly wrong. Correctness over
#    image size: one stage.
#
# 3. THE CLIENT BUNDLE IS BUILT AT CONTAINER START, NOT AT IMAGE BUILD.
#    vite.config.js injects two keys into the BROWSER bundle via `define`:
#      import.meta.env.GOOGLE_MAPS_API_KEY
#      import.meta.env.CESIUM_ION_TOKEN
#    They must be present when `vite build` runs, and they end up inside
#    dist/assets/*.js. That is by design (they are client-exposed keys, meant
#    to be locked down by HTTP-referrer / API restrictions), but it means a
#    build-time ARG would bake them into a shareable, `docker save`-able,
#    pushable image LAYER — a much broader blast radius than "visible to
#    someone who opens devtools on my own site".
#
#    So: the image is generic and secret-free, and `npm run build` runs in the
#    container entrypoint, reading the keys from the process environment that
#    docker-compose injects via `env_file: .env`. This works because
#    vite.config.js calls `loadEnv(mode, __dirname, '')` — an EMPTY prefix, so
#    every process.env key is merged in, and process.env wins over .env-file
#    values. No .env file needs to exist inside the image at all.
#
#    Cost: the build re-runs on every container start. Measured at ~7s warm on
#    a dev box; budget 30-90s on NAS-class silicon (Cesium + egm96 are the
#    heavy chunks). The healthcheck start_period in docker-compose.yml covers
#    it. Rotating a key is then just `docker compose restart` — there is no
#    stale-bundle failure mode to reason about, which is the other half of why
#    this beats an ARG.
# ===========================================================================

# node:24-bookworm-slim. package.json engines is ">=24.14.0 <25 || >=26 <27";
# the 24 tag tracks the latest 24.x LTS, which is well past 24.14.0. The
# entrypoint asserts this at boot (see CMD) so a future base-image surprise
# fails loudly instead of producing subtly wrong behaviour.
FROM node:24-bookworm-slim

# Chromium is only needed by the puppeteer-driven QA scripts in scripts/,
# which never run in this container. Skipping the download saves ~200MB and
# removes a build-time dependency on a CDN that a NAS behind a proxy may not
# reach. puppeteer itself stays installed — nothing imports it at runtime, but
# omitting dev deps entirely is not an option (see note 1 above).
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# Create the runtime state directories INSIDE the image and hand them to the
# unprivileged `node` user before any volume is attached. Docker seeds a named
# volume from the image's directory at that path — including its ownership —
# so doing this here is what makes .gev-cache/.gev-logs writable at runtime
# without a chown-on-boot hack or running as root.
RUN mkdir -p /app/.gev-cache/tomtom /app/.gev-logs \
    && chown -R node:node /app

# Drop root before anything touches the network or the filesystem. Every COPY
# below uses --chown so the layer is written correctly the first time; a
# trailing `chown -R /app` would duplicate the whole ~250MB tree into an extra
# layer.
USER node

# Dependency layer first so that editing app source does not re-run npm ci.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Full source tree. .dockerignore removes node_modules, dist, .git, .env,
# docs/media and the QA artifact directories; what remains is exactly what
# vite.config.js reaches for at build time and at request time.
COPY --chown=node:node . .

# The production server binds these. docker-compose.yml sets them again in
# `environment:` so they override anything in .env — a .env carrying the
# development default HOST=localhost would otherwise bind the server to the
# container's loopback only, and Nginx Proxy Manager would get connection
# refused from an otherwise "healthy"-looking container.
ENV HOST=0.0.0.0 \
    PORT=4173

# Documentation only — docker-compose.yml deliberately publishes NO host port.
EXPOSE 4173

# No curl/wget in node:*-slim, and adding an apt layer just for a healthcheck
# is not worth it: node 24 has a global fetch(), so the probe uses the binary
# that is guaranteed to exist. Kept identical to the compose healthcheck.
HEALTHCHECK --interval=30s --timeout=10s --start-period=150s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4173/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Build, then hand PID 1 to node via `exec` so SIGTERM from `docker stop`
# reaches production-server.mjs's own shutdown handler instead of being
# swallowed by the shell.
CMD ["sh", "-c", "\
node -e \"const [maj,min]=process.versions.node.split('.').map(Number); if(!((maj===24&&min>=14)||maj===26)){console.error('[gev] FATAL: node '+process.versions.node+' does not satisfy package.json engines >=24.14.0 <25 || >=26 <27');process.exit(1);}\" && \
echo '[gev] building client bundle from runtime environment...' && \
npm run build && \
echo '[gev] build complete, starting production server' && \
exec node server/production-server.mjs"]
