#!/bin/sh
set -eu
DATA_DIR="${VAULT_DATA:-/data}"
CERT_DIR=$(dirname -- "${VAULT_CERT:-/cert/tls.crt}")
CERT_FILE="${VAULT_CERT:-/cert/tls.crt}"
KEY_FILE="${VAULT_KEY:-/cert/tls.key}"

require_writable() {
  dir=$1
  label=$2
  if [ ! -d "$dir" ]; then
    echo "fieldlab-local-vault: ${label} directory missing: ${dir}" >&2
    echo "On Umbrel, update the app from the store so data/ and cert/ install as uid 1000, or run:" >&2
    echo "  sudo chown -R 1000:1000 \"\${UMBREL_APP_DATA_PATH:-<app-data-dir>}\"" >&2
    exit 1
  fi
  if ! touch "${dir}/.write-test" 2>/dev/null; then
    echo "fieldlab-local-vault: ${label} is not writable by uid $(id -u) (got $(stat -c '%u:%g %a' "$dir" 2>/dev/null || echo 'unknown'))." >&2
    echo "Umbrel must ship data/ and cert/ owned by 1000:1000, not root. Fix on the host:" >&2
    echo "  sudo chown -R 1000:1000 \"$(dirname "$dir")\"" >&2
    exit 1
  fi
  rm -f "${dir}/.write-test"
}

require_writable "$DATA_DIR" "data"
require_writable "$CERT_DIR" "cert"
umask 077
if [ ! -s "$CERT_FILE" ]; then
  SAN="IP:127.0.0.1,DNS:localhost,DNS:umbrel.local"
  if [ -n "${VAULT_CERT_SAN_EXTRA:-}" ]; then
    SAN="${SAN},${VAULT_CERT_SAN_EXTRA}"
  fi
  if ! openssl req -x509 -newkey rsa:3072 -sha256 -nodes \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -days 825 -subj '/CN=Field Lab Vault' \
    -addext "subjectAltName=${SAN}" >/dev/null 2>&1; then
    echo "fieldlab-local-vault: failed to write TLS certificate under ${CERT_DIR} (check ownership and free space)." >&2
    exit 1
  fi
  chmod 600 "$KEY_FILE"
fi
exec python3 -B /app/server.py
