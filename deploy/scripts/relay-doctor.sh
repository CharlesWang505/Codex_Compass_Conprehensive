#!/usr/bin/env bash
set -u

CONFIG_FILE="/etc/codex-compass-relay/install.conf"
STATUS=0

ok() {
  printf '[OK] %s\n' "$*"
}

fail() {
  printf '[FAIL] %s\n' "$*" >&2
  STATUS=1
}

if [[ "$(id -u)" -ne 0 ]]; then
  fail "Run diagnostics as root or through sudo."
  exit "$STATUS"
fi

if [[ ! -r "$CONFIG_FILE" ]]; then
  fail "Missing $CONFIG_FILE. Re-run the Relay installer."
  exit "$STATUS"
fi

# shellcheck disable=SC1090
source "$CONFIG_FILE"

if systemctl is-active --quiet codex-compass-relay.service; then
  ok "Relay systemd service is active."
else
  fail "Relay systemd service is not active."
  systemctl --no-pager --full status codex-compass-relay.service || true
fi

if curl -fsS "http://127.0.0.1:${RELAY_PORT}/healthz" >/dev/null; then
  ok "Local Relay health check passed."
else
  fail "Local Relay health check failed on 127.0.0.1:${RELAY_PORT}."
fi

if nginx -t >/dev/null 2>&1; then
  ok "Nginx configuration is valid."
else
  fail "Nginx configuration is invalid."
  nginx -t || true
fi

if [[ -r "/etc/letsencrypt/live/${RELAY_DOMAIN}/fullchain.pem" ]] \
  && openssl x509 \
    -checkend 604800 \
    -noout \
    -in "/etc/letsencrypt/live/${RELAY_DOMAIN}/fullchain.pem" >/dev/null; then
  ok "TLS certificate is valid for at least seven more days."
else
  fail "TLS certificate is missing or expires within seven days."
fi

if curl -fsS "https://${RELAY_DOMAIN}/healthz" >/dev/null; then
  ok "Public HTTPS health check passed."
else
  fail "Public HTTPS health check failed."
fi

if ss -ltn | grep -Eq "127\\.0\\.0\\.1:${RELAY_PORT}[[:space:]]"; then
  ok "Relay is listening on loopback only."
else
  fail "Relay is not listening on the expected loopback address."
fi

printf '\nCompass settings:\n'
printf '  Website:  https://%s\n' "$RELAY_DOMAIN"
printf '  WebSocket: wss://%s/ws\n' "$RELAY_DOMAIN"
printf '\nRecent Relay logs:\n'
journalctl -u codex-compass-relay.service -n 20 --no-pager || true

exit "$STATUS"
