'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
// First-run wallet setup and on-chain funding / channel-open for the app's own LND.
// The seed only ever lives in memory between /seed and /init, and is never logged or written.
const PEERS = [
  { id: 'acinq', name: 'ACINQ', uri: '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f@3.33.236.230:9735', minSats: 1000000, minVerified: false,
    note: 'Source: 1ml.com / lightningnetwork.plus (checked 2026-11-04). Minimum not published by ACINQ; research reports they refuse channels under 1,000,000 sats (unverified).' },
  { id: 'kraken', name: 'Kraken', uri: '02437c00ef5de2686a6bd60f8acb5c83d17010916010a15f479d5ef84c04f04485@67.208.234.136:9735', minSats: 1000000, minVerified: true,
    note: 'Source: support.kraken.com (updated 2026-08-19). Kraken requires at least 1,000,000 sats.' },
];
const READY = ['RPC_ACTIVE', 'SERVER_ACTIVE'];
const LND_MIN = 20000, ANCHOR_RESERVE = 10000, MIN_CONFS = 3, RECOVERY_WINDOW = 2500;
const FEE_TARGETS = [['slow', 'Slow', 144], ['normal', 'Normal', 6], ['fast', 'Fast', 2]];
// Funding tx size estimate (vbytes): overhead 11 + P2WPKH/P2TR input ~68 each + P2WSH funding output 43 + change ~31.
const txVbytes = (inputs, change = true) => 11 + 68 * Math.max(1, inputs) + 43 + (change ? 31 : 0);
// Fewest 3-conf UTXOs (largest first) covering amount + fee + reserve. Returns { inputs, fee } or null.
function planInputs(utxos, sats, rate) {
  const sorted = [...utxos].sort((a, b) => b - a); let sum = 0;
  for (let i = 0; i < sorted.length; i++) { sum += sorted[i]; const fee = Math.ceil(txVbytes(i + 1) * rate); if (sum >= sats + fee + ANCHOR_RESERVE) return { inputs: i + 1, fee }; }
  return null;
}
function maxFundable(utxos, rate) {
  const total = utxos.reduce((a, b) => a + b, 0);
  return Math.max(0, total - ANCHOR_RESERVE - Math.ceil(txVbytes(utxos.length, true) * rate));
}
function checkRate(r) {
  r = Number(r);
  if (!Number.isInteger(r) || r < 1 || r > 500) throw new Error('Fee rate must be a whole number of sat/vB between 1 and 500');
  return r;
}

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
  return { lndDir, chainDir, scb: path.join(chainDir, 'channel.backup'), scbDir: path.join(lndDir, 'channel-backup') };
}
const scrub = (msg, words) => words.reduce((m, w) => m.split(w).join('…'), String(msg));

function parseUri(uri) {
  const m = String(uri || '').trim().match(/^(0[23][0-9a-f]{64})@([a-z0-9.\-]+|\[[0-9a-f:]+\]):(\d{1,5})$/i);
  if (!m || Number(m[3]) < 1 || Number(m[3]) > 65535) throw new Error('Peer must look like pubkey@host:port (IP, DNS name or .onion)');
  return { pubkey: m[1].toLowerCase(), host: `${m[2]}:${m[3]}` };
}

function createWallet({ lnd, cfg, history }) {
  let pending = null; // { id, words, check, created }
  const plans = new Map();
  const wipe = () => { if (pending) pending.words.fill(''); pending = null; };
  const P = walletPaths(cfg);
  let lastDownload = null;

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
    const state = await lnd.state();
    const out = { state, ready: READY.includes(state), dryRun: cfg.dryRun, unlockFile: fs.existsSync(cfg.walletPasswordPath), backup: { ...scbInfo(), lastDownload } };
    if (!out.ready) return out;
    const [wb, cb, utxos, pend, ch] = await Promise.all([lnd.walletBalance(), lnd.channelBalance(), lnd.listUnspent(MIN_CONFS), lnd.pendingChannels(), lnd.listChannels()]);
    out.onchain = { confirmed: Number(wb.confirmed_balance || 0), unconfirmed: Number(wb.unconfirmed_balance || 0),
      spendable3: (utxos.utxos || []).reduce((a, u) => a + Number(u.amount_sat || 0), 0), utxos3: (utxos.utxos || []).map(u => Number(u.amount_sat || 0)).filter(x => x > 0) };
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
        const state = await lnd.state();
        if (state !== 'NON_EXISTING') throw new Error(state === 'UNREACHABLE' ? 'Wallet node is still starting, try again in a minute' : 'A wallet already exists');
        wipe();
        pwText = await writePassword();
        await lnd.restoreWallet(pwText, words, pass, RECOVERY_WINDOW);
      } catch (e) { throw new Error(scrub(e.message, words)); }
      finally { words.fill(''); if (pwText) pwText.fill(0); if (Array.isArray(b.words)) b.words.fill(''); b.words = null; b.passphrase = null; }
      history.add({ kind: 'wallet', status: 'restored' });
      return { ok: true, recoveryWindow: RECOVERY_WINDOW };
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
    // Fee presets from LND's estimator (sat/kw -> sat/vB). Null when LND can't estimate (user types a custom rate).
    async fees() {
      const presets = await Promise.all(FEE_TARGETS.map(async ([id, label, conf]) => {
        try { const r = await lnd.estimateFee(conf); const kw = Number(r.sat_per_kw || 0); return { id, label, conf, satPerVbyte: kw > 0 ? Math.max(1, Math.ceil(kw * 4 / 1000)) : null }; }
        catch { return { id, label, conf, satPerVbyte: null }; }
      }));
      const s = await status();
      return { presets, reserve: ANCHOR_RESERVE, minSats: LND_MIN, minConfs: MIN_CONFS, spendable: s.ready ? s.onchain.spendable3 : 0, utxos: s.ready ? s.onchain.utxos3.length : 0 };
    },
    async max(b) {
      const rate = checkRate(b.feeRate);
      const s = await status(); if (!s.ready) throw new Error('Wallet not ready');
      const max = maxFundable(s.onchain.utxos3, rate);
      return { max, spendable: s.onchain.spendable3, reserve: ANCHOR_RESERVE, estFeeSats: Math.ceil(txVbytes(s.onchain.utxos3.length) * rate), feeRate: rate };
    },
    async preview(b) {
      const { pubkey, host } = parseUri(b.peer);
      const sats = Math.floor(Number(b.sats));
      if (!(sats >= LND_MIN)) throw new Error(`Minimum channel is ${LND_MIN.toLocaleString()} sats`);
      const rate = checkRate(b.feeRate);
      const s = await status();
      if (!s.ready) throw new Error('Wallet not ready');
      const spendable = s.onchain.spendable3;
      if (sats > spendable) throw new Error(`Amount is more than your ${spendable.toLocaleString()} sats with ${MIN_CONFS}+ confirmations`);
      const pick = planInputs(s.onchain.utxos3, sats, rate);
      if (!pick) { const max = maxFundable(s.onchain.utxos3, rate); throw new Error(`Need amount + on-chain fee + ${ANCHOR_RESERVE.toLocaleString()} sat reserve with ${MIN_CONFS}+ confirmations. Max at ${rate} sat/vB is ${max.toLocaleString()} sats`); }
      const preset = PEERS.find(p => p.uri.startsWith(pubkey + '@'));
      const warnings = [];
      if (preset?.minSats && sats < preset.minSats) warnings.push(preset.minVerified
        ? `${preset.name} needs at least ${preset.minSats.toLocaleString()} sats; it will likely reject this.`
        : `${preset.name} reportedly refuses channels under ${preset.minSats.toLocaleString()} sats (unverified); it will likely reject this.`);
      if (!preset) warnings.push('Custom peer: its minimum channel size is unknown (unverified). It may reject the channel.');
      else if (!preset.minVerified && !(preset.minSats && sats < preset.minSats)) warnings.push(`${preset.name}'s minimum channel size is unverified.`);
      const isPrivate = b.private !== false;
      if (!isPrivate) warnings.push('Public channel: it will be announced on the network graph.');
      if (rate === 1) warnings.push('1 sat/vB may take a long time to confirm.');
      const plan = { id: crypto.randomBytes(8).toString('hex'), created: Date.now(), pubkey, host, sats, isPrivate, feeRate: rate, estFeeSats: pick.fee, inputs: pick.inputs,
        peerName: preset?.name || 'Custom peer', remainingSats: spendable - sats - pick.fee, reserve: ANCHOR_RESERVE, minConfs: MIN_CONFS };
      plans.set(plan.id, plan);
      return { ...plan, warnings, dryRun: cfg.dryRun };
    },
    async open(b) {
      if (b.confirm !== true) throw new Error('Confirmation required');
      const plan = plans.get(b.planId);
      if (!plan || Date.now() - plan.created > 10 * 60e3) throw new Error('Preview expired, preview again');
      plans.delete(plan.id);
      let status = 'dry-run', txid, pending = null;
      if (!cfg.dryRun) {
        const peers = await lnd.listPeers().catch(() => ({ peers: [] }));
        if (!(peers.peers || []).some(p => p.pub_key === plan.pubkey)) {
          try { await lnd.connectPeer(plan.pubkey, plan.host); } catch (e) { if (!/already connected/i.test(e.message)) throw new Error('Could not connect to peer: ' + e.message); }
        }
        const r = await lnd.openChannel(plan);
        txid = r.funding_txid_str || (r.funding_txid_bytes ? Buffer.from(r.funding_txid_bytes, 'base64').reverse().toString('hex') : undefined);
        status = 'opening';
        try { const pc = await lnd.pendingChannels(); const m = (pc.pending_open_channels || []).find(x => x.channel?.remote_node_pub === plan.pubkey);
          pending = m ? { capacity: Number(m.channel.capacity || 0), channelPoint: m.channel.channel_point || null, confirmationsNeeded: m.confirmations_until_active ?? null } : null; } catch {}
      }
      const entry = history.add({ kind: 'channel', dryRun: cfg.dryRun, peer: plan.peerName, sats: plan.sats, private: plan.isPrivate, feeRate: plan.feeRate, status, txid });
      return { ...entry, pending, backupReminder: !cfg.dryRun };
    },
  };
}
module.exports = { createWallet, parseUri, cleanWords, walletPaths, planInputs, maxFundable, txVbytes, PEERS, READY, ANCHOR_RESERVE };
