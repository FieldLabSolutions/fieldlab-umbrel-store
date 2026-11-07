# Field Lab Vault (Umbrel)

Local-only encrypted notes and file attachments. Browser-side AES-256-GCM; the Python server stores ciphertext only.

## Umbrel install flow

1. Install from the Field Lab community app store.
2. Open the app in Umbrel to view the **HTTP landing page** (no passwords).
3. Follow the link to `https://<your-umbrel-lan-host>:8449/`.
4. Compare the certificate SHA-256 fingerprint on the landing page with your browser warning, then proceed.
5. Create a long master passphrase (minimum 16 characters). There is no password recovery.

Optional: set `APP_LOCAL_VAULT_CERT_SAN_EXTRA` in `exports.sh` (via app data / Umbrel env) to add your LAN IP to the generated certificate, e.g. `IP:192.168.1.50`.

## Data layout

| Path under `${APP_DATA_DIR}` | Purpose |
|---|---|
| `data/state.json` | Encrypted vault index (ciphertext only) |
| `data/files/` | Encrypted attachment blobs |
| `cert/tls.crt`, `cert/tls.key` | Self-signed HTTPS cert (generated on first run) |

## Tor

Umbrel may expose the HTTP landing page through a Tor hidden service. Do **not** use that URL to unlock the vault; WebCrypto requires HTTPS on your LAN.

## Tests

```sh
python3 -m playwright install chromium
python3 fieldlab-local-vault/app/tests/e2e.py
```

Tests use isolated temp directories and synthetic passwords only.

## Image

Built by `.github/workflows/fieldlab-local-vault-image.yml` to `ghcr.io/fieldlabsolutions/fieldlab-local-vault`.
