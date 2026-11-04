# Dirty Boost Whore (v0.2.0) — local-only Umbrel app with its own Lightning wallet

> ## ⚠️ UNINSTALLING THIS APP DELETES ITS WALLET AND SEED
> The boost wallet lives in `~/umbrel/app-data/fieldlab-boost/data/lnd`. Umbrel deletes that folder on uninstall.
> **The 24 words shown once at setup are the only backup.** Write them on paper before tapping "Finish setup".
> Before any uninstall: close channels and sweep funds out, or be sure you hold the 24 words (plus `channel.backup` for open channels).


Phone-friendly dark web UI for the Umbrel LND node:
- **Boost**: search Podcast Index (optional) or paste an RSS feed → shows show/artwork/episode and the
  `<podcast:value>` payees with splits → explicit **Confirm** → keysend (`type=node`) or
  Lightning address / LNURL-pay (`type=lnaddress`). Item value blocks override the channel block.
- **Pay**: decode BOLT11 first (amount, description, expiry) → confirm → pay.
- **Receive**: create invoice (amount, memo) with QR, polls until paid.
- **History**: `/data/history.json`. Node balance/channel summary at the top.

Runs on stock `node:20-alpine` with the app folder mounted; no npm deps (QR lib vendored, MIT).
**`DRY_RUN=true` is the default** — no sats move until it is set to `"false"`. `MAX_PAYMENT_SATS` caps any single action (default 50,000).


## What's new in 0.2.0: one app, two containers
| Container | What it is |
|---|---|
| `web` | node:20-alpine, the boost UI/API (unchanged features: boosts via `/v2/router/send`, pay, invoices, saved podcasts, history) |
| `lnd` | `lightninglabs/lnd:v0.21.6-beta` (same digest Umbrel's `lightning` app pins), **its own seed/wallet/channels**, data in `${APP_DATA_DIR}/data/lnd` |

- Depends on `bitcoin` only (Umbrel Bitcoin Core: RPC + ZMQ rawblock/rawtx via `APP_BITCOIN_*`, as in getumbrel/umbrel-apps `lightning/exports.sh`). No dependency on `lightning`; the main node "Stranger Danger" is not touched.
- Alias `node-7f3a`, color #808080.
- **No inbound:** `--nolisten`, `--nat=false`, no `externalip`, no ports published on the host. LND REST/gRPC are reachable only by the `web` container at 10.21.21.91 on Umbrel's internal network.
- **Tor for outbound only:** `--tor.active --tor.socks=${TOR_PROXY_IP}:${TOR_PROXY_PORT} --tor.skip-proxy-for-clearnet-targets=false`. `TOR_PROXY_IP`/`TOR_PROXY_PORT` are set by umbrelOS (`legacy-compat/app-script.ts`/`app-environment.ts`: 10.21.21.11:9050). No `--tor.v3`/`--tor.control`, so LND creates **no hidden service**.
- **Auto-unlock:** the setup screen generates a random 32-byte password server-side, writes it hex-encoded to `data/lnd/wallet-password` (mode 600), then calls `initwallet`. The lnd container's entrypoint adds `--wallet-unlock-password-file … --wallet-unlock-allow-create` only if that file exists, because LND **exits at startup if the flag points at a missing file** (lnd `config.go`, verified). Password never in repo, chat, logs or API responses.

## Layout
```
umbrel-app.yml           manifest (deps: bitcoin)
exports.sh               LND IP/ports/command line (sourced by umbrelOS)
docker-compose.yml       app_proxy + web + lnd
data/lnd/.gitkeep        LND data dir (wallet, tls.cert, admin.macaroon, wallet-password)
app/server.js            HTTP server + routes
app/lib/lnd.js           LND REST client; bakes the app macaroon; router send
app/lib/wallet.js        first-run setup, deposit address, channel open, peer presets
app/lib/{value,keysend,lnurl,shows,history,http}.js   unchanged
app/public/              UI (Boost / Pay / Receive / History / Wallet tabs)
app/test/                unit + e2e + wallet tests, mock LND
```

## Full flow
1. **Install** from the Field Lab store. The `lnd` container starts with no wallet (`/v1/state` = `NON_EXISTING`). The header says "Boost wallet not set up yet" and the app opens the Wallet tab — no errors.
2. **Create wallet** → server calls `GET /v1/genseed`, keeps the 24 words **in memory only** (30 min), shows them once.
3. Tick **"I wrote them down, in order"** and type the requested word (#1–24, random) → `POST /api/wallet/init`:
   writes `wallet-password` (600) → `POST /v1/initwallet` → wipes the words from memory. Re-running setup is refused once a wallet exists.
4. LND unlocks; on first authenticated call the app reads `admin.macaroon` (once) and bakes **`/data/boost-node.macaroon`** (600) via `POST /v1/macaroon` with:
   `info:read offchain:read/write invoices:read/write onchain:read/write address:read/write peers:read/write`. All later calls use only that.
5. **Deposit:** "Show deposit address" → `GET /v1/newaddress?type=WITNESS_PUBKEY_HASH` → `bitcoin:` QR + copy. Balances card: on-chain confirmed / unconfirmed / spendable with ≥3 confs (`/v1/utxos?min_confs=3`), Lightning can-send / can-receive.
6. Send on-chain from Strike (or anywhere). Wait for 3 confirmations.
7. **Open channel:** pick ACINQ, Kraken, or custom `pubkey@host:port`; amount default 500,000; **Private** ticked by default.
   "Review channel" checks: valid URI, ≥ 20,000 sats, ≥3-conf funds ≥ amount + 5,000 sat fee buffer; warns if Kraken < 1,000,000 or if public.
   "Open" asks a second confirm, then `POST /v1/peers` (over Tor) and `POST /v1/channels` with `private, min_confs: 3, spend_unconfirmed: false, target_conf: 6`. In **DRY_RUN** nothing is sent.
8. Once the channel is active, boosts/pay draw from this wallet only (outbound = what you funded). Back up `data/lnd/data/chain/bitcoin/mainnet/channel.backup` after each open.

### Peer presets (checked 2026-11-04)
- ACINQ `03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f@3.33.236.230:9735` — 1ml.com, lightningnetwork.plus, Electrum trampoline list. Minimum channel size **not found**.
- Kraken `02437c00ef5de2686a6bd60f8acb5c83d17010916010a15f479d5ef84c04f04485@67.208.234.136:9735` — support.kraken.com (2026-08-19). **Minimum 1,000,000 sats.** Old key 02f1a8…0b69 is dead.

## Macaroon choice
The app bakes its own macaroon from `admin.macaroon` (it has to: nothing else exists right after `initwallet`). Honest limits:
- `admin.macaroon` stays readable inside the `web` container (the whole `data/` dir is mounted rw so the app can write the unlock file). The baked macaroon narrows what the running code uses, not what a compromised `web` container could reach.
- Channel open needs `onchain:write` + `peers:write`, so the baked macaroon can also move on-chain funds. That's inherent to having the channel-open screen.
- To harden later: after the first channel, delete the channel-open perms by re-baking without `onchain:write` (manual step, not automated).

## Config (docker-compose `web` env)
`LND_REST=https://${APP_BOOST_LND_IP}:${APP_BOOST_LND_REST_PORT}` (10.21.21.91:8080), `TLS_CERT_PATH=/data/lnd/tls.cert`, `MACAROON_PATH=/data/boost-node.macaroon`,
`ADMIN_MACAROON_PATH=/data/lnd/data/chain/bitcoin/${APP_BOOST_NETWORK}/admin.macaroon`, `WALLET_PASSWORD_FILE=/data/lnd/wallet-password`, `DRY_RUN="true"`, `SENDER_NAME=""`, `MAX_PAYMENT_SATS=50000`.

## Tests
```
cd app && npm test        # 12 tests: unit, e2e boost/pay/invoice (dry + live, router send), wallet setup, channel open (dry + live)
```
The wallet test asserts: uninitialised summary is not an error; confirm + correct check word required; one-shot setup; password file is 600 and matches what LND got;
macaroon baked exactly once (even with concurrent calls) with no `macaroon:*`/`signer:*`; app calls don't use admin; seed words and password appear nowhere on disk or in logs.
Local demo: `node test/mock-servers.js` style mock with `walletState: 'NON_EXISTING'` (screenshots in `/workspace/boost-shots/v3-*.png`).

## Upgrade from 0.1.x (existing install on Node Master)
- After updating, the app talks to **its new LND**, not Stranger Danger. Balance shows 0 until funded. The old `data/boost.macaroon` (main-node token) is unused and can be deleted later (ask Daniel).
- The lnd container needs `data/lnd` owned by uid 1000. If Umbrel's update doesn't copy the new `data/lnd/` dir (see 0.1.1 experience where `app/` wasn't replaced), create it: `mkdir -p ~/umbrel/app-data/fieldlab-boost/data/lnd` as uid 1000.
- Bitcoin Core must be fully synced; LND will sync its own chain view (a few minutes to hours on first start).

## Risks
- **Uninstall = wallet deleted.** See top.
- **RAM:** second LND ≈ 300–500 MB + graph sync on a busy Node Master.
- **Hot wallet:** the unlock password sits next to the wallet on disk; anyone with Node Master file access can spend.
- **Privacy:** the channel peer (ACINQ/Kraken) sees this node's pubkey and every payment it forwards; Tor hides the home IP from peers. Keysend recipients see `node-7f3a`'s pubkey. The private channel is hidden from the graph but known to the peer. Strike knows the deposit address it paid (KYC link to that UTXO/channel on-chain).
- **Tor-only peers:** with Tor on, connections to clearnet peers go through Tor exits; slower, and some peers may drop Tor connections.
- No inbound: can't receive Lightning top-ups until there's inbound liquidity (the Receive tab's invoices won't be payable at first).

## Verification after install (needs Daniel's OK to update)
1. Umbrel shows the app running; `web` logs `Dirty Boost Whore on :8080 (DRY_RUN=true, LND https://10.21.21.91:8080)`.
2. Wallet tab shows setup (not an error). Complete setup; `ls -l data/lnd/wallet-password` → `-rw-------` uid 1000.
3. Restart the app from Umbrel → wallet comes back unlocked (state SERVER_ACTIVE) without RPC unlock.
4. `/api/summary` → alias `node-7f3a`, `synced: true`. `getinfo.uris` empty (no announced address).
5. Stranger Danger unchanged (alias, 2 channels).
6. `ss -ltn` on Node Master: nothing new bound on the host for 8080/10009/9735 by this app.
7. Deposit small amount, 3 confs, open private channel in DRY_RUN first, then live with Daniel's OK; then a small live boost with his OK.

## Unverified
- Not run on a real Umbrel/LND (no Docker on the box; Node Master untouched). Compose/manifest parse with PyYAML, `exports.sh` passes `bash -n` and renders the expected command line, the entrypoint wrapper was tested with a fake `lnd` binary.
- Whether Umbrel's update path copies the new `data/lnd/` placeholder into an existing install.
- LND behaviour of `--nolisten` together with `--tor.active` and no hidden service (flags exist in v0.21.6 config; combination not run).
- That `/v1/macaroon` bake works right after `initwallet` before the node finishes syncing (app retries lazily on next call).
- ACINQ's minimum channel size and whether either peer accepts private channels from a Tor-only node.
- Exact REST JSON shapes (`funding_txid_bytes` vs `funding_txid_str`, `utxos[].amount_sat`) were checked against v0.21.6 `lightning.proto`/`lightning.yaml`, but not against a live node.
