# PLAN — God's Eye View on the ZimaCube NAS

Decision document for deploying this fork to `https://eye.dinoclyde.com`, self-hosted
on a ZimaCube Pro (ZimaOS) behind Nginx Proxy Manager.

Companion docs: **[KEYS.md](KEYS.md)** (what to sign up for, in order) and
**[STATUS.md](STATUS.md)** (what was built, what's unverified, what you still have to do).

---

## 0. The finding that shaped everything

**This app has no server.** Every one of its ~30 `/api/*` endpoints is Vite
middleware living inside `vite.config.js` — 7,802 lines of proxies for OpenSky,
CelesTrak, TomTom, FIRMS, Overpass, CCTV, AISStream, OpenAI Realtime, Google
Places, and the rest. Upstream is explicit that this is a dev/preview tool, not a
production service (`SECURITY.md:3`).

Vite gives plugins two hooks: `configureServer` (dev only) and
`configurePreviewServer` (production preview). **Ten of this repo's proxies only
register the dev hook.** Under a plain `vite build && vite preview` those routes
fall through to the SPA fallback and the browser gets `index.html` where it
expected JSON.

Measured, not assumed — `curl` against a real `vite preview` over a real production build:

| Endpoint | Bare `vite preview` | Verdict |
|---|---|---|
| `/api/opensky/states` | `200 text/html` | **broken** — live aircraft, the headline layer |
| `/api/cctv/sources` | `200 text/html` | **broken** — traffic cameras |
| `/api/celestrak/*` | `200 text/html` | **broken** — satellites |
| `/api/tomtom/*` | `200 text/html` | **broken** — live traffic |
| `/api/firms/*` | `200 text/html` | **broken** — active fires |
| `/api/terrain/heights` | `200 text/html` | **broken** — ground elevation |
| `/api/adsbdb/*` | `200 text/html` | **broken** — aircraft enrichment |
| `/api/overpass`, `/api/route` | `200 text/html` | **broken** — OSM geometry, routing |
| `/api/gbfs/*` | `200 text/html` | **broken** — bike share |
| `/api/adsblol/mil` | `200 text/html` | **broken** — military aircraft |
| `/api/ais-live`, `/api/realtime/token`, `/api/google/*`, `/api/radio/*`, `/api/weather-effects`, `/api/military-installations`, `/api/regional-brief`, `/api/launches` | real JSON | fine — these do register the preview hook |

So "build it and run `vite preview`" — the obvious move — ships a globe with the
satellites, aircraft and cameras quietly missing. That is the single biggest trap
in this deployment, and it fails *silently*: no error, no log line, just empty layers.

---

## 1. Architecture decision

### Chosen: production build + Vite preview server + an API bridge

New file: **`server/production-server.mjs`**. It starts Vite's real preview server
over the production `dist/`, then re-registers the ten dev-only proxies onto it by
walking the resolved plugin list and calling their `configureServer` hook against
the preview server.

This is safe because those plugins touch only `server.middlewares` and
`server.httpServer` — both of which a Vite `PreviewServer` provides. Verified by
audit: across all 7,802 lines the only `server.*` accesses are `server.middlewares`
(30×), `server.httpServer` (2×, in a plugin that already has a preview hook), and
`server.restart` (2×, dev-only key-setup paths that are never bridged).

The bridge is scoped by an explicit contract — plugin names matching
`/-(proxy|proxies)$/` — so Vite's own internals (`vite:esbuild`,
`vite-plugin-cesium`) are **not** dragged into production, where they would serve
unbundled sources out of `node_modules`. Anything dev-only that falls outside the
contract is logged rather than silently mounted or silently dropped, so a future
upstream endpoint shows up in the logs instead of vanishing.

**Verified working end to end** (`node server/production-server.mjs` against a real build):

```
[gev] bridged 10 dev-only proxy plugin(s): opensky-proxy, celestrak-proxy,
      tomtom-proxy, firms-proxy, terrain-heights-proxy, adsbdb-proxy,
      overpass-proxy, cctv-proxy, gbfs-proxy, adsblol-proxy
[gev] not bridged (dev-only, outside the proxy contract): vite:esbuild, vite-plugin-cesium
```

- `/api/celestrak/stations` → live ISS TLE (`1 25544U 98067A ...`)
- `/api/opensky/states` → live aircraft JSON, 1.3 s
- `/api/cctv/sources` → live Austin camera registry JSON
- `/api/setup/status` → **HTML** (endpoint correctly disabled — see §2)

### Alternatives rejected

| Option | Why not |
|---|---|
| **Run `vite` (dev server) in the container** | Works, and it's what most people would do — but ships unminified sources, runs the HMR websocket, and **re-enables `/api/setup/keys`**, which writes API keys to `.env` from an HTTP request. Unacceptable on an internet-reachable host. |
| **Patch `configurePreviewServer` into all 10 plugins in `vite.config.js`** | Correct in principle and the right upstream PR — but it's 10 edits inside a 7,802-line file that upstream actively changes, guaranteeing merge pain on every `git pull`. The bridge achieves the same result with zero diff to that file. |
| **Extract a standalone Express/Fastify server** | The honest "real" fix, and a large rewrite: ~30 handlers with bespoke caching, auth, budgets and SSRF guards. High risk of subtly breaking a proxy, for no benefit on a single-user NAS. |
| **Static `dist/` on nginx, no Node** | Loses every `/api/*` route. The app would be a globe with no data. |

**Tradeoff accepted:** `vite` is a `devDependency` but is imported at runtime, so
the container installs full dependencies rather than `--omit=dev`. That is
documented in the Dockerfile and is the reason `npm ci --omit=dev` must never be
used here.

### Runtime shape

```
Cloudflare (proxied, *.dinoclyde.com wildcard DNS — no new record needed)
   └─ NAS 10.77.1.153 :443 — Nginx Proxy Manager (host network)
        └─ proxy host: eye.dinoclyde.com → http://172.20.0.10:4173
             └─ container "gods-eye-view" on proxy_net (172.20.0.0/16)
                  node server/production-server.mjs  (HOST=0.0.0.0 PORT=4173)
```

Deliberate choices:

- **No published host ports.** NPM reaches the container directly on its bridge IP,
  so nothing is bound on the host — which also sidesteps the occupied-port list
  (53, 80, 81, 443, 3080, 8080, 9876, 32400) entirely.
- **Static IP `172.20.0.10`** on the existing external `proxy_net`, because NPM
  cannot resolve hostnames — backends must be literal IPs. `deploy.sh` checks for a
  conflict first and falls forward to the next free address if `.10` is taken.
- **`.gev-cache` is a persistent volume.** It holds `tomtom/budget.json`, the daily
  TomTom tile-spend counter. On an ephemeral filesystem that counter resets on every
  restart and the cost guard silently stops guarding.
- **Rebuild on container start**, so the two client-exposed keys are injected from
  `.env` at runtime instead of being baked into a shareable image layer.

---

## 2. Security posture

The deployment is public, so the threat is not key theft — it is **unauthenticated
quota drain**. Anyone who finds `eye.dinoclyde.com` can make the server spend the
owner's money via `/api/realtime/token` (OpenAI Realtime voice, the expensive one),
`/api/openai/hud-summary`, `/api/google/*`, and `/api/tomtom/*`.

Three layers, and all three are needed:

1. **An NPM access list** — HTTP Basic auth, not an IP allow-list. Behind the
   Cloudflare proxy the source IP NPM sees is a Cloudflare edge IP, so a
   `10.77.1.0/24` rule blocks *everything* arriving via the hostname. This is the
   trap; details and exact click-path in STATUS.md.
2. **App-side throttles** — `GEV_RATELIMIT_OPENAI_PER_MIN`,
   `GEV_RATELIMIT_GOOGLE_PER_MIN`, `TOMTOM_DAILY_TILE_BUDGET`. All default to
   **unlimited**, which is fine on localhost and dangerous on a public host.
   `.env.example` ships recommended values.
3. **Provider-side caps** — the only real spend protection. App throttles are not
   billing caps and a budget *alert* does not stop spending. Click-paths per
   provider are in KEYS.md.

One thing the architecture gets right for free: the `gev-key-setup` plugin, which
writes credentials to `.env` over HTTP, gates itself with
`apply: command === 'serve' && !isPreview`. Vite therefore drops it from the
resolved plugin list under preview, and the bridge never sees it. Confirmed by
probe — `/api/setup/status` and `/api/setup/keys` return HTML, not JSON. **In
production, `.env` is the only way to set a key.** `deploy.sh` asserts this on every
run and fails the deploy if that endpoint ever starts answering with JSON.

---

## 3. API keys — the decision

Full signup walkthroughs, free-tier limits and spend-cap click-paths are in
**[KEYS.md](KEYS.md)**. The decision:

### Get these (all $0, ~30 minutes total)

| Key | Env var | Unlocks | Without it |
|---|---|---|---|
| **Cesium ion** | `CESIUM_ION_TOKEN` | Google Photorealistic 3D, Bing imagery, world terrain | Falls back to keyless Esri imagery; the globe is flat-ish and plainer |
| **NASA FIRMS** | `FIRMS_MAP_KEY` | Live active fires | Layer is empty, shows `KEY REQUIRED` |
| **AISStream** | `AISSTREAM_API_KEY` | Live vessel positions | Layer 503s, `AISSTREAM_API_KEY not set` |
| **TomTom** | `TOMTOM_API_KEY` | Real live traffic flow | Falls back to a *simulation* — plausible-looking fake traffic |
| **OpenSky** | `OPENSKY_CLIENT_ID` / `_SECRET` | Higher aircraft rate limits | Anonymous works but is throttled |

Cesium ion's free tier is the **Community plan — personal/non-commercial only**.
This deployment qualifies; a commercial one would not.

> **Do this one thing even if you skip the rest:** set
> `OPENSKY_AUTH_MODE=anon` if you don't get OpenSky credentials. The shipped
> default is `oauth`, which with empty credentials falls back to anonymous while
> logging auth errors — it works, but noisily and confusingly.

### Get these second, only after setting a hard cap

| Key | Env var | Why the delay |
|---|---|---|
| **Google Maps** | `GOOGLE_MAPS_API_KEY` | Direct Google 3D Tiles + GEV place search. Genuinely generous (first ~1,000 3D-tile sessions/month free) but **requires a billing account**, so an uncapped key on a public host is an open tab. Set the budget *and* the per-API quota first. |
| **OpenAI** | `OPENAI_API_KEY` | Voice control — the one feature that costs real money, a few cents per active minute. The app meters it (live spend readout, $2 warning, $5 hard session cap), but that's per-session, not per-month: ten sessions is ten caps. Set a platform usage limit. |

### Skip

- **`LL2_API_TOKEN`** — Launch Library 2 works fine unauthenticated at one user's volume.

### Free with no signup at all

OpenSky (anonymous), USGS earthquakes, CelesTrak satellites, adsb.lol military
aircraft, city CCTV, Radio Browser, GBFS bike share, Launch Library 2, Overpass/OSM,
Open-Meteo, and every bundled dataset (cables, dams, datacenters, Natural Earth).

**Minimum viable:** five free keys, `$0.00/month`.
**Recommended:** those five plus a capped Google key. Add OpenAI only if you
actually want to talk to the globe.

### Two contradictions found in the repo's own docs

Flagged here because they'd otherwise bite during setup:

1. **The referrer-restriction advice is self-defeating.** `GOOGLE_MAPS_API_KEY` is
   used *both* client-side (browser geocoding) and server-side (Places
   `searchNearby`/`searchText`, Street View static). Server-side `fetch` sends no
   `Referer` header, so the HTTP-referrer restriction that `.env.example` recommends
   for this client-exposed key will cause the server proxies to be rejected.
   Resolution is in `.env.example` and KEYS.md.
2. **TomTom's free tier is documented twice, differently** — `.env.example` says
   ~50,000 tile requests/day, `DATA_SOURCES.md` says 200K/month. The shipped default
   `TOMTOM_DAILY_TILE_BUDGET=40000` would exhaust a 200K/month allowance in five
   days. Take the conservative reading and cap far lower.

---

## 4. Upstream fork review — `uhrichsam4/gods-eye-view`

_See STATUS.md for the reviewed findings and the merge recommendation._
