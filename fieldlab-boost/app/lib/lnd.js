'use strict';
const fs = require('fs');
const { getJson, request } = require('./http');

// Permissions for the app's own baked macaroon: payments, invoices, deposit addresses,
// balances, and peer/channel open. No macaroon/signer/walletkit admin rights.
const BAKE_PERMISSIONS = [
  ['info', 'read'], ['offchain', 'read'], ['offchain', 'write'], ['invoices', 'read'], ['invoices', 'write'],
  ['onchain', 'read'], ['onchain', 'write'], ['address', 'read'], ['address', 'write'], ['peers', 'read'], ['peers', 'write'],
].map(([entity, action]) => ({ entity, action }));

const redact = m => String(m).replace(/[0-9a-f]{40,}/gi, '[redacted]');

// Thin LND REST client. Macaroons are only ever placed in request headers.
function createLnd({ rest, certPath, macaroonPath, adminMacaroonPath }) {
  let ca, macHex, baking;
  const loadCa = () => { if (!ca && certPath && fs.existsSync(certPath)) ca = fs.readFileSync(certPath); return ca; };
  function ensureMacaroon() {
    if (macHex) return Promise.resolve(macHex);
    return baking || (baking = loadOrBake().finally(() => { baking = null; }));
  }
  async function loadOrBake() {
    if (macaroonPath && fs.existsSync(macaroonPath)) return (macHex = fs.readFileSync(macaroonPath).toString('hex'));
    if (!adminMacaroonPath || !fs.existsSync(adminMacaroonPath)) throw new Error('LND: no macaroon yet (wallet not set up or still starting)');
    const admin = fs.readFileSync(adminMacaroonPath).toString('hex');
    let r;
    try { r = await getJson(rest + '/v1/macaroon', { method: 'POST', body: { permissions: BAKE_PERMISSIONS }, ca: loadCa(), headers: { 'Grpc-Metadata-macaroon': admin } }); }
    catch (e) { throw new Error('LND: could not bake app macaroon: ' + redact(e.message)); }
    fs.writeFileSync(macaroonPath, Buffer.from(r.macaroon, 'hex'), { mode: 0o600 });
    return (macHex = r.macaroon);
  }
  async function call(method, path, body, { auth = true } = {}) {
    const headers = auth ? { 'Grpc-Metadata-macaroon': await ensureMacaroon() } : {};
    try { return await getJson(rest + path, { method, body, ca: loadCa(), headers }); }
    catch (e) { throw new Error('LND: ' + redact(e.message)); }
  }
  // Router v2 send (the v1 SendPaymentSync endpoint is gone in newer LND). Response is NDJSON.
  async function sendRouter(body) {
    const req = { ...body, timeout_seconds: 60, no_inflight_updates: true };
    if (req.fee_limit?.fixed) req.fee_limit_sat = req.fee_limit.fixed;
    delete req.fee_limit;
    if (req.dest) req.final_cltv_delta = 80;
    const headers = { 'Grpc-Metadata-macaroon': await ensureMacaroon() };
    let r;
    try { r = await request(rest + '/v2/router/send', { method: 'POST', body: req, ca: loadCa(), headers, timeout: 90000 }); }
    catch (e) { throw new Error('LND: ' + redact(e.message)); }
    let last;
    for (const line of r.text.split('\n')) { try { const o = JSON.parse(line); if (o && typeof o === 'object') last = o; } catch {} }
    if (!last) throw new Error(`LND: Non-JSON response (${r.status}) from router`);
    if (last.error) throw new Error('LND: ' + redact(last.error.message || JSON.stringify(last.error)));
    const p = last.result || last;
    if (p.status !== 'SUCCEEDED') return { payment_error: String(p.failure_reason || p.status || 'FAILED').replace(/^FAILURE_REASON_/, '') };
    return { payment_error: '', payment_route: { total_fees: p.fee_sat || '0' } };
  }
  return {
    // Wallet lifecycle (WalletUnlocker / State services need no macaroon)
    state: async () => { try { return (await call('GET', '/v1/state', null, { auth: false })).state || 'UNKNOWN'; } catch { return 'UNREACHABLE'; } },
    genSeed: () => call('GET', '/v1/genseed', null, { auth: false }),
    initWallet: (passwordBuf, mnemonic) => call('POST', '/v1/initwallet', { wallet_password: passwordBuf.toString('base64'), cipher_seed_mnemonic: mnemonic }, { auth: false }),
    // Restore: same initwallet call with the user's words. Caller must not log the body.
    restoreWallet: (passwordBuf, mnemonic, passphrase, recoveryWindow) => call('POST', '/v1/initwallet', { wallet_password: passwordBuf.toString('base64'), cipher_seed_mnemonic: mnemonic,
      ...(passphrase ? { aezeed_passphrase: Buffer.from(passphrase).toString('base64') } : {}), recovery_window: recoveryWindow }, { auth: false }),
    ensureMacaroon,
    recoveryInfo: () => call('GET', '/v1/getrecoveryinfo'),
    exportBackup: () => call('GET', '/v1/channels/backup'),
    restoreBackup: multiB64 => call('POST', '/v1/channels/backup/restore', { multi_chan_backup: multiB64 }),
    getInfo: () => call('GET', '/v1/getinfo'),
    channelBalance: () => call('GET', '/v1/balance/channels'),
    walletBalance: () => call('GET', '/v1/balance/blockchain'),
    listUnspent: minConfs => call('GET', `/v1/utxos?min_confs=${minConfs}&max_confs=2147483647`),
    newAddress: () => call('GET', '/v1/newaddress?type=WITNESS_PUBKEY_HASH'),
    // Small windows only: on-chain txs from a start height (-1 = include unconfirmed), newest invoices first.
    listTransactions: startHeight => call('GET', `/v1/transactions?start_height=${Math.max(0, startHeight | 0)}&end_height=-1`),
    listInvoices: max => call('GET', `/v1/invoices?reversed=true&num_max_invoices=${max | 0}`),
    listChannels: () => call('GET', '/v1/channels'),
    pendingChannels: () => call('GET', '/v1/channels/pending'),
    connectPeer: (pubkey, host) => call('POST', '/v1/peers', { addr: { pubkey, host }, perm: false, timeout: '60' }),
    listPeers: () => call('GET', '/v1/peers'),
    // WalletKit fee estimate for a confirmation target; returns { sat_per_kw }.
    estimateFee: conf => call('GET', `/v2/wallet/estimatefee/${conf | 0}`),
    openChannel: ({ pubkey, sats, isPrivate, feeRate }) => call('POST', '/v1/channels', {
      node_pubkey: Buffer.from(pubkey, 'hex').toString('base64'), node_pubkey_string: pubkey, local_funding_amount: String(sats), private: !!isPrivate,
      sat_per_vbyte: String(feeRate), min_confs: 3, spend_unconfirmed: false }),
    decodePayReq: pr => call('GET', '/v1/payreq/' + encodeURIComponent(pr)),
    addInvoice: (value, memo) => call('POST', '/v1/invoices', { value: String(value), memo }),
    lookupInvoice: hashHex => call('GET', '/v1/invoice/' + hashHex),
    sendPayment: sendRouter,
  };
}
module.exports = { createLnd, BAKE_PERMISSIONS };
