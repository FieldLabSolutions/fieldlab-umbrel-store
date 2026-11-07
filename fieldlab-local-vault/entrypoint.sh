#!/bin/sh
set -eu
CERT_DIR=$(dirname -- "${VAULT_CERT:-/cert/tls.crt}")
umask 077
mkdir -p "$CERT_DIR"
if [ ! -s "${VAULT_CERT:-/cert/tls.crt}" ]; then
  SAN="IP:127.0.0.1,DNS:localhost,DNS:umbrel.local"
  if [ -n "${VAULT_CERT_SAN_EXTRA:-}" ]; then
    SAN="${SAN},${VAULT_CERT_SAN_EXTRA}"
  fi
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes \
    -keyout "${VAULT_KEY:-/cert/tls.key}" \
    -out "${VAULT_CERT:-/cert/tls.crt}" \
    -days 825 -subj '/CN=Field Lab Vault' \
    -addext "subjectAltName=${SAN}" >/dev/null 2>&1
  chmod 600 "${VAULT_KEY:-/cert/tls.key}"
fi
exec python3 -B /app/server.py
