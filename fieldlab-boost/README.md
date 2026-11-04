# Field Lab Boost (v0.1.0) — local-only Umbrel app

Phone-friendly dark web UI for the Umbrel LND node:
- **Boost**: search Podcast Index (optional) or paste an RSS feed → shows show/artwork/episode and the
  `<podcast:value>` payees with splits → explicit **Confirm** → keysend (`type=node`) or
  Lightning address / LNURL-pay (`type=lnaddress`). Item value blocks override the channel block.
- **Pay**: decode BOLT11 first (amount, description, expiry) → confirm → pay.
- **Receive**: create invoice (amount, memo) with QR, polls until paid.
- **History**: `/data/history.json`. Node balance/channel summary at the top.

Runs on stock `node:20-alpine` with the app folder mounted; no npm deps (QR lib vendored, MIT).
**`DRY_RUN=true` is the default** — no sats move until it is set to `"false"`. `MAX_PAYMENT_SATS` caps any single action (default 50,000).

## Layout
```
umbrel-app.yml  docker-compose.yml  README.md
app/server.js            HTTP server + API routes
app/lib/value.js         RSS / value block parser + split math
app/lib/keysend.js       keysend body (preimage 5482373484, hash=sha256, boost 7629169, customKey)
app/lib/lnurl.js         Lightning address / LNURL-pay resolution
app/lib/lnd.js           LND REST client (macaroon only in header; never logged/returned)
app/lib/history.js  app/lib/http.js
app/public/              index.html, app.js, style.css, vendor/qrcode.js
app/test/                unit + e2e tests, sample feed, mock LND/LNURL server
```

## Tests
```
cd app && npm test        # node --test, no installs
npm run mock              # mock LND on :18080 for a manual UI try:
DATA_DIR=/tmp/b DRY_RUN=true LND_REST=http://127.0.0.1:18080 MACAROON_PATH=/tmp/b/m ALLOW_HTTP_LOCAL=true PORT=8080 node server.js
# (write bytes 0xdeadbeef to /tmp/b/m; feed URL http://127.0.0.1:18080/feed.xml)
```

## Macaroon (limited, not admin)
Needed permissions:
- `info:read` (getinfo), `offchain:read` (channel balance, list channels, decode payreq),
- `offchain:write` (SendPaymentSync: keysend + BOLT11),
- `invoices:read`, `invoices:write` (create + lookup invoice).
- `onchain:read` only if you want the on-chain balance (not used by the UI).

Bake once (as admin, from Node Master, never commit/print the output):
```
curl --cacert tls.cert -H "Grpc-Metadata-macaroon: $(xxd -ps -u -c 1000 admin.macaroon)" \
  -X POST https://10.21.21.9:8080/v1/macaroon -d '{"permissions":[
   {"entity":"info","action":"read"},{"entity":"offchain","action":"read"},
   {"entity":"offchain","action":"write"},{"entity":"invoices","action":"read"},
   {"entity":"invoices","action":"write"}]}' \
 | python3 -c 'import sys,json,binascii;sys.stdout.buffer.write(binascii.unhexlify(json.load(sys.stdin)["macaroon"]))' \
 > ~/umbrel/app-data/fieldlab-boost/data/boost.macaroon && chmod 600 …/boost.macaroon
```
(or `lncli bakemacaroon info:read offchain:read offchain:write invoices:read invoices:write --save_to boost.macaroon`).
Note: channel open/close needs `onchain:write`, which this macaroon lacks. Any payment-capable macaroon can still spend the whole channel balance, so
keep `MAX_PAYMENT_SATS` low and the app LAN-only.

## Deploy (not done — needs Daniel's OK)
1. Fresh backup check; copy this folder to `~/umbrel/app-data/fieldlab-boost/` on Node Master
   (same pattern as `fieldlab-miner-controller`), create `data/` owned by 1000:1000.
2. Bake `data/boost.macaroon` as above. Confirm the LND data dir mount contains `tls.cert`
   (`${APP_LIGHTNING_NODE_DATA_DIR}`), and `LND_REST` resolves (`APP_LIGHTNING_NODE_IP`, default 10.21.21.9).
3. Install from the Umbrel UI (community/local app), open on port 8743, test in DRY_RUN.
4. Flip `DRY_RUN: "false"` only after a 1-sat test with Daniel's OK. Remote/phone access later, separately approved.
