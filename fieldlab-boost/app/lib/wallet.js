'use strict';
const fs = require('fs'), crypto = require('crypto');
// First-run wallet setup and on-chain funding / channel-open for the app's own LND.
// The seed only ever lives in memory between /seed and /init, and is never logged or written.
const PEERS = [
  { id: 'acinq', name: 'ACINQ', uri: '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f@3.33.236.230:9735', minSats: null,
    note: 'Source: 1ml.com / lightningnetwork.plus (checked 2026-11-04). Minimum channel size not published.' },
  { id: 'kraken', name: 'Kraken', uri: '02437c00ef5de2686a6bd60f8acb5c83d17010916010a15f479d5ef84c04f04485@67.208.234.136:9735', minSats: 1000000,
    note: 'Source: support.kraken.com (updated 2026-08-19). Kraken requires at least 1,000,000 sats.' },
];
const READY = ['RPC_ACTIVE', 'SERVER_ACTIVE'];
const LND_MIN = 20000, FEE_BUFFER = 5000, MIN_CONFS = 3;

function parseUri(uri) {
  const m = String(uri || '').trim().match(/^(0[23][0-9a-f]{64})@([a-z0-9.\-]+|\[[0-9a-f:]+\]):(\d{1,5})$/i);
  if (!m) throw new Error('Peer must look like pubkey@host:port');
  return { pubkey: m[1].toLowerCase(), host: `${m[2]}:${m[3]}` };
}

function createWallet({ lnd, cfg, history }) {
  let pending = null; // { id, words, check, created }
  const plans = new Map();
  const wipe = () => { if (pending) pending.words.fill(''); pending = null; };

  async function status() {
    const state = await lnd.state();
    const out = { state, ready: READY.includes(state), dryRun: cfg.dryRun, unlockFile: fs.existsSync(cfg.walletPasswordPath) };
    if (!out.ready) return out;
    const [wb, cb, utxos, pend, ch] = await Promise.all([lnd.walletBalance(), lnd.channelBalance(), lnd.listUnspent(MIN_CONFS), lnd.pendingChannels(), lnd.listChannels()]);
    out.onchain = { confirmed: Number(wb.confirmed_balance || 0), unconfirmed: Number(wb.unconfirmed_balance || 0),
      spendable3: (utxos.utxos || []).reduce((a, u) => a + Number(u.amount_sat || 0), 0) };
    out.lightning = { local: Number(cb.local_balance?.sat ?? cb.balance ?? 0), remote: Number(cb.remote_balance?.sat ?? 0) };
    out.channels = (ch.channels || []).length; out.pendingOpen = (pend.pending_open_channels || []).length;
    return out;
  }

  return {
    PEERS, status,
    async seed() {
      const state = await lnd.state();
      if (state !== 'NON_EXISTING') throw new Error(state === 'UNREACHABLE' ? 'Wallet node is still starting, try again in a minute' : 'Wallet already exists');
      const g = await lnd.genSeed();
      const words = g.cipher_seed_mnemonic;
      if (!Array.isArray(words) || words.length !== 24) throw new Error('LND returned an unexpected seed');
      wipe();
      pending = { id: crypto.randomBytes(12).toString('hex'), words: [...words], check: crypto.randomInt(0, 24), created: Date.now() };
      return { setupId: pending.id, words: [...words], checkIndex: pending.check + 1 };
    },
    async init(b) {
      if (b.confirm !== true) throw new Error('Tick "I wrote them down" first');
      if (!pending || pending.id !== b.setupId || Date.now() - pending.created > 30 * 60e3) { wipe(); throw new Error('Setup expired, start again'); }
      if (String(b.checkWord || '').trim().toLowerCase() !== pending.words[pending.check]) throw new Error(`Word #${pending.check + 1} doesn't match what you wrote down`);
      if (await lnd.state() !== 'NON_EXISTING') { wipe(); throw new Error('Wallet already exists'); }
      const pw = crypto.randomBytes(32); // hex-encoded below so the file is plain text LND can read
      const pwText = Buffer.from(pw.toString('hex'));
      fs.writeFileSync(cfg.walletPasswordPath, pwText, { mode: 0o600 }); fs.chmodSync(cfg.walletPasswordPath, 0o600);
      try { await lnd.initWallet(pwText, pending.words); }
      finally { wipe(); pw.fill(0); pwText.fill(0); }
      history.add({ kind: 'wallet', status: 'created' });
      return { ok: true };
    },
    async address() {
      const r = await lnd.newAddress();
      return { address: r.address, uri: 'bitcoin:' + r.address };
    },
    async preview(b) {
      const { pubkey, host } = parseUri(b.peer);
      const sats = Math.floor(Number(b.sats));
      if (!(sats >= LND_MIN)) throw new Error(`Minimum channel is ${LND_MIN.toLocaleString()} sats`);
      const preset = PEERS.find(p => p.uri.startsWith(pubkey));
      const warnings = [];
      if (preset?.minSats && sats < preset.minSats) warnings.push(`${preset.name} needs at least ${preset.minSats.toLocaleString()} sats; it will likely reject this.`);
      const isPrivate = b.private !== false;
      if (!isPrivate) warnings.push('Public channel: it will be announced on the network graph.');
      const s = await status();
      if (!s.ready) throw new Error('Wallet not ready');
      if (s.onchain.spendable3 < sats + FEE_BUFFER) throw new Error(`Need ${(sats + FEE_BUFFER).toLocaleString()} sats with ${MIN_CONFS}+ confirmations (incl. fee buffer); you have ${s.onchain.spendable3.toLocaleString()}`);
      const plan = { id: crypto.randomBytes(8).toString('hex'), created: Date.now(), pubkey, host, sats, isPrivate, peerName: preset?.name || 'Custom peer' };
      plans.set(plan.id, plan);
      return { ...plan, warnings, dryRun: cfg.dryRun };
    },
    async open(b) {
      if (b.confirm !== true) throw new Error('Confirmation required');
      const plan = plans.get(b.planId);
      if (!plan || Date.now() - plan.created > 10 * 60e3) throw new Error('Preview expired, preview again');
      plans.delete(plan.id);
      let status = 'dry-run', txid;
      if (!cfg.dryRun) {
        try { await lnd.connectPeer(plan.pubkey, plan.host); } catch (e) { if (!/already connected/i.test(e.message)) throw e; }
        const r = await lnd.openChannel(plan);
        txid = r.funding_txid_str || (r.funding_txid_bytes ? Buffer.from(r.funding_txid_bytes, 'base64').reverse().toString('hex') : undefined);
        status = 'opening';
      }
      return history.add({ kind: 'channel', dryRun: cfg.dryRun, peer: plan.peerName, sats: plan.sats, private: plan.isPrivate, status, txid });
    },
  };
}
module.exports = { createWallet, parseUri, PEERS, READY };
