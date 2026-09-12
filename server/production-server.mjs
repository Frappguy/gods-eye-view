/**
 * God's Eye View — production server.
 *
 * Why this file exists
 * ====================
 * Every `/api/*` endpoint this app depends on is implemented as Vite
 * middleware inside `vite.config.js`. Vite exposes two hooks for that:
 * `configureServer` (dev only) and `configurePreviewServer` (production
 * preview). Most of the proxies in this repo only register the dev hook, so a
 * plain `vite build && vite preview` silently drops them — the request falls
 * through to the SPA fallback and the layer receives `index.html` instead of
 * JSON. Verified broken under bare preview: celestrak, tomtom, firms,
 * terrain/heights, adsbdb, overpass, route, opensky, gbfs, cctv, adsblol.
 * That includes live aircraft and CCTV, i.e. the headline layers.
 *
 * Rather than patch 7800 lines of upstream config (and fight every future
 * merge), this server starts Vite's real preview server over the production
 * build and bridges the dev-only proxies onto it.
 *
 * What it deliberately does NOT do
 * ================================
 * It does not resurrect the `gev-key-setup` plugin. That plugin writes
 * credentials to `.env` and gates itself with
 * `apply: command === 'serve' && !isPreview`, so Vite drops it from the
 * resolved plugin list under preview and the bridge never sees it. The in-app
 * "POWER UP" key editor is therefore inert in production — keys come from
 * `.env` only. That is the correct posture for an internet-reachable
 * deployment.
 *
 * Run with: node server/production-server.mjs   (after `npm run build`)
 */

import { preview } from 'vite';

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 4173;
const HOST = process.env.HOST || '0.0.0.0';

/** Hooks may be a bare function or the object form `{ order, handler }`. */
const hookHandler = (hook) => {
  if (typeof hook === 'function') return hook;
  if (hook && typeof hook.handler === 'function') return hook.handler;
  return null;
};

/**
 * Only this repo's own upstream proxies get bridged. Vite's internals and
 * third-party plugins (`vite:esbuild`, `vite-plugin-cesium`) also carry
 * `configureServer` hooks, but those serve unbundled sources out of
 * `node_modules` and must not shadow the production build. Every proxy in
 * `vite.config.js` is named `<something>-proxy` or `<something>-proxies`, so
 * that suffix is the contract; anything else that is dev-only gets reported
 * rather than silently mounted or silently dropped.
 */
const BRIDGEABLE = /-(proxy|proxies)$/;

/**
 * Re-registers proxies that only implement `configureServer` onto the preview
 * server. Safe because every such plugin in this repo touches only
 * `server.middlewares` and `server.httpServer`, both of which a Vite
 * PreviewServer provides. Plugins that already implement
 * `configurePreviewServer` are skipped so their middleware is not mounted
 * twice.
 */
/**
 * Response headers and endpoint denials, registered ahead of every proxy.
 *
 * This MUST be `enforce: 'pre'`. Connect runs middleware in registration
 * order, and a proxy that answers a request never calls `next()`. A hook that
 * ran last would therefore cover only the routes registered inside it — the
 * bridged proxies and the static handler — and would silently miss every
 * proxy that registers its own preview hook (radio, ais-live, openai-realtime,
 * google-places, weather, regional-brief, military-installations). Observed
 * exactly that way before this was split out: /api/cctv/sources carried the
 * framing headers and /api/radio/stations did not.
 */
const apiGuard = () => ({
  name: 'gev-production-api-guard',
  enforce: 'pre',
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const pathname = (req.url || '/').split('?')[0];

      // `/api/realtime/debug-log` appends caller-supplied JSON to
      // .gev-logs/realtime-conversations.jsonl — up to 8 MB per request, with
      // no authentication, no rate limit, and no rotation or size ceiling. On
      // a localhost dev box that is a debugging convenience. On an
      // internet-reachable host it is an unauthenticated disk-fill against the
      // log volume, so it is refused here rather than merely discouraged.
      // 404 rather than 403: a route that does not exist invites no retry.
      // Set GEV_ENABLE_REALTIME_DEBUG_LOG=1 to opt back in when debugging.
      if (
        pathname === '/api/realtime/debug-log'
        && process.env.GEV_ENABLE_REALTIME_DEBUG_LOG !== '1'
      ) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      // Framing protection for the app document. `vite.config.js` sets these
      // under `server.headers`, which applies to the dev server only — so a
      // production deploy built from this repo serves the app unprotected
      // unless we set them here.
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

      // Caching. This matters more than usual because the deployment sits
      // behind a proxying CDN: without an explicit `no-store`, live feeds
      // (aircraft positions, vessel positions, camera frames) are exactly
      // the shape of thing an edge cache will happily serve stale. A handler
      // that sets its own Cache-Control still wins — `setHeader` later in
      // the request overwrites this default.
      if (pathname.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
      } else if (pathname.startsWith('/assets/') || pathname.startsWith('/cesium/')) {
        // Content-hashed by the build, so it is safe to cache forever.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        // index.html and friends carry no hash — revalidate so a redeploy is
        // picked up instead of being pinned by an edge cache.
        res.setHeader('Cache-Control', 'no-cache');
      }
      next();
    });
  },
});

const apiBridge = () => {
  let resolvedConfig = null;
  return {
    name: 'gev-production-api-bridge',
    // `enforce: 'post'` keeps the bridge last in the plugin array, so by the
    // time its preview hook runs every proxy plugin is already resolved.
    enforce: 'post',
    configResolved(config) {
      resolvedConfig = config;
    },
    configurePreviewServer(server) {
      const bridged = [];
      const skipped = [];
      const deferred = [];
      for (const plugin of resolvedConfig?.plugins ?? []) {
        if (!plugin || plugin.name === 'gev-production-api-bridge') continue;
        if (hookHandler(plugin.configurePreviewServer)) continue;
        const install = hookHandler(plugin.configureServer);
        if (!install) continue;
        if (!BRIDGEABLE.test(plugin.name)) {
          skipped.push(plugin.name);
          continue;
        }
        // A `configureServer` hook may return a function to run after the
        // server's internal middlewares. Preserve that ordering contract.
        const post = install.call(plugin, server);
        if (typeof post === 'function') deferred.push(post);
        bridged.push(plugin.name);
      }
      for (const post of deferred) post();

      console.log(
        `[gev] bridged ${bridged.length} dev-only proxy plugin(s): ${bridged.join(', ') || '(none)'}`,
      );
      if (skipped.length) {
        // Not fatal — Vite's own plugins land here every run. It matters only
        // if a NEW GEV endpoint appears under a name the contract misses.
        console.log(`[gev] not bridged (dev-only, outside the proxy contract): ${skipped.join(', ')}`);
      }
    },
  };
};

const server = await preview({
  configFile: 'vite.config.js',
  plugins: [apiGuard(), apiBridge()],
  preview: {
    host: HOST,
    port: PORT,
    strictPort: true,
    // This server always sits behind a reverse proxy that terminates TLS and
    // forwards an arbitrary Host header, so Vite host checking must be off
    // here. Access control is the reverse proxy's job (see DEPLOY section of
    // STATUS.md / the NPM access list), not Vite's.
    allowedHosts: true,
  },
});

server.printUrls();

const shutdown = (signal) => {
  console.log(`[gev] ${signal} received, shutting down`);
  Promise.resolve(server.close?.()).finally(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
