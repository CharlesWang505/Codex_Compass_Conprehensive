#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN=""
EMAIL=""
RELAY_PORT="4178"
NON_INTERACTIVE=0
SKIP_DNS_CHECK=0
DRY_RUN_DIR=""

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_ROOT="/opt/codex-compass-relay"
RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
CONFIG_DIR="/etc/codex-compass-relay"
ENV_FILE="$CONFIG_DIR/relay.env"
INSTALL_CONFIG="$CONFIG_DIR/install.conf"
SYSTEMD_FILE="/etc/systemd/system/codex-compass-relay.service"
NGINX_AVAILABLE="/etc/nginx/sites-available/codex-compass-relay.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/codex-compass-relay.conf"
ACME_ROOT="/var/www/letsencrypt"
DOCTOR_BIN="/usr/local/sbin/codex-compass-relay-doctor"
MANAGED_NODE_DIR="/opt/codex-compass-node"
MINIMUM_NODE_VERSION="20.19.0"
NODE_RELEASE_LINE="latest-v22.x"

usage() {
  cat <<'EOF'
Codex Compass Relay installer

Usage:
  sudo bash deploy/scripts/install-relay.sh --domain relay.example.com --email admin@example.com

Options:
  --domain DOMAIN       Relay domain whose DNS already points to this VPS.
  --email EMAIL         Email used for Let's Encrypt expiry notices.
  --port PORT           Local Relay port. Default: 4178.
  --non-interactive     Fail instead of prompting for missing values.
  --skip-dns-check      Continue when the domain does not resolve yet.
  --dry-run DIRECTORY   Render managed configuration without changing the VPS.
  -h, --help            Show this help.
EOF
}

log() {
  printf '[Codex Compass] %s\n' "$*"
}

warn() {
  printf '[Codex Compass] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[Codex Compass] ERROR: %s\n' "$*" >&2
  exit 1
}

validate_domain() {
  local value="$1"
  [[ ${#value} -le 253 ]] || return 1
  [[ "$value" == *.* ]] || return 1
  [[ "$value" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]
}

validate_email() {
  [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

validate_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && (( "$1" >= 1024 && "$1" <= 65535 ))
}

version_at_least() {
  [[ "$(printf '%s\n' "$2" "$1" | sort -V | head -n 1)" == "$2" ]]
}

render_env() {
  cat <<EOF
RELAY_HOST=127.0.0.1
RELAY_PORT=$RELAY_PORT
EOF
}

render_systemd() {
  local node_bin="$1"
  cat <<EOF
[Unit]
Description=Codex Compass encrypted relay and mobile web
Documentation=https://github.com/CharlesWang505/Codex_Ultura
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=codex-relay
Group=codex-relay
WorkingDirectory=$CURRENT_LINK
EnvironmentFile=$ENV_FILE
ExecStart=$node_bin $CURRENT_LINK/index.mjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
UMask=0077

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
EOF
}

render_bootstrap_nginx() {
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root $ACME_ROOT;
    }

    location / {
        return 503;
        add_header Content-Type text/plain;
    }
}
EOF
}

render_nginx() {
  sed \
    -e "s/relay\\.example\\.com/$DOMAIN/g" \
    -e "s/127\\.0\\.0\\.1:4178/127.0.0.1:$RELAY_PORT/g" \
    "$ROOT_DIR/deploy/nginx/relay.example.com.conf"
}

write_connection_summary() {
  local destination="$1"
  cat >"$destination" <<EOF
Codex Compass Relay

Mobile website:
https://$DOMAIN

Compass WebSocket:
wss://$DOMAIN/ws

Health check:
https://$DOMAIN/healthz

The Relay listens locally on 127.0.0.1:$RELAY_PORT.
Do not expose ports 4178, 4179, or 8787 to the public internet.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      [[ $# -ge 2 ]] || die "--domain requires a value."
      DOMAIN="${2,,}"
      shift 2
      ;;
    --email)
      [[ $# -ge 2 ]] || die "--email requires a value."
      EMAIL="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || die "--port requires a value."
      RELAY_PORT="$2"
      shift 2
      ;;
    --non-interactive)
      NON_INTERACTIVE=1
      shift
      ;;
    --skip-dns-check)
      SKIP_DNS_CHECK=1
      shift
      ;;
    --dry-run)
      [[ $# -ge 2 ]] || die "--dry-run requires a directory."
      DRY_RUN_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  (( NON_INTERACTIVE == 0 )) || die "--domain is required in non-interactive mode."
  read -r -p "Relay domain (for example relay.example.com): " DOMAIN
  DOMAIN="${DOMAIN,,}"
fi
if [[ -z "$EMAIL" ]]; then
  (( NON_INTERACTIVE == 0 )) || die "--email is required in non-interactive mode."
  read -r -p "Let's Encrypt email: " EMAIL
fi

validate_domain "$DOMAIN" || die "Invalid domain. Enter a hostname without https://, a port, or a path."
validate_email "$EMAIL" || die "Invalid email address."
validate_port "$RELAY_PORT" || die "Relay port must be between 1024 and 65535."

if [[ -n "$DRY_RUN_DIR" ]]; then
  mkdir -p "$DRY_RUN_DIR"
  render_env >"$DRY_RUN_DIR/relay.env"
  render_systemd "/usr/bin/node" >"$DRY_RUN_DIR/codex-compass-relay.service"
  render_bootstrap_nginx >"$DRY_RUN_DIR/nginx-bootstrap.conf"
  render_nginx >"$DRY_RUN_DIR/nginx.conf"
  write_connection_summary "$DRY_RUN_DIR/compass-settings.txt"
  log "Dry-run configuration written to $DRY_RUN_DIR"
  exit 0
fi

[[ "$(id -u)" -eq 0 ]] || die "Run this installer as root or through sudo."
[[ -f "$ROOT_DIR/server/package-lock.json" ]] || die "server/package-lock.json is missing from the deployment bundle."
[[ -f "$ROOT_DIR/deploy/nginx/relay.example.com.conf" ]] || die "Nginx template is missing from the deployment bundle."

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
else
  die "Cannot identify the operating system."
fi
case "${ID:-}" in
  ubuntu|debian) ;;
  *) die "This installer currently supports Ubuntu and Debian. Detected: ${ID:-unknown}" ;;
esac

if (( SKIP_DNS_CHECK == 0 )) && ! getent ahosts "$DOMAIN" >/dev/null 2>&1; then
  die "$DOMAIN does not resolve yet. Point its DNS record to this VPS or use --skip-dns-check."
fi

export DEBIAN_FRONTEND=noninteractive
log "Installing operating-system packages..."
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  certbot \
  curl \
  iproute2 \
  nginx \
  openssl \
  tar \
  xz-utils

NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"
NODE_VERSION=""
if [[ -n "$NODE_BIN" ]]; then
  NODE_VERSION="$("$NODE_BIN" -p "process.versions.node" 2>/dev/null || true)"
fi

if [[ -z "$NODE_BIN" || -z "$NPM_BIN" || -z "$NODE_VERSION" ]] \
  || ! version_at_least "$NODE_VERSION" "$MINIMUM_NODE_VERSION"; then
  log "Installing a verified Node.js 22 binary from nodejs.org..."
  case "$(dpkg --print-architecture)" in
    amd64) NODE_ARCH="x64" ;;
    arm64) NODE_ARCH="arm64" ;;
    *) die "Unsupported VPS architecture: $(dpkg --print-architecture)" ;;
  esac

  NODE_TEMP="$(mktemp -d /tmp/codex-compass-node.XXXXXX)"
  curl -fsSLo "$NODE_TEMP/SHASUMS256.txt" \
    "https://nodejs.org/dist/$NODE_RELEASE_LINE/SHASUMS256.txt"
  NODE_ARCHIVE="$(awk -v arch="$NODE_ARCH" \
    '$2 ~ ("^node-v[0-9.]+-linux-" arch "\\.tar\\.xz$") { print $2; exit }' \
    "$NODE_TEMP/SHASUMS256.txt")"
  [[ -n "$NODE_ARCHIVE" ]] || die "Could not locate the Node.js archive for $NODE_ARCH."
  curl -fsSLo "$NODE_TEMP/$NODE_ARCHIVE" \
    "https://nodejs.org/dist/$NODE_RELEASE_LINE/$NODE_ARCHIVE"
  (
    cd "$NODE_TEMP"
    grep "  $NODE_ARCHIVE\$" SHASUMS256.txt | sha256sum -c -
  )

  MANAGED_NODE_NEW="$MANAGED_NODE_DIR.new.$$"
  rm -rf -- "$MANAGED_NODE_NEW"
  install -d -o root -g root -m 0755 "$MANAGED_NODE_NEW"
  tar -xJf "$NODE_TEMP/$NODE_ARCHIVE" \
    --strip-components=1 \
    -C "$MANAGED_NODE_NEW"
  rm -rf -- "$MANAGED_NODE_DIR"
  mv "$MANAGED_NODE_NEW" "$MANAGED_NODE_DIR"
  rm -rf -- "$NODE_TEMP"

  NODE_BIN="$MANAGED_NODE_DIR/bin/node"
  NPM_BIN="$MANAGED_NODE_DIR/bin/npm"
  NODE_VERSION="$("$NODE_BIN" -p "process.versions.node")"
fi
version_at_least "$NODE_VERSION" "$MINIMUM_NODE_VERSION" \
  || die "Node.js $MINIMUM_NODE_VERSION or newer is required. Detected: $NODE_VERSION"
log "Using Node.js $NODE_VERSION at $NODE_BIN"

getent group codex-relay >/dev/null || groupadd --system codex-relay
id codex-relay >/dev/null 2>&1 || useradd \
  --system \
  --gid codex-relay \
  --home-dir /nonexistent \
  --shell /usr/sbin/nologin \
  codex-relay

install -d -o root -g root -m 0755 "$APP_ROOT" "$RELEASES_DIR"
install -d -o root -g codex-relay -m 0750 "$CONFIG_DIR"

PACKAGE_VERSION="$("$NODE_BIN" -p \
  "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" \
  "$ROOT_DIR/server/package.json")"
RELEASE_ID="${PACKAGE_VERSION}-$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
install -d -o root -g root -m 0755 "$RELEASE_DIR"
cp -a "$ROOT_DIR/server/." "$RELEASE_DIR/"
(
  cd "$RELEASE_DIR"
  PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --omit=dev --ignore-scripts
  "$NODE_BIN" --check index.mjs
)
chown -R root:root "$RELEASE_DIR"

OLD_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
ln -sfn "$RELEASE_DIR" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$CURRENT_LINK"

render_env >"$ENV_FILE"
chown root:codex-relay "$ENV_FILE"
chmod 0640 "$ENV_FILE"

cat >"$INSTALL_CONFIG" <<EOF
RELAY_DOMAIN=$DOMAIN
RELAY_PORT=$RELAY_PORT
NODE_BIN=$NODE_BIN
EOF
chown root:codex-relay "$INSTALL_CONFIG"
chmod 0640 "$INSTALL_CONFIG"

render_systemd "$NODE_BIN" >"$SYSTEMD_FILE"
chmod 0644 "$SYSTEMD_FILE"
install -o root -g root -m 0755 \
  "$ROOT_DIR/deploy/scripts/relay-doctor.sh" \
  "$DOCTOR_BIN"

systemctl daemon-reload
systemctl enable codex-compass-relay.service >/dev/null
if ! systemctl restart codex-compass-relay.service; then
  if [[ -n "$OLD_RELEASE" && -d "$OLD_RELEASE" ]]; then
    warn "The new release failed to start. Restoring the previous release."
    ln -sfn "$OLD_RELEASE" "$APP_ROOT/current.next"
    mv -Tf "$APP_ROOT/current.next" "$CURRENT_LINK"
    systemctl restart codex-compass-relay.service || true
  fi
  systemctl --no-pager --full status codex-compass-relay.service || true
  die "Relay service failed to start."
fi

for attempt in {1..20}; do
  if curl -fsS "http://127.0.0.1:$RELAY_PORT/healthz" >/dev/null; then
    break
  fi
  (( attempt < 20 )) || die "Relay did not pass its local health check."
  sleep 1
done

log "Configuring Nginx and Let's Encrypt..."
install -d -o root -g root -m 0755 "$ACME_ROOT"
if [[ -r "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]] \
  && [[ -r "/etc/letsencrypt/live/$DOMAIN/privkey.pem" ]]; then
  render_nginx >"$NGINX_AVAILABLE"
else
  render_bootstrap_nginx >"$NGINX_AVAILABLE"
fi
ln -sfn "$NGINX_AVAILABLE" "$NGINX_ENABLED"
nginx -t
systemctl enable --now nginx >/dev/null
systemctl reload nginx

certbot certonly \
  --webroot \
  --webroot-path "$ACME_ROOT" \
  --domain "$DOMAIN" \
  --cert-name "$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --non-interactive \
  --no-eff-email \
  --keep-until-expiring

render_nginx >"$NGINX_AVAILABLE"
nginx -t
systemctl reload nginx

install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat >"/etc/letsencrypt/renewal-hooks/deploy/reload-codex-compass-nginx" <<'EOF'
#!/usr/bin/env sh
systemctl reload nginx
EOF
chmod 0755 "/etc/letsencrypt/renewal-hooks/deploy/reload-codex-compass-nginx"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

for attempt in {1..15}; do
  if curl -fsS "https://$DOMAIN/healthz" >/dev/null; then
    break
  fi
  (( attempt < 15 )) || die "HTTPS health check failed for https://$DOMAIN/healthz."
  sleep 2
done

write_connection_summary "/root/codex-compass-relay-info.txt"
chmod 0600 "/root/codex-compass-relay-info.txt"

log "Relay installation completed."
printf '\n'
cat "/root/codex-compass-relay-info.txt"
printf '\nRun diagnostics with:\n  sudo codex-compass-relay-doctor\n'
