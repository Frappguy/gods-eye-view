# STATUS — what was built, what's verified, what's left for you

Companion docs: **[PLAN.md](PLAN.md)** (why the architecture is what it is) and
**[KEYS.md](KEYS.md)** (signup walkthroughs and spend caps).

---

## YOUR MANUAL STEPS

Everything else is done. This is the whole list.

### 1. Get keys (~30 min, $0) — optional but this is the fun part

Open **[KEYS.md](KEYS.md)** on your phone and work down the checklist. Five free
keys: Cesium ion, NASA FIRMS, AISStream, TomTom, OpenSky. Skip Google and OpenAI
on the first pass — add them later, *after* setting a cap. The app runs with zero
keys, so you can also skip this entirely and come back to it.

### 2. Deploy on the NAS

```bash
ssh into the ZimaCube, then:
sudo mkdir -p /DATA/AppData
cd /DATA/AppData
sudo git clone --branch claude/gods-eye-view-nas-deploy-69coji \
    https://github.com/Frappguy/gods-eye-view gods-eye-view
cd gods-eye-view
sudo cp .env.example .env
sudo nano .env          # paste whatever keys you got in step 1
sudo ./deploy.sh
```

`deploy.sh` does the rest: syncs the repo, creates `proxy_net` if missing, picks a
free static IP, builds, starts, verifies the API layer is genuinely live, and
prints the NPM settings with your actual IP filled in. Re-run it after every
`git push` — it's idempotent.

**It will refuse to start without `.env`.** That's deliberate: a keyless container
boots fine and then fails every API call at 11pm with no obvious cause.

### 3. Nginx Proxy Manager — create the access list FIRST

**Hosts → Access Lists → Add Access List**

- Name: `gev-public`
- **Satisfy Any: UNCHECKED**
- **Pass Auth to Host: UNCHECKED**
- Authorization tab: your username + a long random password. Click **Add** so the
  row commits before you save.
- Access tab: **leave completely empty.**

> **Use Basic auth, not the LAN range.** Your site is Cloudflare-proxied, so every
> request reaches NPM from a Cloudflare edge IP — never from `10.77.1.x`. A
> `10.77.1.0/24` allow rule would 403 *everything* through `eye.dinoclyde.com`,
> including your own phone on your own Wi-Fi. This is the trap in the whole
> deployment.
>
> `Satisfy Any` exists and does map to nginx's `satisfy any`, but it doesn't help:
> the IP arm is evaluated against the Cloudflare edge IP, so it never matches. And
> if you ever turn on real-IP restoration, `satisfy any` turns a spoofable header
> into a password bypass. Leave it off.
>
> Want no password on the LAN? Make a **second** proxy host on a LAN-only
> hostname resolved by local DNS, pointing at the same IP with no access list.
> Two hosts, two postures.

### 4. Nginx Proxy Manager — add the proxy host

**Hosts → Proxy Hosts → Add Proxy Host.** New host — don't edit an existing one.

**Details tab**

| Field | Value |
|---|---|
| Domain Names | `eye.dinoclyde.com` |
| Scheme | `http` |
| Forward Hostname / IP | **the IP `deploy.sh` printed** (normally `172.20.0.10`) |
| Forward Port | `4173` |
| Cache Assets | **off** |
| Block Common Exploits | on |
| Websockets Support | on |
| Access List | `gev-public` |

Forward Hostname must be that **IP**. Not `gods-eye-view`, not `localhost` — NPM
resolves neither, and you get a 502.

**SSL tab**

| Field | Value |
|---|---|
| SSL Certificate | your existing `*.dinoclyde.com` wildcard — select it |
| Force SSL | on |
| HTTP/2 Support | on |
| HSTS | optional |

Leave the certificate on "None" and Cloudflare answers **525** with no other clue.
Don't request a new per-host cert — Cloudflare proxying breaks HTTP-01 validation.

**Advanced tab** (optional, but the timeout is worth it)

```nginx
# First request after a restart triggers a full client build.
proxy_connect_timeout 15s;
proxy_send_timeout    300s;
proxy_read_timeout    300s;
proxy_buffering off;
client_max_body_size 2m;
```

Do **not** add `real_ip_header CF-Connecting-IP`. It can't reach the app's limiter
anyway, and combined with an IP rule it becomes a spoofable bypass.

### 5. Check Cloudflare SSL mode

SSL/TLS must be **Full (strict)**. On "Flexible", the edge talks plain HTTP to NPM
and `Force SSL` gives you a redirect loop.

No DNS record needed — the proxied wildcard already covers `eye.dinoclyde.com`.

### 6. Set provider spend caps

The single most important step if you did step 1. App throttles are **not** billing
caps. Click-paths per provider are in KEYS.md. At minimum: OpenAI Platform →
Settings → Limits, and Google Cloud → Billing → Budgets & alerts *plus* per-API
quotas.

**Optional but recommended:** a Cloudflare WAF rate-limit rule on `/api/*`. It's
your only real *per-visitor* throttle — see the finding in §"Rate limiting" below.

---

## What each agent did

### Architecture (conductor)

Found that ten `/api/*` proxies are dev-only and vanish under a normal production
build — see PLAN.md §0 for the measured table. Wrote `server/production-server.mjs`,
which serves the production build through Vite's preview server and re-mounts those
ten proxies onto it, leaving `vite.config.js` at a zero diff so upstream merges stay
clean. Added `npm start`.

### Agent KEYS → `KEYS.md`

Phone-friendly checklist, priority-ordered, every key with signup steps, free-tier
limits, personal-use gotchas, the paired app-side throttle, and an explicit
spend-cap click-path. Grounded each "what happens without it" in the actual fallback
code rather than guesswork.

### Agent DOCKER → `Dockerfile`, `docker-compose.yml`, `.dockerignore`

Single-stage image on `node:24-bookworm-slim`, running as the unprivileged `node`
user. Documents three decisions that look wrong and aren't: devDependencies are
installed (`vite` is a *runtime* dependency here), the source tree ships (not just
`dist/`), and the client bundle builds at container start so the two client-exposed
keys never get baked into a pushable image layer.

### Agent SECURITY → `.env.example` + audit

Confirmed no secret key reaches the browser, and that `/api/realtime/token` returns
only a short-lived ephemeral `ek_…` token — the raw key never leaves the server, and
voice audio goes browser↔OpenAI directly by WebRTC without transiting the NAS.
`.env.example` grew from 142 to 370 lines and now documents every variable the code
actually reads.

### Agent DEPLOY → `deploy.sh`

Idempotent, 8 steps, `--help`. Health check asserts the API layer returns **JSON not
HTML**, because a 200 that lies is the exact failure this deployment exists to
prevent. Also asserts `/api/setup/status` stays inert and fails the deploy if that
credential-writing endpoint ever answers JSON.

---

## Verified, and how

| Claim | Evidence |
|---|---|
| Ten proxies break under a stock production build | `curl` against a real `vite preview` over a real build — all ten returned `200 text/html` |
| The bridge restores them | Live ISS TLE, live aircraft JSON (1.3 s), live Austin camera registry on the host |
| Container runs and is healthy | Built and ran it; `docker inspect` → `healthy`; in-container build 6.9 s, serving in ~10 s |
| Container runs unprivileged | `docker exec … id` → `uid=1000(node)` |
| API middleware live in the container | `/api/cctv/sources` → JSON; `/api/opensky/states` → `{"error":"OpenSky proxy error"}`, an honest JSON error rather than the SPA shell |
| Key editor dead in production | `/api/setup/status` and `/api/setup/keys` → HTML, on host and in container |
| Security headers on every route class | `X-Frame-Options` present on static, bridged and natively-registered routes (5/5) |
| Cache policy correct | `/api/*` → `no-store`, `/assets/*` → `immutable`, `/` → `no-cache` |
| `debug-log` disk-fill closed | Unauthenticated POST → 404, zero files written |
| Repo still healthy | `npm test` → 0 failures; `npm run build` clean; `bash -n` + `shellcheck` clean on `deploy.sh` |
| IP picker correct | 13/13 unit tests, plus a real two-container run on a throwaway bridge |

---

## Unverified — read this before trusting it

1. **Nothing has run on the actual NAS.** No ZimaOS, no `/DATA`, no NPM, no
   Cloudflare from here. `deploy.sh`'s clone path, `.env` gate rendering, and
   `compose up` on ZimaOS are syntax- and shellcheck-clean but unexecuted.
2. **`proxy_net` was not touched.** The 172.20.0.0/16 subnet, the `.2` occupancy,
   and NPM's presence on that bridge are taken from your description. The IP picker
   was tested on a synthetic network, not yours.
3. **Live upstream calls from inside the container failed here** (502/503) because
   this sandbox's container has no outbound proxy. The same endpoints returned real
   data on the host. On the NAS with normal internet they should work — but that
   specific combination is untested.
4. **Container build time on NAS silicon is a guess.** 6.9 s on this box; the
   healthcheck budgets 150 s and `deploy.sh` allows 600 s. If your first deploy
   times out, it's probably just slow: `GEV_HEALTH_TIMEOUT=1200 sudo ./deploy.sh`.
5. **Free-tier limits and pricing in KEYS.md drift.** Anything marked "verify"
   was not checked against a live provider page.
6. **NPM field names** are from the standard UI. If your version's Advanced tab
   rejects a directive, `proxy_buffering off;` is the one most likely to conflict.
7. **Legacy `docker-compose` v1** is detected and supported but only v2 was tested.
8. **Node version mismatch in this environment.** Everything here ran on Node
   22.22.2; `package.json` requires >=24.14. The container uses Node 24 and asserts
   it at boot. Two allocation microbenchmarks skipped for this reason.

---

## Findings worth knowing

### Rate limiting collapses to one global bucket

The app's limiter keys on `req.socket.remoteAddress` and deliberately ignores
`X-Forwarded-For`. Behind Cloudflare → NPM → container, every request arrives from
the NPM container's IP, so "per-IP" becomes **one shared bucket for all visitors,
including you**.

That's *safer* against abuse — nobody mints fresh quota by rotating IPs — but it
means your own browsing competes with an abuser for the same budget. Per-visitor
limiting isn't achievable without a code change, which is why the Cloudflare WAF
rule in step 6 is worth doing.

Three of the five cost endpoints default to **unlimited**. `.env.example` now ships
recommended values (OpenAI 30/min, Google 60/min, TomTom 5000 tiles/day).

### The Google key restriction advice is self-defeating

`GOOGLE_MAPS_API_KEY` is used both client-side (browser geocoding) *and* server-side
(Places `searchNearby`/`searchText`, Street View). Server-side `fetch` sends no
`Referer`, so the HTTP-referrer restriction normally recommended for a
client-exposed key **will reject the server proxies** — a confusing 403 from
`/api/google/*`. Referrer restriction protects the client uses only; the **API
restriction** is what bounds the server ones.

So the recommendation in both `.env.example` and KEYS.md is: **Application
restrictions → None**, API restriction on, tight per-API quotas. The usual
counter-argument ("the key is in the bundle, anyone can scrape it") is weak here
because the site sits behind the NPM access list, so the bundle isn't publicly
fetchable. If you'd rather have the referrer lock, you lose place search and the
Street View fallback — that tradeoff is spelled out in both files.

### SSRF: clean

Only one endpoint fetches a client-supplied URL (`/api/gbfs/…`), and it's gated four
ways: HTTPS-only, an 8-entry host allowlist, a two-filename path allowlist, and a
timeout. No internal hostname or IP literal passes. `/api/cctv/media/<id>` looks like
an open proxy but isn't — the id is resolved against a server-built registry.

### Two doc contradictions in the repo

TomTom's free tier is documented as both ~50K/day (`.env.example`) and 200K/month
(`DATA_SOURCES.md`); the shipped default of 40000/day would exhaust the smaller
allowance in five days. And `CCTV_AUSTIN_MAX_SOURCES` / `CCTV_MAX_SOURCES` had wrong
defaults documented (36/48 vs the actual 250/900). Corrected in `.env.example`.
`CCTV_AUTO_CALIBRATE` and `CCTV_DRAPE_MESH` are read nowhere in the codebase — kept
but marked as dead rather than silently dropped.

---

## Fork review — `uhrichsam4/gods-eye-view`

**Recommendation: PARTIAL MERGE.** Take ~2,100 lines of 83,055; skip the rest.

The strongest signal: **they hit the identical bug and diagnosed it in the same
words.** Their commit reads *"Ten proxy plugins registered middleware only in
configureServer, so a built deployment served barely half the API."* Same ten
plugins. Independent confirmation that this deployment's central problem is real.

Their fix wraps the plugin array inside `vite.config.js`; ours does it from outside.
Same outcome, but ours keeps that file at a zero diff, so **we don't need their
hosting code** — we already have the capability. Worth knowing their approach exists
if you ever want to upstream a PR, which would be welcome: upstream already has a
test asserting this property for four newer plugins and simply never retrofitted the
ten legacy ones.

**Already adopted:** their production cache headers, adapted. Theirs set no security
headers at all, so the framing protection was carried across too.

**Worth taking later (not done — outside a deployment task's scope):**

1. **A live bug in your tree today.** The CCTV source cap is a flat `slice()`, so
   hand-curated cameras are the *first* thing dropped when the cap is hit. Their
   version reserves budget for curated entries. ~6 lines. This affects you now if
   you use a curated source pack.
2. **A dead-camera guard.** The Castle Rock 511 platform answers a decommissioned
   camera with HTTP 200 and a "No live camera feed" PNG, which currently shows as
   `SNAPSHOT · OK`. ~14 lines.
3. **35 world CCTV catalogs** (~5,100 cameras: Europe, Canada, Asia-Pacific) plus a
   generic adapter. Well-engineered and documented.

**If you take the camera packs, take them disabled-by-default.** Their own
`DEPLOY.md` claims "everything left enabled is openly licensed" and that is **not
accurate against their own registry** — at least eight enabled catalogs record an
unverified or unstated licence, and their Florida pack defaults to *enabled* with
terms reading "individual use only … not available for re-sale or re-use". Their
per-entry `license` fields are scrupulously honest; it's the summary prose that
overstates. On a private LAN this is low-stakes; on a public URL it isn't. Start
with the unambiguous ones (Finland CC BY, Stockholm/Göteborg CC0, Norway NLOD).

Also: raising the packs without raising `CCTV_MAX_SOURCES` and the `Math.min(1200,…)`
ceiling gets you *no more cameras* — just a different, mostly-foreign 900.

**Skip:** the flight simulator, `data/shootings.json` (59K lines), NASA temperature
layers, the OpenRouter voice agent, their performance work (it targets a render path
ours has diverged from), and **their `package-lock.json`** — it pins `puppeteer ^24`
and `sharp ^0.34` and would undo a security update already in your tree.
