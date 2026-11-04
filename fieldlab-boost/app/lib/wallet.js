'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
// First-run wallet setup and on-chain funding / channel-open for the app's own LND.
// The seed only ever lives in memory between /seed and /init, and is never logged or written.
const PEERS = [
  { id: 'acinq', name: 'ACINQ', uri: '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f@3.33.236.230:9735', minSats: null,
    note: 'Source: 1ml.com / lightningnetwork.plus (checked 2026-11-04). Minimum channel size not published.' },
  { id: 'kraken', name: 'Kraken', uri: '02437c00ef5de2686a6bd60f8acb5c83d17010916010a15f479d5ef84c04f04485@67.208.234.136:9735', minSats: 1000000,
    note: 'Source: support.kraken.com (updated 2026-08-19). Kraken requires at least 1,000,000 sats.' },
];
const READY = ['RPC_ACTIVE', 'SERVER_ACTIVE'];
const LND_MIN = 20000, FEE_BUFFER = 5000, MIN_CONFS = 3, RECOVERY_WINDOW = 2500;
const RESET_PHRASE = 'RESET WALLET';

// 24 aezeed words: lowercase a-z only. Never echo the input back in errors.
function cleanWords(input) {
  const words = (Array.isArray(input) ? input : String(input || '').split(/\s+/)).map(w => String(w).trim().toLowerCase()).filter(Boolean);
  if (words.length !== 24) throw new Error(`Enter exactly 24 words (got ${words.length})`);
  const bad = words.findIndex(w => !/^[a-z]{3,8}$/.test(w));
  if (bad >= 0) throw new Error(`Word #${bad + 1} doesn't look like a seed word`);
  return words;
}

// Wallet files live in the lnd container's dir (mounted here at dirname(walletPasswordPath)).
function walletPaths(cfg) {
  const lndDir = path.dirname(cfg.walletPasswordPath), chainDir = path.dirname(cfg.lnd.adminMacaroonPath);
  return { lndDir, chainDir, marker: path.join(lndDir, 'RESET_PENDING'), scb: path.join(chainDir, 'channel.backup'), scbDir: path.join(lndDir, 'channel-backup') };
}
const scrub = (msg, words) => words.reduce((m, w) => m.split(w).join('…'), String(msg));

function parseUri(uri) {
  const m = String(uri || '').trim().match(/^(0[23][0-9a-f]{64})@([a-z0-9.\-]+|\[[0-9a-f:]+\]):(\d{1,5})$/i);
  if (!m) throw new Error('Peer must look like pubkey@host:port');
  return { pubkey: m[1].toLowerCase(), host: `${m[2]}:${m[3]}` };
}

function createWallet({ lnd, cfg, history }) {
  let pending = null; // { id, words, check, created }
  const plans = new Map();
  const wipe = () => { if (pending) pending.words.fill(''); pending = null; };
  const P = walletPaths(cfg);
  let lastDownload = null;
  const resetPending = () => fs.existsSync(P.marker);

  // Surface LND's own channel.backup and keep a copy in data/lnd/channel-backup/ when it changes.
  function scbInfo() {
    if (!fs.existsSync(P.scb)) return { exists: false };
    const st = fs.statSync(P.scb), copy = path.join(P.scbDir, 'channel-latest.backup');
    try {
      if (!fs.existsSync(copy) || fs.statSync(copy).mtimeMs < st.mtimeMs) { fs.mkdirSync(P.scbDir, { recursive: true, mode: 0o700 }); fs.copyFileSync(P.scb, copy); fs.chmodSync(copy, 0o600); }
    } catch {}
    return { exists: true, modified: st.mtime.toISOString(), bytes: st.size, copy: fs.existsSync(copy) };
  }

  async function writePassword() {
    const pw = crypto.randomBytes(32);
    const pwText = Buffer.from(pw.toString('hex')); pw.fill(0);
    fs.writeFileSync(cfg.walletPasswordPath, pwText, { mode: 0o600 }); fs.chmodSync(cfg.walletPasswordPath, 0o600);
    return pwText;
  }

  async function status() {
    if (resetPending()) return { state: 'RESET_PENDING', ready: false, resetPending: true, dryRun: cfg.dryRun };
    const state = await lnd.state();
    const out = { state, ready: READY.includes(state), dryRun: cfg.dryRun, unlockFile: fs.existsSync(cfg.walletPasswordPath), backup: { ...scbInfo(), lastDownload } };
    if (!out.ready) return out;
    const [wb, cb, utxos, pend, ch] = await Promise.all([lnd.walletBalance(), lnd.channelBalance(), lnd.listUnspent(MIN_CONFS), lnd.pendingChannels(), lnd.listChannels()]);
    out.onchain = { confirmed: Number(wb.confirmed_balance || 0), unconfirmed: Number(wb.unconfirmed_balance || 0),
      spendable3: (utxos.utxos || []).reduce((a, u) => a + Number(u.amount_sat || 0), 0) };
    out.lightning = { local: Number(cb.local_balance?.sat ?? cb.balance ?? 0), remote: Number(cb.remote_balance?.sat ?? 0) };
    out.channels = (ch.channels || []).length; out.pendingOpen = (pend.pending_open_channels || []).length;
    out.pendingAny = pendingCount(pend);
    try { const i = await lnd.getInfo(); out.sync = { synced: !!i.synced_to_chain, height: Number(i.block_height || 0) }; } catch {}
    try { const r = await lnd.recoveryInfo(); out.recovery = { active: !!r.recovery_mode, finished: !!r.recovery_finished, progress: Number(r.progress || 0) }; } catch {}
    return out;
  }

  const pendingCount = p => ['pending_open_channels', 'pending_closing_channels', 'pending_force_closing_channels', 'waiting_close_channels'].reduce((a, k) => a + (p[k] || []).length, 0);

  return {
    PEERS, status, scbInfo,
    async restore(b) {
      let words = [], pwText;
      try {
        words = cleanWords(b.words);
        const pass = String(b.passphrase || '');
        if (resetPending()) throw new Error('Reset pending: restart the app in Umbrel first');
        const state = await lnd.state();
        if (state !== 'NON_EXISTING') throw new Error(state === 'UNREACHABLE' ? 'Wallet node is still starting, try again in a minute' : 'A wallet already exists. Reset it first.');
        wipe();
        pwText = await writePassword();
        await lnd.restoreWallet(pwText, words, pass, RECOVERY_WINDOW);
      } catch (e) { throw new Error(scrub(e.message, words)); }
      finally { words.fill(''); if (pwText) pwText.fill(0); if (Array.isArray(b.words)) b.words.fill(''); b.words = null; b.passphrase = null; }
      history.add({ kind: 'wallet', status: 'restored' });
      return { ok: true, recoveryWindow: RECOVERY_WINDOW };
    },
    // Reset never deletes while LND runs: it writes RESET_PENDING; the lnd entrypoint wipes on next start.
    async reset(b) {
      if (String(b.phrase || '') !== RESET_PHRASE) throw new Error(`Type ${RESET_PHRASE} exactly`);
      const override = b.override === true;
      const state = await lnd.state(), reasons = [];
      if (READY.includes(state)) {
        const [wb, cb, ch, pend] = await Promise.all([lnd.walletBalance(), lnd.channelBalance(), lnd.listChannels(), lnd.pendingChannels()]);
        const n = (ch.channels || []).length, pn = pendingCount(pend);
        const onchain = Number(wb.total_balance ?? (Number(wb.confirmed_balance || 0) + Number(wb.unconfirmed_balance || 0)));
        const ln = Number(cb.local_balance?.sat ?? cb.balance ?? 0) + Number(cb.pending_open_local_balance?.sat ?? 0);
        if (n || pn) throw new Error(`Refused: ${n} open and ${pn} pending channel(s). Close them first; reset would lose those funds without the channel backup.`);
        if (onchain > 0) reasons.push(`${onchain.toLocaleString()} sats on-chain`);
        if (ln > 0) reasons.push(`${ln.toLocaleString()} sats in Lightning`);
      } else if (state !== 'NON_EXISTING') reasons.push(`wallet is ${state.toLowerCase()} so balances can't be checked`);
      if (reasons.length && !override) throw new Error(`Refused: ${reasons.join(', ')}. Tick "I understand this wallet has funds" to reset anyway.`);
      fs.writeFileSync(P.marker, new Date().toISOString() + '\n', { mode: 0o600 });
      try { fs.rmSync(cfg.lnd.macaroonPath, { force: true }); } catch {}
      lnd.forgetMacaroon(); wipe();
      history.add({ kind: 'wallet', status: 'reset-pending', override: !!reasons.length });
      return { ok: true, restartRequired: true };
    },
    async backupDownload() {
      const r = await lnd.exportBackup();
      const b64 = r.multi_chan_backup?.multi_chan_backup;
      if (!b64) throw new Error('LND returned no channel backup');
      lastDownload = new Date().toISOString();
      return { data: Buffer.from(b64, 'base64'), name: `dirty-boost-channels-${lastDownload.slice(0, 10)}.backup`, channels: (r.multi_chan_backup.chan_points || []).length };
    },
    async backupRestore(b) {
      if (b.confirm !== true) throw new Error('Confirmation required');
      const data = Buffer.from(String(b.backup || ''), 'base64');
      if (data.length < 16) throw new Error('That does not look like a channel backup file');
      if (!READY.includes(await lnd.state())) throw new Error('Wallet not ready');
      await lnd.restoreBackup(data.toString('base64'));
      history.add({ kind: 'wallet', status: 'channel-backup-restored' });
      return { ok: true };
    },
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
module.exports = { createWallet, parseUri, cleanWords, walletPaths, PEERS, READY, RESET_PHRASE };
