# Field Lab Vault (Umbrel)

Local-only encrypted notes and file attachments. Browser-side AES-256-GCM; the Python server stores ciphertext only.

## Umbrel install flow

1. Install from the Field Lab community app store.
2. Open the app in Umbrel — the HTTP landing redirects to `https://<your-umbrel-lan-host>:8449/` (master password screen).
3. On each device, open `/ca` (from the login link or `http://<host>/ca` before redirect) and install the **vault CA** so the browser trusts HTTPS on your LAN.
4. Create a long master passphrase (minimum 16 characters). There is no password recovery.

Optional: set `APP_LOCAL_VAULT_CERT_IPS` (comma-separated) to add LAN addresses to the server certificate, e.g. `192.168.1.50,192.168.4.99`. When unset, the app adds detected private IPs and `192.168.4.99`.

## Data layout

| Path under `${APP_DATA_DIR}` | Purpose |
|---|---|
| `data/state.json` | Encrypted vault index (ciphertext only) |
| `data/files/` | Encrypted attachment blobs |
| `cert/ca.crt`, `cert/ca.key` | Local CA (generated once; name-constrained to `.local` and `192.168.4.0/24`) |
| `cert/tls.crt`, `cert/tls.key` | CA-signed HTTPS server certificate (auto-renewed before expiry) |

## Tor

Umbrel may expose the HTTP landing page through a Tor hidden service. Do **not** use that URL to unlock the vault; WebCrypto requires HTTPS on your LAN.

## Tests

```sh
python3 -m playwright install chromium
python3 fieldlab-local-vault/app/tests/test_cert_setup.py
python3 fieldlab-local-vault/app/tests/e2e.py
```

Tests use isolated temp directories and synthetic passwords only.

## Image

Built by `.github/workflows/fieldlab-local-vault-image.yml` to `ghcr.io/fieldlabsolutions/fieldlab-local-vault`.
