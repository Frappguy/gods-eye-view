# KEYS.md — God's Eye View key checklist

Phone-friendly. Tick boxes as you go. Deployment: **https://eye.dinoclyde.com** (single personal user, public-facing).

Every key here is **optional**. The app boots and runs with zero keys. Keys are upgrades.

Where they go: the repo-root `.env` (see `.env.example`), or paste them into **POWER UP → Provider Settings** in the app — but note Provider Settings is **disabled when the server is not bound to localhost**, so for the NAS deploy you edit `.env` directly.

> ⚠️ Every "free tier" number below is an external fact that drifts. **Verify on the provider's own pricing page before you rely on it.**

---

## TL;DR — do these 6, in this order

- [ ] **1. Cesium ion token** — free. Biggest single visual upgrade (photorealistic 3D + world terrain). 5 min.
- [ ] **2. NASA FIRMS map key** — free, instant, no billing possible. Fires layer is *empty* without it.
- [ ] **3. AISStream key** — free, instant, no billing possible. Live global ships.
- [ ] **4. TomTom key** — free tier. Turns the simulated traffic into real congestion colors.
- [ ] **5. OpenSky OAuth client** — free. More flight-polling credits. *(Or, if you skip it, set `OPENSKY_AUTH_MODE=anon` — see below, this matters.)*
- [ ] **6. App-side throttles** — `GEV_RATELIMIT_*` and `TOMTOM_DAILY_TILE_BUDGET`. Free. Non-negotiable for a public URL.

**Then, only if you want them and only after setting caps:** Google Maps (metered, billing account required) and OpenAI (metered, real money).

**Skip:** Launch Library 2 token. Anonymous works, the server caches 15 min and serves last-good.

---

## - [ ] 1. Cesium ion — photorealistic 3D + terrain

**Env var:** `CESIUM_ION_TOKEN`

**Unlocks:** Google Photorealistic 3D Tiles served through ion, Bing world imagery map stacks, and Cesium World Terrain.

**Without it:** `selectMapStartupRoute()` in `src/mapStartup.js` returns `'osm'` when neither a Google key nor an ion token is present — you land on keyless **Esri World Imagery** with OSM in the map tray as the automatic provider-failure fallback, and flat `EllipsoidTerrainProvider` swapped for keyless **Re:Earth / Mapterhorn** quantized-mesh terrain. The ion and Bing chips in the map-stack row stay keyboard-focusable but **unavailable, with an accessible explanation** (`src/ui.js` `_initMapStackControl`). Everything else — flights, ships, satellites, CCTV, fires — works fine.

**⚠️ CLIENT-EXPOSED.** Injected into the browser bundle via Vite `define` (`vite.config.js:7794`). It **will** be visible in devtools. Do not try to hide it — scope it.

**Signup — https://ion.cesium.com/signup**

1. Sign up (free **Community** plan).
2. Top nav → **Access Tokens** → **Create token**.
3. Name it `gev-eye-dinoclyde`.
4. Scopes: tick **`assets:read` only**. Untick everything else (especially `assets:write`, `assets:list`).
5. **Allowed URLs** → add `https://eye.dinoclyde.com` (this is the ion-side URL restriction — do it, the token is public).
6. Create → copy → `CESIUM_ION_TOKEN=...` in `.env`.

**Free tier (verify — provider terms drift):** Community plan includes a monthly quota of tile/asset requests and streamed data. Check https://cesium.com/platform/cesium-ion/pricing/.

**Terms gotcha:** The Community plan is for **eligible individual, personal, non-commercial use only**. A personal NAS deploy of your own globe is the intended case; anything that looks like a business or a product is not. Re-read the eligibility text at signup.

**Spending cap:** There is no card on the Community plan, so you **cannot be billed** — you hit the quota and access throttles/stops. *(Verify — if Cesium changes to a pay-as-you-go default, this stops being true.)* The one control you do have is the **Allowed URLs** restriction in step 5: it stops a copied token from burning your quota from someone else's site.

**Paired throttle:** none (no server proxy — the browser talks to ion directly).

---

## - [ ] 2. NASA FIRMS — live active fires

**Env var:** `FIRMS_MAP_KEY`

**Unlocks:** The FIRMS Active Fires layer — merged VIIRS NOAA-20 / NOAA-21 / Suomi-NPP near-real-time detections, trailing 24 h.

**Without it:** `/api/firms` returns **503 `{error:'no_key'}`** and upstream is *never touched* (`vite.config.js`, `firmsProxy()`). The client renders the layer with the terminal label **`KEY REQUIRED`** (`src/data/firmsHeatmap.js:309`) — an empty layer with a labelled reason, not a crash. The first-run "Environmental" mission still works because quakes (USGS, keyless) carry it.

**Server-side only** — never reaches the browser.

**Signup — https://firms.modaps.eosdis.nasa.gov/api/map_key/**

1. Open the URL.
2. Enter your email address.
3. Submit. The MAP_KEY is issued immediately (shown / emailed).
4. `FIRMS_MAP_KEY=...`

**Free tier (verify — provider terms drift):** Free, no account beyond the email. Shared transaction quota per key, roughly a few thousand transactions per rolling 10-minute window. GEV caches responses for **30 minutes** specifically to respect this, so a single user will never approach it.

**Terms gotcha:** Data is CC0 / US public domain. The acknowledgement line ("We acknowledge the use of data and/or imagery from NASA's FIRMS…") is already registered in the app's Data attribution popover — leave it there.

**Spending cap:** **Not applicable — no billing exists.** Nothing to cap. Zero financial risk.

**Paired throttle:** none.

---

## - [ ] 3. AISStream — live global ships

**Env var:** `AISSTREAM_API_KEY`

**Unlocks:** The Live AIS Vessels layer — a server-side websocket to AISStream, worldwide.

**Without it:** `/api/ais-live` returns **503** with `status:'missing-key'` and `error:'AISSTREAM_API_KEY is not set'` (`vite.config.js` `aisStreamStatusSnapshot()`); the client shows the label **`AISSTREAM_API_KEY not set`** (`src/data/aisLiveVessels.js:112`). Layer is empty, labelled, no crash.

**Server-side only** — the private stream key stays on the server; the browser fetches same-origin `/api/ais-live`.

**Signup — https://aisstream.io**

1. Go to https://aisstream.io and click **Authenticate / Sign up** (email or GitHub).
2. In the dashboard → **API Keys** → **Create new key**.
3. Name it `gev`.
4. Copy → `AISSTREAM_API_KEY=...`

**Free tier (verify — provider terms drift):** Free and in beta. No published hard quota at time of writing. No payment path, so no bill.

**Terms gotcha:** Free, beta, **no formal ToS** — treat availability as best-effort and don't build anything load-bearing on it. AIS is a public broadcast. Coverage is terrestrial: ships go quiet mid-ocean. Satellite AIS costs real money and is not offered here.

**Spending cap:** **Not applicable — no billing exists.**

**Paired throttle:** none, but two client-side render caps in `.env.example` protect *your laptop*, not your wallet:
- `VITE_AIS_LIVE_MAX_ROWS=12000` (drawn vessels)
- `VITE_AIS_LIVE_LABEL_MAX_ROWS=900` (labels after clustering)

Leave the defaults. If the globe stutters on a phone, drop `VITE_AIS_LIVE_MAX_ROWS` to `6000`.

---

## - [ ] 4. TomTom — real traffic flow

**Env var:** `TOMTOM_API_KEY`

**Unlocks:** Live congestion coloring on the traffic layer — real flow speeds painted on real OSM road geometry.

**Without it:** `/api/tomtom/flow/...` returns **503 `{error:'no_key'}`** and the traffic layer **runs its built-in simulation** — white dots moving at hardcoded per-road-class speeds on real OSM roads (`src/data/traffic.js`). The layer still works and looks good; it just isn't real. No TomTom attribution appears.

**Server-side only** — browser fetches same-origin `/api/tomtom/*`.

**Signup — https://developer.tomtom.com**

1. Register a free developer account.
2. **Dashboard → Keys** (a default app key is usually auto-created).
3. **Add new key** if you want a dedicated one — name it `gev`.
4. Make sure the key has the **Maps / Traffic** product enabled (GEV uses `traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf`).
5. Copy the **Consumer API Key** → `TOMTOM_API_KEY=...`

**Free tier (verify — provider terms drift):** ⚠️ **This repo's own docs disagree with themselves** — `.env.example` says "~50,000 tile requests/day", `DATA_SOURCES.md` says "200K tile requests/month". **Check https://docs.tomtom.com/pricing/ yourself** and size the budget var below from what you actually see.

**Terms gotcha:** Freemium BYOK. TomTom data is served live and cached only transiently (≤120 s TTL under `.gev-cache/`) — it is never bundled or redistributed, which is the compliant pattern. Keep the "Traffic flow data © TomTom" credit.

**Spending cap:**
- **Provider side:** TomTom Developer Portal → **Dashboard → your Key/App → usage limits**. The freemium tier does not silently auto-bill — you must explicitly add a payment method / upgrade to exceed the free allowance. **Do not add a card.** That is your hard cap. *(Verify.)*
- **Provider side, alerts:** Dashboard → **Usage / Analytics** to watch the running total.

**Paired throttle — set this:**
```
TOMTOM_DAILY_TILE_BUDGET=3000
```
Default is `40000`. That default is an *application safety ceiling*, not a guarantee of staying inside TomTom's monthly allowance — at 40,000/day you'd blow a 200K/month tier in five days. For one person, **3000** is generous (3000 × 30 = 90K/month, comfortably under 200K). Over the cap, the proxy serves cached/stale tiles instead of hitting upstream — the layer degrades, it does not die.

---

## - [ ] 5. OpenSky — more flight-polling credits

**Env vars:** `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `OPENSKY_AUTH_MODE`

**Unlocks:** A higher daily credit allowance on the worldwide live-flight snapshot, so the Flights layer refreshes more often before it gets rate-limited.

**Without it — read this, there's a trap.** `.env.example` ships `OPENSKY_AUTH_MODE=oauth`. With `oauth` set and no credentials, the proxy still sends the request, **anonymously**, with `reason: 'oauth_invalid_or_missing'` — and if OpenSky answers 401/403 you get an explicit error body ("OpenSky auth invalid. OAuth mode requires valid OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET.").

**👉 If you are not getting OpenSky credentials, set `OPENSKY_AUTH_MODE=anon` explicitly.** That's the clean keyless path.

Either way the layer is resilient: ~9 s response cache, a credit governor that honors OpenSky's `retry-after` (30 s … 30 min cooldown), serve-stale-on-429, and a bounded **250 nm adsb.lol point snapshot** around the camera subpoint as a regional fallback (`serveAdsbLolPointFallback`). Military flights and aircraft traces come from adsb.lol regardless, keylessly.

**Server-side only.**

**Signup — https://opensky-network.org**

1. Register a free account.
2. Log in → **Account** → **API Client** → create a new API client.
3. Download the `credentials.json` (it contains `clientId` / `clientSecret`).
4. Put them in `.env`:
   ```
   OPENSKY_AUTH_MODE=oauth
   OPENSKY_CLIENT_ID=...
   OPENSKY_CLIENT_SECRET=...
   ```
   (Alternatively point `OPENSKY_CREDENTIALS_FILE=/path/to/credentials.json`.)

**Free tier (verify — provider terms drift):** Anonymous is roughly a few hundred API credits/day per IP; a registered OAuth client is roughly an order of magnitude more. Numbers move — check OpenSky's REST API docs.

**⚠️ Terms gotcha — the sharpest one on this page.** OpenSky's license is **non-commercial research/education**, and *operational use of the REST API in a live product can require a prior written agreement with OpenSky — even for non-profit or government use.* `eye.dinoclyde.com` is a public URL. If it is genuinely your personal instance, you're in the spirit of the license; if it ever becomes anything more, contact OpenSky first.

**Spending cap:** **Not applicable — no billing exists.** Over-use costs credits, not dollars; the credit governor already handles exhaustion gracefully.

**Paired throttle:** none needed.

---

## - [ ] 6. App-side throttles — free, do this before you go public

Not keys. These are the per-IP guards that stop a stranger who finds `eye.dinoclyde.com` from spending your quota. **Set them.**

```
GEV_RATELIMIT_OPENAI_PER_MIN=10
GEV_RATELIMIT_GOOGLE_PER_MIN=20
TOMTOM_DAILY_TILE_BUDGET=3000
```

- **Default for both `GEV_RATELIMIT_*` is UNLIMITED.** Unset or `0` means no throttling at all. `.env.example` suggests 30 / 60; for a single human the values above are plenty and tighter.
- `GEV_RATELIMIT_OPENAI_PER_MIN` covers `/api/realtime/token` + `/api/openai/hud-summary`. The keyless HUD-summary response resolves *before* the limiter, so an unconfigured deploy never burns a quota slot.
- `GEV_RATELIMIT_GOOGLE_PER_MIN` covers `/api/google/nearby-places`. Same keyless-first ordering.
- ⚠️ **These are NOT billing caps.** They are per-IP, process-local, in-memory guards that reset on restart and return a sanitized 429. A determined abuser with many IPs walks straight through. Provider-side quotas (below) are the only real ceiling.

Also relevant for a NAS deploy: the server binds to `localhost` by default. `HOST=0.0.0.0` exposes **every key-brokering proxy** to the network. Put an auth proxy in front of `eye.dinoclyde.com` if you have not already — see `SECURITY.md`.

---

## - [ ] 7. Google Maps — metered. Only after you set a hard quota.

**Env var:** `GOOGLE_MAPS_API_KEY`

**Unlocks:** Direct Google Photorealistic 3D Tiles (better than the ion route, and the only route with place search), GEV free-text place search + voice navigation ("take me to LAX"), reverse-geocoded voice context, nearby-installation search for Global Context, and Street View static frames as a CCTV fallback.

**Without it:** `selectMapStartupRoute()` falls to `'google-ion'` if you have a Cesium ion token (you still get photorealistic 3D — just via ion), else `'osm'`/Esri. `/api/google/nearby-places` and `/api/google/search-text` return **HTTP 200** with `{configured:false, error:null, places:[]}` (`keylessGooglePlacesResponse`) — a deliberate, graceful "capability off", not an error. Street View CCTV fallback frames return `null`. Voice still works; it just can't geocode.

**⚠️ CLIENT-EXPOSED.** Injected into the browser bundle (`vite.config.js:7793`). The browser calls `maps.googleapis.com/maps/api/geocode/json?...&key=` directly from `src/locations.js`, `src/annotations/annotationResolver.js`, and `src/voice/gevActions.js`. **The key is in devtools. Restrict it or you will get billed for someone else's traffic.**

**Signup — https://console.cloud.google.com/**

1. Create a project. Name it `gods-eye-view`.
2. **Billing → Link a billing account.** A credit card is **required** — there is no cardless path to Maps Platform.
3. **APIs & Services → Library** → enable, one at a time:
   - **Map Tiles API** (the 3D globe)
   - **Geocoding API** (place search / voice navigation — browser-side)
   - **Places API (New)** (nearby + text search — server-side proxy)
   - *(optional)* **Street View Static API** (CCTV fallback frames)
4. **APIs & Services → Credentials → Create credentials → API key.**
5. Click the new key → rename it `gev-eye-dinoclyde`.
6. **Application restrictions → None.** (Counter-intuitive — see the gotcha below. A
   Websites/referrer rule would break this app's server-side Places calls.)
7. **API restrictions → Restrict key** → tick exactly the APIs from step 3.
8. **Save.** Copy → `GOOGLE_MAPS_API_KEY=...`

**⚠️ Restriction gotcha found in the code.** GEV uses this one key for **both** browser calls and server-side proxy calls. The server proxy (`places.googleapis.com/v1/places:searchNearby` and `:searchText`, and the Street View static fetch) sends **no `Referer` header** — so an HTTP-referrer-restricted key will be **rejected on those server-side calls**. Your options:
- **Recommended: leave Application restrictions on None**, keep the API restriction, and set **tight per-API quotas** (next section) so an abused key costs pennies. This keeps place search, voice "what's near here", and the Street View fallback all working. The usual argument for a referrer lock — "the key is in the browser bundle, anyone can scrape it" — is much weaker here, because the site sits behind a reverse-proxy access list, so the bundle is not publicly fetchable in the first place. Quotas plus that access list are doing the real work.
- Or: apply the referrer restriction and accept that nearby-places / text-search / Street View degrade to their keyless "not configured" responses. Choose this only if you do not care about place search.
- Or: create a second, unrestricted, *quota-capped* key and swap it in only when you want place search. One env var, so it's manual.

Whichever you pick, `.env.example` carries the same reasoning next to the variable itself.

**Free tier (verify — provider terms drift):** Photorealistic 3D Tiles: the first ~1,000 sessions/month are currently free, and one root request supports roughly three hours of rendering — a solo user exploring sparingly can realistically stay inside it. Geocoding and Places (New) have their own separate monthly free call allowances. Google restructured Maps Platform billing in 2025 (per-API free tiers replaced the old flat $200 credit) — **check https://developers.google.com/maps/billing-and-pricing/pricing before trusting any of this.**

**Terms gotcha:** Google Maps Content (tiles, geocodes, places) **may not be cached, stored, rehosted, or committed.** GEV only ever uses it live, which is compliant. The "Google" / "Google Maps" credit on the bottom-left credit line must stay visible — including in clean-view and recording modes. Billing must be enabled even when you stay inside the free tier.

**💸 SPENDING CAP — do all three:**

**A. Budget alert (notification only — does NOT stop spend):**
Cloud Console → ☰ **Billing** → select your billing account → **Budgets & alerts** → **CREATE BUDGET** → Scope: this project only → Amount: `$5` → Thresholds: 50% / 90% / 100% of actual spend → tick **"Email alerts to billing admins"** → Finish.

**B. HARD per-API daily quota — this is the one that actually stops money:**
Cloud Console → **APIs & Services** → **Enabled APIs & services** → click **Map Tiles API** → **Quotas & System Limits** tab → filter for the *per-day* request quota → click the pencil ✏️ → set a low daily limit (e.g. 500) → Submit.
**Repeat for Geocoding API and Places API (New).** Over the limit the API returns an error and stops billing. This is enforcement, not a warning.

**C. Also check the Maps-specific view:**
Cloud Console → **Google Maps Platform** → **Quotas** → pick each API → set **"Requests per day"**. Same mechanism, friendlier UI.

**Paired throttle:** `GEV_RATELIMIT_GOOGLE_PER_MIN=20` (see §6). Remember: app-side only, not a billing cap.

---

## - [ ] 8. OpenAI — the one that costs real money

**Env vars:** `OPENAI_API_KEY` (plus the tuning vars below)

**Unlocks:** Realtime voice control of the globe ("take me to LAX and select the nearest airborne aircraft") and the AI HUD summary.

**Without it:** `/api/realtime/token` returns **503 `{error:'OPENAI_API_KEY is not set'}`** — no mic. `/api/openai/hud-summary` returns **HTTP 200** `{configured:false, code:'OPENAI_NOT_CONFIGURED', error:null, summary:null}` (`src/hudSummaryResponse.js`) — a deliberate graceful "capability off". Everything else in the app is unaffected.

**Server-side only.** The browser gets a short-lived **ephemeral** Realtime session token; the real key never ships.

**Signup — https://platform.openai.com**

1. Create an account at https://platform.openai.com.
2. **Settings → Billing** → add a payment method → buy the **minimum** credit ($5).
3. **⚠️ Turn OFF auto-recharge / auto-reload.** Do this now, before anything else.
4. **https://platform.openai.com/api-keys** → **Create new secret key** → name it `gev`, scope it to a single **project** (not "all projects").
5. Copy (it is shown once) → `OPENAI_API_KEY=...`

**Pricing (verify — rates drift, and the repo says so too):** Realtime audio is a few cents per active minute. An evening of heavy use is single-digit dollars. In-repo rates were read from OpenAI's pricing page on **2026-08-18** (`VOICE_MODEL_RATES_VERIFIED_ON` in `src/voice/voiceCost.js`) — `gpt-realtime-2` audio input $32/1M tokens, audio-cached $0.40/1M, text in $4 / out $24. Cross-check before relying on them.

**Terms gotcha:** Standard OpenAI API terms. Nothing personal-use-specific. Voice audio is sent to OpenAI.

**💸 SPENDING CAP — do all three:**

**A. Prepaid balance with auto-recharge OFF (strongest cap).**
Platform → **Settings → Billing → Payment methods / Auto-recharge** → ensure auto-recharge is **disabled**. Your maximum possible loss is then exactly your prepaid balance. Keep it at $5–$10.

**B. Organization hard limit.**
Platform → **Settings → Organization → Limits** → set **"Monthly budget"** (hard — API stops serving) and **"Email notification threshold"** (soft warning). Set the monthly budget to something like `$10`.

**C. Project limit.**
Platform → **Settings → Project → Limits** → set a per-project monthly budget on the project your `gev` key belongs to. Belt and braces.

**App-side spend guard (already built in — `src/voice/voiceCost.js`):**
- `warnUsd: 2` — soft warning, one visual cue, session continues.
- `capUsd: 5` — **hard: the voice session is closed.**
- A live session-spend readout sits next to the mic, with an **STD / MINI** model toggle.
These are per-session runaway guards (a hot mic, a feedback loop), **not a monthly budget.** They do not stop you starting a new session.

**Cost-tuning env vars — keep these defaults, they exist to save you money:**
```
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_MODEL_MINI=gpt-realtime-2.1-mini   # the MINI toggle's model
OPENAI_REALTIME_REASONING_EFFORT=low
OPENAI_REALTIME_CONTEXT_TOKENS=3000                # short window; map state is fetched live
OPENAI_REALTIME_CONTEXT_RETENTION=0.5
OPENAI_HUD_SUMMARY_MODEL=gpt-5-nano                # cheap model for the HUD line
```
If OpenAI moves a model id, **override it here** rather than editing `src/voice/voiceCost.js`.

**Paired throttle:** `GEV_RATELIMIT_OPENAI_PER_MIN=10` (see §6). App-side only, not a billing cap.

---

## - [ ] 9. Launch Library 2 — skip it

**Env var:** `LL2_API_TOKEN`

**Unlocks:** A higher request allowance on the Space Missions (rolling 30 d) launch feed.

**Without it:** Works fine. `/api/launches` queries LL2 v2.3 anonymously, **caches successful responses for 15 minutes in memory and on disk**, and serves the last successful response through throttles and transient outages (`launchLibraryRequestHeaders` simply omits the `Authorization` header). Anonymous is **15 calls/hour**; at a 15-minute cache that is ~4 calls/hour of actual demand. You will not hit it.

**Signup (if you insist) — https://thespacedevs.com** → the LL2 API portal. Higher authenticated tiers are tied to supporting The Space Devs. **Verify** whether a free registered tier still exists.

**Terms gotcha:** The Space Devs permit using and sharing the data in any form, ask you not to forward it without adding value, disclaim completeness, and *encourage but do not require* attribution. GEV keeps a courtesy credit.

**Spending cap:** n/a.

**Verdict: skip.** Zero benefit at personal scale.

---

## FREE, NO SIGNUP — what works with zero keys

Boot the app with an empty `.env` and you still get all of this:

**Basemap & terrain**
- **Esri World Imagery** — the default keyless satellite basemap
- **OpenStreetMap** — map tray option + automatic provider-failure fallback
- **Re:Earth Terrain (Mapterhorn)** — real quantized-mesh terrain, keyless, with bundled EGM96 geoid math as its own fallback

**Live layers**
- **Flights** — OpenSky anonymous, with a bounded 250 nm **adsb.lol** regional fallback
- **Military flights + aircraft traces** — adsb.lol (ODbL)
- **Satellites** — CelesTrak TLEs, SGP4 propagation
- **Earthquakes** — USGS (US public domain)
- **Space Missions** — Launch Library 2 anonymous (15 calls/hr, 15 min cache)
- **CCTV** — City of Austin Open Data, Caltrans, TfL JamCams (London). All keyless; `TFL_APP_KEY` only raises TfL's rate limit
- **Traffic** — full simulated layer on real OSM road geometry (white dots, per-road-class speeds)
- **Radio** — Radio Browser directory, geolocated internet radio, PDDL 1.0
- **Bikeshare** — GBFS feeds (Lyft / BCycle)
- **Cockpit Local Info** — Nominatim reverse geocode + **Open-Meteo** weather + dynamic weather effects
- **Cockpit Regional News** — Google News RSS with **GDELT** as fail-soft fallback
- **Global Context** — OSM Overpass mapped installation context

**Bundled datasets (shipped in the repo)**
- Datacenters (~4.3K, ODbL) · Dams (704, ODbL) · TeleGeography submarine cables (712 cables + 1,917 landing points, **CC BY-NC-SA — non-commercial**) · Natural Earth physical regions (public domain) · DataSF SF neighborhoods (PDDL)

⚠️ Two non-commercial carve-outs to know about even keyless: **TeleGeography** submarine cables (delete `src/data/local_data/telegeography_submarine_cables/` if this ever becomes commercial) and **Google News RSS** (personal, noncommercial use only).

---

## 📦 Minimal-cost recommended set

> **Get on day one (all free, ~20 minutes total, $0/month):**
>
> | Key | Env var | Cost | Billing risk |
> |---|---|---|---|
> | Cesium ion | `CESIUM_ION_TOKEN` | $0 | none (no card on Community) |
> | NASA FIRMS | `FIRMS_MAP_KEY` | $0 | none (no billing exists) |
> | AISStream | `AISSTREAM_API_KEY` | $0 | none (no billing exists) |
> | TomTom | `TOMTOM_API_KEY` | $0 | none if you never add a card |
> | OpenSky OAuth | `OPENSKY_CLIENT_ID` / `_SECRET` | $0 | none (credits, not dollars) |
>
> **Plus, free, and mandatory for a public URL:**
> ```
> GEV_RATELIMIT_OPENAI_PER_MIN=10
> GEV_RATELIMIT_GOOGLE_PER_MIN=20
> TOMTOM_DAILY_TILE_BUDGET=3000
> ```
> And if you skip OpenSky credentials: `OPENSKY_AUTH_MODE=anon`
>
> **Expected monthly cost: $0.00.** Not one of the five has a payment path you haven't opted into.
>
> ---
>
> **Add later, deliberately, after caps are set:**
>
> | Key | Cost at personal usage | Get it if |
> |---|---|---|
> | **Google Maps** | ~$0/mo inside the free tier; **card required**, so a leaked unrestricted key is a real bill | You want in-app place search / voice navigation, or the direct (non-ion) 3D route. Set the per-API daily quotas (§7B) **before** you paste the key. |
> | **OpenAI** | $2–$10/mo at casual use; a heavy evening is single-digit dollars | You want to talk to the planet. Prepay $5, auto-recharge **off**, org monthly budget $10. |
>
> ---
>
> **Skip entirely:** `LL2_API_TOKEN` (anonymous + 15 min cache is plenty), `TFL_APP_KEY` (keyless JamCams work), `OPENSKY_USERNAME`/`OPENSKY_PASSWORD` (legacy Basic auth, OpenSky is retiring it), every `CCTV_*` tuning var (defaults are sensible), every `AISSTREAM_BOUNDING_BOXES` / `_MESSAGE_TYPES` filter (the default worldwide subscription is what you want — and narrowing it disarms the silence watchdog).

---

## Where the keys actually live

- **This deploy (NAS, non-localhost):** repo-root `.env`. Provider Settings is **disabled** whenever the server is not bound to localhost, so remote users can't reach the key-entry panel — which also means you edit `.env` by hand and restart.
- **Local dev:** POWER UP → Provider Settings writes `.env` for you (owner-only permissions) and restarts the dev server.
- **Pinokio:** writes `pinokio/ENVIRONMENT` instead. Do **not** use Pinokio 8.0.40's native Configure panel — it logs submitted values.
- **macOS:** `./scripts/dev-fresh.sh` pulls keys from the Keychain (`google-maps-api`, `openai-api`, `aisstream-api`, `firms-map`, `cesium-ion`).
- Keys from your shell or Keychain show as **"configured externally"** and are read-only to the panel.
- `npm run doctor` reports which providers are configured and where they were found — **without printing any credential values.**
