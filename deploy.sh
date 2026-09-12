#!/usr/bin/env bash
#
# God's Eye View — ZimaOS / ZimaCube deploy script.
#
# Usage:  sudo ./deploy.sh [--ip 172.20.0.10] [--branch NAME] [--help]
#
# What it does, in order:
#   1. preflight (docker + compose flavour)      5. pick a free static IP on proxy_net
#   2. clone or hard-sync the repo               6. build + start the container
#   3. refuse to start without a real .env       7. health + API + security checks
#   4. create proxy_net if missing               8. print the Nginx Proxy Manager recipe
#
# Safe to run over and over — nothing here is destructive to other containers.
# Run it again after every `git push`; it re-syncs, rebuilds and re-verifies.
#
set -euo pipefail

# ─── configuration (env-overridable) ──────────────────────────────────────────
REPO_URL="${GEV_REPO_URL:-https://github.com/Frappguy/gods-eye-view}"
# Deploy from main. This tracked the feature branch while the deployment work
# was unmerged; that branch is now merged and frozen at the pre-CCTV commit, so
# leaving it as the default silently re-deployed stale code on every re-run —
# the script reported success having changed nothing.
BRANCH="${GEV_BRANCH:-main}"
DEPLOY_DIR="${GEV_DEPLOY_DIR:-/DATA/AppData/gods-eye-view}"
CONTAINER_NAME="${GEV_CONTAINER:-gods-eye-view}"
NETWORK="${GEV_NETWORK:-proxy_net}"
SUBNET="${GEV_SUBNET:-172.20.0.0/16}"
APP_PORT="${GEV_PORT:-4173}"
DESIRED_IP="${GEV_STATIC_IP:-172.20.0.10}"
DOMAIN="${GEV_DOMAIN:-eye.dinoclyde.com}"
# Cold Cesium builds are slow. Budget generously; we poll often and report.
HEALTH_TIMEOUT="${GEV_HEALTH_TIMEOUT:-600}"
HEALTH_INTERVAL="${GEV_HEALTH_INTERVAL:-5}"
# Separate budget for the API assertions. Serving / only needs the process up;
# answering /api/cctv/sources needs the camera registry built, which is a much
# slower and entirely different thing (see api_first_char).
API_TIMEOUT="${GEV_API_TIMEOUT:-420}"
OVERRIDE_FILE="docker-compose.override.yml"

# ─── pretty output ────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'
  C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BOLD=''; C_DIM=''
fi
step() { printf '%s\n%s==> %s%s\n' "" "$C_BLUE" "$*" "$C_RESET"; }
log()  { printf '%s  ·%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s  !  %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()  { printf '%s  ✗  %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

usage() {
  # echo back this file's own header comment, stopping at the first code line
  awk 'NR==1{next} /^#/{sub(/^#[[:space:]]?/,""); print; next} {exit}' "$0"
  cat <<EOF

Options:
  --ip ADDR       static IP to request on $NETWORK (default $DESIRED_IP,
                  or \$GEV_STATIC_IP). Auto-bumped upward if taken.
  --branch NAME   git branch to deploy (default $BRANCH)
  --help          this text

Other env vars: GEV_REPO_URL GEV_DEPLOY_DIR GEV_CONTAINER GEV_NETWORK
                GEV_SUBNET GEV_PORT GEV_DOMAIN GEV_HEALTH_TIMEOUT
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --ip)      DESIRED_IP="${2:?--ip needs an address}"; shift 2 ;;
    --branch)  BRANCH="${2:?--branch needs a name}"; shift 2 ;;
    *) printf '%sUnknown argument: %s%s\n\n' "$C_RED" "$1" "$C_RESET" >&2; usage >&2; exit 2 ;;
  esac
done

# ══════════════════════════════════════════════════════════════════════════════
# Pure logic: pick a usable static IP.
#
#   gev_next_free_ip <desired-ip> <self-container-name>  < occupancy-on-stdin
#
# stdin is one "<ipv4> <container-name>" pair per line — every address already
# handed out on the network, plus the gateway. Prints the chosen address.
# Rules: desired wins if free; desired also wins if WE already hold it (a
# re-run is not a conflict); otherwise scan upward in the same /24, skipping
# .0/.1 and anything held by somebody else. Non-zero exit if the range is full.
# Kept free of docker calls precisely so it can be unit-tested.
# ══════════════════════════════════════════════════════════════════════════════
gev_next_free_ip() {
  local desired="${1:-}" self="${2:-}"
  local -A taken=()
  local ip name prefix last candidate occupant i

  if ! [[ "$desired" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    echo "gev_next_free_ip: '$desired' is not an IPv4 address" >&2
    return 2
  fi

  while read -r ip name; do
    [ -n "${ip:-}" ] || continue
    ip="${ip%%/*}"                       # tolerate CIDR form (172.20.0.2/16)
    [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || continue
    taken["$ip"]="${name:-unknown}"
  done

  prefix="${desired%.*}"
  last="${desired##*.}"
  last=$((10#$last))                     # strip any leading zero, force base 10

  for (( i = last; i <= 254; i++ )); do
    (( i >= 2 )) || continue             # .0 = network, .1 = gateway
    candidate="$prefix.$i"
    occupant="${taken[$candidate]:-}"
    if [ -z "$occupant" ] || [ "$occupant" = "$self" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "gev_next_free_ip: no free address in $prefix.$last-254" >&2
  return 1
}

# Sourced by the unit test? Stop here, expose the function only.
# shellcheck disable=SC2317  # the `exit` IS reached when run (not sourced)
if [ -n "${GEV_LIB_ONLY:-}" ]; then return 0 2>/dev/null || exit 0; fi

# ─── 0. docker config dir ─────────────────────────────────────────────────────
# ZimaOS mounts / (and so /root) read-only. The docker CLI and compose want to
# create ~/.docker for their config, and when they cannot, `compose up` dies
# with "mkdir /root/.docker: read-only file system" BEFORE it builds anything —
# which reads like a build failure but is not one. `docker info` still works,
# so preflight passes and the error only surfaces at step 6.
# Point DOCKER_CONFIG at the first writable candidate. An operator-supplied
# DOCKER_CONFIG is always respected as-is.
if [ -z "${DOCKER_CONFIG:-}" ]; then
  for _candidate in "${HOME:-/root}/.docker" "$(dirname "$DEPLOY_DIR")/.gev-docker" "/tmp/.gev-docker"; do
    if mkdir -p "$_candidate" 2>/dev/null && [ -w "$_candidate" ]; then
      if [ "$_candidate" != "${HOME:-/root}/.docker" ]; then
        export DOCKER_CONFIG="$_candidate"
      fi
      break
    fi
  done
  unset _candidate
fi

# ─── 1. preflight ─────────────────────────────────────────────────────────────
step "1/8  Preflight"
command -v docker >/dev/null 2>&1 || die "docker not found in PATH. This script expects ZimaOS with Docker installed."
command -v git    >/dev/null 2>&1 || die "git not found in PATH. Install git (ZimaOS: it ships in the app store image) and retry."
command -v curl   >/dev/null 2>&1 || die "curl not found in PATH."

if ! docker info >/dev/null 2>&1; then
  if [ "$(id -u)" -ne 0 ]; then
    die "cannot talk to the Docker daemon as $(id -un). Re-run with sudo:  sudo $0"
  fi
  die "the Docker daemon is not responding (docker info failed). Is it running?"
fi
[ "$(id -u)" -eq 0 ] || log "running as $(id -un) (not root) — docker socket is reachable, continuing"
ok "docker daemon responding"
[ -n "${DOCKER_CONFIG:-}" ] && log "DOCKER_CONFIG=$DOCKER_CONFIG (default ~/.docker is not writable on this host)"

COMPOSE=()
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose); ok "compose plugin: docker compose (v2)"
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
  COMPOSE=(docker-compose); ok "compose plugin: docker-compose (legacy v1)"
else
  die "neither 'docker compose' (v2 plugin) nor 'docker-compose' (v1) works here.
     Install one:  ZimaOS/CasaOS ships the v2 plugin — try 'docker compose version'
     to see the real error, or install docker-compose-plugin from your package manager."
fi
compose() { "${COMPOSE[@]}" "$@"; }

# ─── 2. clone or sync ─────────────────────────────────────────────────────────
step "2/8  Source at $DEPLOY_DIR"
if [ -d "$DEPLOY_DIR/.git" ]; then
  log "existing checkout found — fetching origin"
  git -C "$DEPLOY_DIR" remote set-url origin "$REPO_URL"
  git -C "$DEPLOY_DIR" fetch --prune origin "$BRANCH"
  # Hard-sync to the branch. Deliberately NO `git clean`: that would delete
  # .env (untracked, holds your API keys) and the generated override.
  git -C "$DEPLOY_DIR" checkout -B "$BRANCH" --no-track "origin/$BRANCH"
  git -C "$DEPLOY_DIR" reset --hard "origin/$BRANCH"
  ok "synced to origin/$BRANCH ($(git -C "$DEPLOY_DIR" rev-parse --short HEAD))"
elif [ -e "$DEPLOY_DIR" ] && [ -n "$(ls -A "$DEPLOY_DIR" 2>/dev/null)" ]; then
  die "$DEPLOY_DIR exists, is not empty, and is not a git checkout.
     Refusing to clobber it. Move it aside and re-run:
       mv $DEPLOY_DIR ${DEPLOY_DIR}.bak-\$(date +%s)"
else
  log "cloning $REPO_URL ($BRANCH)"
  mkdir -p "$(dirname "$DEPLOY_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$DEPLOY_DIR"
  ok "cloned ($(git -C "$DEPLOY_DIR" rev-parse --short HEAD))"
fi
cd "$DEPLOY_DIR"
[ -f docker-compose.yml ] || die "no docker-compose.yml in $DEPLOY_DIR — wrong branch, or the build files have not landed yet."

# ─── 3. .env gate ─────────────────────────────────────────────────────────────
step "3/8  Checking .env"
if [ ! -f .env ]; then
  printf '%s\n' "$C_RED" >&2
  cat >&2 <<EOF
  ✗  No .env file at $DEPLOY_DIR/.env — refusing to start a keyless container.

     A container without keys boots, serves a map, and then fails every API
     call at 11pm with no obvious cause. Set it up first:

         cd $DEPLOY_DIR
         cp .env.example .env
         nano .env          # or vi

     Which keys to get, and where from, is documented in:
         $DEPLOY_DIR/KEYS.md

     The app runs with NO keys at all (keyless Esri imagery), so you can fill
     in only the ones you care about — but the file itself must exist.
     Then re-run:  sudo $0
EOF
  printf '%s' "$C_RESET" >&2
  exit 1
fi

# .env holds API keys — owner-only, always.
env_perm="$(stat -c '%a' .env 2>/dev/null || echo '')"
if [ "$env_perm" != "600" ]; then
  chmod 600 .env && log "tightened .env permissions ${env_perm:-?} -> 600 (it holds API keys)"
fi

# Are any keys actually set? (KEY=value lines that are not comments/blank)
if ! grep -Eq '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]' .env; then
  warn ".env exists but every key line looks empty."
  warn "The app will start on keyless Esri imagery — no Google 3D, no live feeds that need tokens."
  warn "See KEYS.md and fill in what you want, then re-run."
fi

# The #1 self-inflicted 'container unreachable' bug.
if grep -Eq '^[[:space:]]*HOST[[:space:]]*=[[:space:]]*(localhost|127\.0\.0\.1)' .env; then
  warn "─────────────────────────────────────────────────────────────"
  warn "HOST=localhost (or 127.0.0.1) is set in .env."
  warn "docker-compose.yml overrides HOST to 0.0.0.0, so this line is IGNORED."
  warn "That is deliberate: bound to localhost, the server would only listen"
  warn "inside the container's own namespace and NPM could never reach it."
  warn "Nothing to fix — but delete the line so it stops confusing you later."
  warn "─────────────────────────────────────────────────────────────"
fi
ok ".env present"

# ─── 4. network ───────────────────────────────────────────────────────────────
step "4/8  Docker network '$NETWORK'"
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  # NEVER recreate: Filebrowser and friends are attached to it right now.
  ok "exists already — leaving it untouched"
else
  log "not found — creating bridge $NETWORK ($SUBNET)"
  docker network create --driver bridge --subnet "$SUBNET" "$NETWORK" >/dev/null
  ok "created"
fi

# ─── 5. static IP selection ───────────────────────────────────────────────────
step "5/8  Choosing a static IP"
occupancy="$(
  {
    docker network inspect "$NETWORK" \
      --format '{{range $id, $c := .Containers}}{{$c.IPv4Address}} {{$c.Name}}{{"\n"}}{{end}}'
    docker network inspect "$NETWORK" \
      --format '{{range .IPAM.Config}}{{if .Gateway}}{{.Gateway}} docker-gateway{{"\n"}}{{end}}{{end}}'
  } | sed 's#/[0-9]*##' | grep -E '^[0-9]' || true
)"
if [ -n "$occupancy" ]; then
  log "currently on $NETWORK:"
  printf '%s\n' "$occupancy" | while read -r a n; do printf '      %-14s %s\n' "$a" "$n"; done
else
  log "no containers currently attached"
fi

CHOSEN_IP="$(printf '%s\n' "$occupancy" | gev_next_free_ip "$DESIRED_IP" "$CONTAINER_NAME")" \
  || die "no free address available at or above $DESIRED_IP on $NETWORK.
     Free one up, or pass a different base:  sudo $0 --ip 172.20.0.50"

if [ "$CHOSEN_IP" != "$DESIRED_IP" ]; then
  holder="$(printf '%s\n' "$occupancy" | awk -v ip="$DESIRED_IP" '$1==ip{print $2; exit}')"
  warn "$DESIRED_IP is taken by '${holder:-another container}' — using $CHOSEN_IP instead."
fi

# We write the override unconditionally, even when the chosen IP equals the
# compose default. One generated file that always states the live answer beats
# a file that sometimes exists: no "is it stale?" guessing, and switching back
# to .10 later can't leave a stale .11 behind.
service_name="$(awk '
  /^[[:space:]]*container_name:[[:space:]]*'"$CONTAINER_NAME"'[[:space:]]*$/ { print svc; exit }
  /^[[:space:]]{2}[A-Za-z0-9._-]+:[[:space:]]*$/ { gsub(/[[:space:]:]/,"",$0); svc=$0 }
' docker-compose.yml || true)"
if [ -z "$service_name" ]; then
  service_name="$CONTAINER_NAME"
  log "could not detect the compose service name; assuming '$service_name'"
fi

before_services="$(compose -f docker-compose.yml config --services 2>/dev/null | sort || true)"
cat > "$OVERRIDE_FILE" <<EOF
# ─────────────────────────────────────────────────────────────────────────────
# GENERATED BY deploy.sh — DO NOT EDIT BY HAND. Rewritten on every run.
# Sole purpose: pin the static IP on $NETWORK. docker-compose.yml hardcodes
# $DESIRED_IP; if that address is already taken on the NAS, the deploy script
# picks the next free one and records it here. Nothing else belongs in here.
# Generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
# ─────────────────────────────────────────────────────────────────────────────
services:
  $service_name:
    networks:
      $NETWORK:
        ipv4_address: $CHOSEN_IP
EOF

after_services="$(compose config --services 2>/dev/null | sort || true)"
if [ -n "$before_services" ] && [ "$before_services" != "$after_services" ]; then
  rm -f "$OVERRIDE_FILE"
  die "the generated override would have added a phantom service ('$service_name' is
     not the service name in docker-compose.yml). Override removed, nothing changed.
     Fix: set the right name, or deploy with GEV_CONTAINER=<container_name>."
fi

printf '\n%s   ┌──────────────────────────────────────────┐%s\n' "$C_BOLD" "$C_RESET"
printf '%s   │  Container IP:  %-24s │%s\n' "$C_BOLD" "$CHOSEN_IP" "$C_RESET"
printf '%s   └──────────────────────────────────────────┘%s\n\n' "$C_BOLD" "$C_RESET"

# ─── 6. build and start ───────────────────────────────────────────────────────
step "6/8  Building and starting (this can take several minutes the first time)"
if ! compose up -d --build; then
  echo
  warn "compose up failed. Two usual suspects:"
  warn "  • 'Address already in use' — a STOPPED container still reserves $CHOSEN_IP."
  warn "    Find it:  docker ps -a --filter network=$NETWORK"
  warn "  • Build error — scroll up; the failing step prints its own error."
  die "deploy aborted"
fi
ok "container started"

# ─── 7. health + API + security checks ────────────────────────────────────────
BASE="http://$CHOSEN_IP:$APP_PORT"
step "7/8  Waiting for $BASE to answer (budget ${HEALTH_TIMEOUT}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
healthy=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -fsS -o /dev/null --max-time 10 "$BASE/"; then healthy=1; break; fi
  if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    echo; warn "container '$CONTAINER_NAME' is no longer running — last 50 log lines:"
    docker logs --tail 50 "$CONTAINER_NAME" 2>&1 || true
    die "container exited during startup"
  fi
  left=$(( deadline - $(date +%s) ))
  printf '\r%s  · still building/booting… %ss left%s ' "$C_DIM" "$left" "$C_RESET"
  sleep "$HEALTH_INTERVAL"
done
printf '\r%*s\r' 60 ''

if [ "$healthy" -ne 1 ]; then
  warn "no HTTP response from $BASE after ${HEALTH_TIMEOUT}s. Last 50 log lines:"
  docker logs --tail 50 "$CONTAINER_NAME" 2>&1 || true
  die "health check failed. If the build was simply still running, re-run with a
     bigger budget:  GEV_HEALTH_TIMEOUT=1200 sudo $0"
fi
ok "$BASE/ is serving"

# Serving HTML is not enough. Under a bare `vite preview` the dev-only API
# middleware is dropped and every /api route silently returns the SPA shell
# instead of JSON — a 200 that lies. Assert real JSON on two of them.
# The FIRST /api/cctv/sources call builds the camera registry, and since the
# world catalogs landed that means fetching 35 upstream catalogs before it can
# answer anything. On a cold container that runs well past any single curl
# timeout — observed in a real ZimaOS deploy still streaming "[CCTV] world/..."
# lines long after a 20s one-shot curl had already given up. The old check read
# that empty body as a dead API and failed a deploy whose container was merely
# still warming up. So: poll until it answers, and say so while waiting.
#
# A non-empty body ends the wait immediately, including an HTML one — HTML
# means the route is not mounted at all, which more waiting cannot fix.
api_first_char() {
  local url="$1" deadline c
  deadline=$(( $(date +%s) + API_TIMEOUT ))
  while :; do
    c="$(curl -fsS --max-time 30 "$url" 2>/dev/null | tr -d '[:space:]' | cut -c1)"
    if [ -n "$c" ]; then printf '%s' "$c"; return 0; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then return 1; fi
    printf '\r%s  · warming the camera registry (35 world catalogs)… %ss left%s ' \
      "$C_DIM" "$(( deadline - $(date +%s) ))" "$C_RESET"
    sleep "$HEALTH_INTERVAL"
  done
}
first_char() { api_first_char "$1"; }

for ep in /api/cctv/sources /api/radio/stations; do
  c="$(first_char "$BASE$ep" || true)"
  case "$c" in
    '{'|'[') printf '\r%*s\r' 70 ''; ok "$ep returns JSON" ;;
    '<') warn "$ep returned HTML, not JSON."
         warn "That means the API middleware is NOT mounted — the container is"
         warn "running a bare 'vite preview' instead of server/production-server.mjs."
         warn "The map will load and every live layer will be silently dead."
         docker logs --tail 50 "$CONTAINER_NAME" 2>&1 || true
         die "API layer not live" ;;
    '')  printf '\r%*s\r' 70 ''
         docker logs --tail 50 "$CONTAINER_NAME" 2>&1 || true
         die "$ep still had not answered after ${API_TIMEOUT}s.
     If the log above is still printing [CCTV] lines the registry was simply
     slower than the budget — raise it and re-run:
       GEV_API_TIMEOUT=900 sudo $0" ;;
    *)   die "$ep returned an unexpected body starting with '$c' (expected JSON)" ;;
  esac
done

# /api/setup/status writes credentials into .env. It MUST stay dead in
# production — the SPA fallback answering with HTML is the correct outcome.
c="$(first_char "$BASE/api/setup/status" || true)"
case "$c" in
  '{'|'[')
    warn "SECURITY REGRESSION: /api/setup/status is answering with JSON."
    warn "That endpoint writes API credentials into .env and must be disabled"
    warn "in production. It is reachable from anything that can reach this"
    warn "container — including the public site once NPM is pointed at it."
    die "refusing to call this deploy healthy; stop the container and fix the build" ;;
  *)  ok "/api/setup/status is inert (SPA fallback) — key editor correctly disabled" ;;
esac

# ─── 8. the bit you actually need ─────────────────────────────────────────────
step "8/8  Nginx Proxy Manager settings"
cat <<EOF

${C_BOLD}NPM (http://10.77.1.153:81) → Hosts → Proxy Hosts → ${C_GREEN}Add Proxy Host${C_RESET}
${C_YELLOW}Add a NEW host. Do not edit an existing one.${C_RESET}

${C_BOLD}Details tab${C_RESET}
  Domain Names ......... $DOMAIN
  Scheme ............... http
  Forward Hostname/IP .. ${C_GREEN}${C_BOLD}$CHOSEN_IP${C_RESET}
  Forward Port ......... $APP_PORT
  Cache Assets ......... off
  Block Common Exploits  ON
  Websockets Support ... ${C_BOLD}ON${C_RESET}   (live feeds + voice break without it)

  ${C_DIM}Forward Hostname must be that IP. Not "gods-eye-view", not "localhost".
  NPM resolves neither — a container name gives 502, localhost gives 502.${C_RESET}

${C_BOLD}SSL tab${C_RESET}
  SSL Certificate ...... the existing ${C_BOLD}*.dinoclyde.com${C_RESET} wildcard
  Force SSL ............ ON
  HTTP/2 Support ....... ON
  HSTS ................. optional

  ${C_DIM}If you leave the certificate as "None", Cloudflare answers 525
  (SSL handshake failed) and the site looks broken for no visible reason.${C_RESET}

${C_BOLD}Access List${C_RESET} — ${C_YELLOW}attach one.${C_RESET}
  Every /api call spends ${C_BOLD}your${C_RESET} API quota (Google, Cesium, TomTom…).
  Wide open = strangers billing your card. Use HTTP basic auth.
  ${C_DIM}An IP allow-list will NOT work as you expect: behind the Cloudflare
  proxy, the client IP NPM sees is a Cloudflare edge IP, not the visitor's.${C_RESET}

${C_BOLD}Cloudflare DNS${C_RESET}
  Nothing to do — the proxied wildcard *.dinoclyde.com already covers $DOMAIN.

EOF
ok "Deployed. $BASE  →  https://$DOMAIN"
echo
