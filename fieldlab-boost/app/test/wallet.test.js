'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const mock = require('./mock-servers');
const { createApp, config } = require('../server');
const { parseUri } = require('../lib/wallet');

async function boot({ dryRun = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boostw-'));
  fs.mkdirSync(path.join(dir, 'lnd'));
  const adminMacPath = path.join(dir, 'lnd', 'admin.macaroon');
  const m = await mock.start(0, { walletState: 'NON_EXISTING', adminMacPath });
  const logs = []; const origErr = console.error, origLog = console.log;
  console.error = (...a) => logs.push(a.join(' ')); console.log = (...a) => logs.push(a.join(' '));
  const cfg = config({ DATA_DIR: dir, DRY_RUN: String(dryRun), LND_REST: `http://127.0.0.1:${m.port}`, MACAROON_PATH: path.join(dir, 'boost-node.macaroon'),
    ADMIN_MACAROON_PATH: adminMacPath, WALLET_PASSWORD_FILE: path.join(dir, 'lnd', 'wallet-password'), TLS_CERT_PATH: '/nonexistent', ALLOW_HTTP_LOCAL: 'true' });
  const app = createApp(cfg); await new Promise(r => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}/api/`;
  const api = async (p, body) => { const r = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); return { ok: r.ok, ...(await r.json()) }; };
  return { m, api, dir, logs, base, close: () => { console.error = origErr; console.log = origLog; app.closeAllConnections(); app.close(); m.srv.closeAllConnections(); m.close(); } };
}

test('uninitialised wallet: summary is calm, setup flow, macaroon baked, seed never persisted', async () => {
  const t = await boot();
  try {
    const s = await t.api('summary'); assert.equal(s.ok, true); assert.equal(s.ready, false); assert.equal(s.state, 'NON_EXISTING');
    const w0 = await t.api('wallet'); assert.equal(w0.ready, false);
    const seed = await t.api('wallet/seed', {}); assert.equal(seed.words.length, 24);
    const word = seed.words[seed.checkIndex - 1];
    assert.equal((await t.api('wallet/init', { setupId: seed.setupId, checkWord: word })).ok, false, 'needs confirm');
    assert.equal((await t.api('wallet/init', { setupId: seed.setupId, confirm: true, checkWord: 'wrong' })).ok, false, 'needs right word');
    const ok = await t.api('wallet/init', { setupId: seed.setupId, confirm: true, checkWord: word.toUpperCase() }); assert.equal(ok.ok, true, JSON.stringify(ok));
    const pwFile = path.join(t.dir, 'lnd', 'wallet-password');
    assert.equal(fs.statSync(pwFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(pwFile, 'utf8'), t.m.st.initPassword); assert.match(t.m.st.initPassword, /^[0-9a-f]{64}$/);
    assert.equal(t.m.st.initWords, seed.words.join(' '));
    assert.equal((await t.api('wallet/init', { setupId: seed.setupId, confirm: true, checkWord: word })).ok, false, 'one-shot');
    assert.equal((await t.api('wallet/seed', {})).ok, false, 'no second seed');
    const w = await t.api('wallet'); assert.equal(w.ready, true, JSON.stringify(w)); assert.equal(w.onchain.spendable3, 700000); assert.equal(w.onchain.unconfirmed, 20000);
    assert.equal(t.m.st.baked.length, 1); const perms = t.m.st.baked[0].map(p => p.entity + ':' + p.action);
    assert.ok(perms.includes('offchain:write') && !perms.some(p => p.startsWith('macaroon') || p.startsWith('signer')));
    assert.equal(fs.statSync(path.join(t.dir, 'boost-node.macaroon')).mode & 0o777, 0o600);
    const a = await t.api('wallet/address', {}); assert.match(a.uri, /^bitcoin:bc1q/);
    // seed never written to disk or logs
    const all = fs.readdirSync(t.dir, { recursive: true }).filter(f => fs.statSync(path.join(t.dir, f)).isFile()).map(f => fs.readFileSync(path.join(t.dir, f), 'latin1')).join('\n') + t.logs.join('\n');
    for (const wd of ['abandon ability', 'acoustic', t.m.st.initPassword]) assert.ok(!t.logs.join('\n').includes(wd));
    assert.ok(!all.includes('acoustic')); assert.ok(!all.includes('acquire across'));
    const sum = await t.api('summary'); assert.equal(sum.ready, true); assert.equal(sum.alias, 'NodeMaster-mock');
  } finally { t.close(); }
});

for (const dryRun of [true, false]) test(`channel open DRY_RUN=${dryRun}`, async () => {
  const t = await boot({ dryRun });
  try {
    const seed = await t.api('wallet/seed', {});
    await t.api('wallet/init', { setupId: seed.setupId, confirm: true, checkWord: seed.words[seed.checkIndex - 1] });
    const { peers, defaultSats } = await t.api('channel/peers'); assert.equal(defaultSats, 500000);
    const fees = await t.api('channel/fees');
    assert.deepEqual(fees.presets.map(p => [p.id, p.conf, p.satPerVbyte]), [['slow', 144, 1], ['normal', 6, 5], ['fast', 2, 20]]);
    assert.equal(fees.spendable, 700000); assert.equal(fees.reserve, 10000);
    const mx = await t.api('channel/max', { feeRate: 5 }); assert.equal(mx.max, 700000 - 10000 - Math.ceil((11 + 68 + 43 + 31) * 5));
    assert.equal((await t.api('channel/max', { feeRate: 0 })).ok, false);
    const kraken = peers.find(p => p.id === 'kraken'), acinq = peers.find(p => p.id === 'acinq');
    const kp = await t.api('channel/preview', { peer: kraken.uri, sats: 500000, feeRate: 5 }); assert.match(kp.warnings.join(' '), /needs at least 1,000,000/); assert.equal(kp.isPrivate, true);
    const ap = await t.api('channel/preview', { peer: acinq.uri, sats: 500000, feeRate: 5 }); assert.match(ap.warnings.join(' '), /reportedly refuses.*1,000,000.*unverified/);
    assert.match((await t.api('channel/preview', { peer: kraken.uri, sats: 1000000, feeRate: 5 })).error, /more than your 700,000/);
    assert.match((await t.api('channel/preview', { peer: kraken.uri, sats: 695000, feeRate: 5 })).error, /Max at 5 sat\/vB is 689,235/);
    assert.equal((await t.api('channel/preview', { peer: 'nonsense', sats: 500000, feeRate: 5 })).ok, false);
    assert.match((await t.api('channel/preview', { peer: kraken.uri, sats: 19999, feeRate: 5 })).error, /Minimum channel is 20,000/);
    assert.match((await t.api('channel/preview', { peer: kraken.uri, sats: 500000 })).error, /Fee rate/);
    const onion = '03' + 'ef'.repeat(32) + '@' + 'a'.repeat(56) + '.onion:9735';
    const op = await t.api('channel/preview', { peer: onion, sats: 50000, feeRate: 2, private: false });
    assert.equal(op.peerName, 'Custom peer'); assert.match(op.warnings.join(' '), /unknown \(unverified\)/); assert.match(op.warnings.join(' '), /Public channel/);
    const pv = await t.api('channel/preview', { peer: kraken.uri, sats: 1000000 - 400000, feeRate: 7 });
    assert.equal(pv.estFeeSats, Math.ceil(153 * 7)); assert.equal(pv.remainingSats, 700000 - 600000 - pv.estFeeSats);
    assert.equal((await t.api('channel/open', { planId: pv.id })).ok, false, 'needs confirm');
    const r = await t.api('channel/open', { planId: pv.id, confirm: true });
    assert.equal(r.status, dryRun ? 'dry-run' : 'opening');
    assert.equal(t.m.st.opened.length, dryRun ? 0 : 1); assert.equal(t.m.st.peers.length, dryRun ? 0 : 1);
    if (!dryRun) { const o = t.m.st.opened[0]; assert.equal(o.private, true); assert.equal(o.min_confs, 3); assert.equal(o.spend_unconfirmed, false); assert.equal(o.local_funding_amount, '600000');
      assert.equal(o.sat_per_vbyte, '7'); assert.equal(o.node_pubkey_string, kraken.uri.split('@')[0]);
      assert.equal(Buffer.from(o.node_pubkey, 'base64').toString('hex'), kraken.uri.split('@')[0]); assert.equal(r.txid, '22' + '11'.repeat(31));
      assert.equal(r.pending.capacity, 600000); assert.equal(r.pending.confirmationsNeeded, 3); assert.equal(r.backupReminder, true);
      // second open to same peer: already connected per /v1/peers, no new connect
      const p2 = await t.api('channel/preview', { peer: kraken.uri, sats: 30000, feeRate: 7 }); await t.api('channel/open', { planId: p2.id, confirm: true });
      assert.equal(t.m.st.peers.length, 1); assert.equal(t.m.st.opened.length, 2);
    } else assert.equal(r.pending, null);
    assert.equal((await t.api('channel/open', { planId: pv.id, confirm: true })).ok, false, 'no replay');
  } finally { t.close(); }
});

test('fee presets null when LND cannot estimate; custom rate still works', async () => {
  const t = await boot();
  try {
    await t.api('wallet/restore', { words: SEED }); t.m.st.noFees = true;
    const f = await t.api('channel/fees'); assert.ok(f.presets.every(p => p.satPerVbyte === null));
    assert.equal((await t.api('channel/preview', { peer: '03' + 'ab'.repeat(32) + '@1.2.3.4:9735', sats: 100000, feeRate: 3 })).ok, true);
  } finally { t.close(); }
});

test('wallet reset is removed', async () => {
  const t = await boot();
  try {
    await t.api('wallet/restore', { words: SEED });
    const r = await fetch(t.base + 'wallet/reset', { method: 'POST', body: JSON.stringify({ phrase: 'RESET WALLET', override: true }) });
    assert.equal(r.status, 404);
    const w = await t.api('wallet'); assert.equal(w.ready, true); assert.equal(w.resetPending, undefined);
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(!/RESET WALLET|wDanger|btnReset|wallet\/reset/.test(html));
    assert.ok(!fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8').includes('RESET_PENDING'));
  } finally { t.close(); }
});

test('parseUri', () => {
  assert.equal(parseUri('03' + 'a'.repeat(64) + '@' + 'b'.repeat(56) + '.onion:9735').host, 'b'.repeat(56) + '.onion:9735');
  assert.throws(() => parseUri('03' + 'a'.repeat(64) + '@1.2.3.4:70000'));
  assert.deepEqual(parseUri('03' + 'a'.repeat(64) + '@1.2.3.4:9735'), { pubkey: '03' + 'a'.repeat(64), host: '1.2.3.4:9735' });
  assert.throws(() => parseUri('04' + 'a'.repeat(64) + '@x:1'));
});

const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual'.split(' ');
const filesAndLogs = t => fs.readdirSync(t.dir, { recursive: true }).filter(f => fs.statSync(path.join(t.dir, f)).isFile()).map(f => fs.readFileSync(path.join(t.dir, f), 'latin1')).join('\n') + t.logs.join('\n');

test('restore validation (client words checked server-side)', async () => {
  const t = await boot();
  try {
    assert.match((await t.api('wallet/restore', { words: SEED.slice(0, 23) })).error, /exactly 24 words \(got 23\)/);
    const bad = [...SEED]; bad[4] = 'ab0ve';
    const r = await t.api('wallet/restore', { words: bad }); assert.match(r.error, /Word #5/); assert.ok(!r.error.includes('ab0ve'));
    assert.equal(t.m.st.initBody, null, 'LND not called on invalid input');
    assert.ok(!filesAndLogs(t).includes('acoustic'));
  } finally { t.close(); }
});

test('restore calls initwallet with mnemonic, passphrase, recovery_window; nothing persisted', async () => {
  const t = await boot();
  try {
    const messy = '  ' + SEED.map(w => w.toUpperCase()).join('  \n ') + ' ';
    const r = await t.api('wallet/restore', { words: messy, passphrase: 'pp-secret' }); assert.equal(r.ok, true, JSON.stringify(r));
    const b = t.m.st.initBody;
    assert.deepEqual(b.cipher_seed_mnemonic, SEED); assert.equal(b.recovery_window, 2500);
    assert.equal(Buffer.from(b.aezeed_passphrase, 'base64').toString(), 'pp-secret');
    const pwFile = path.join(t.dir, 'lnd', 'wallet-password');
    assert.equal(fs.statSync(pwFile).mode & 0o777, 0o600); assert.equal(fs.readFileSync(pwFile, 'utf8'), t.m.st.initPassword); assert.match(t.m.st.initPassword, /^[0-9a-f]{64}$/);
    assert.notEqual(r.recoveryWindow, undefined); assert.ok(!JSON.stringify(r).includes('abandon'));
    const w = await t.api('wallet'); assert.equal(w.ready, true); assert.equal(w.sync.height, 870000); assert.equal(w.recovery.active, true); assert.equal(w.onchain.confirmed, 700000);
    const all = filesAndLogs(t);
    for (const s of ['acoustic', 'acquire across', 'pp-secret']) assert.ok(!all.includes(s), s); // no file or log holds words/passphrase
    assert.ok(!t.logs.join('\n').includes(t.m.st.initPassword));
    assert.equal(fs.readFileSync(path.join(t.dir, 'history.json'), 'utf8').includes('abandon'), false);
    assert.match((await t.api('wallet/restore', { words: SEED })).error, /already exists/);
  } finally { t.close(); }
});

test('channel backup download + restore upload + channel.backup surfaced', async () => {
  const t = await boot();
  try {
    await t.api('wallet/restore', { words: SEED });
    const r = await fetch(t.base + 'backup/download'); assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="dirty-boost-channels-\d{4}-\d\d-\d\d\.backup"/);
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'SCB-MOCK-' + 'x'.repeat(40));
    const w = await t.api('wallet'); assert.ok(w.backup.lastDownload);
    assert.equal(w.backup.exists, false);
    fs.writeFileSync(path.join(t.dir, 'lnd', 'channel.backup'), 'scbfile');
    const w2 = await t.api('wallet'); assert.equal(w2.backup.exists, true); assert.ok(fs.existsSync(path.join(t.dir, 'lnd', 'channel-backup', 'channel-latest.backup')));
    const b64 = Buffer.from('SCB-UPLOAD-' + 'y'.repeat(30)).toString('base64');
    assert.equal((await t.api('backup/restore', { backup: b64 })).ok, false, 'needs confirm');
    assert.equal((await t.api('backup/restore', { backup: b64, confirm: true })).ok, true); assert.deepEqual(t.m.st.restoredScb, [b64]);
  } finally { t.close(); }
});

test('wallet activity: small pages, pending first, settled invoices only', async () => {
  const t = await boot();
  try {
    assert.equal((await t.api('wallet/activity')).ready, false);
    const seed = await t.api('wallet/seed', {});
    await t.api('wallet/init', { setupId: seed.setupId, confirm: true, checkWord: seed.words[seed.checkIndex - 1] });
    const now = Math.floor(Date.now() / 1000);
    t.m.st.txs = Array.from({ length: 14 }, (_, i) => ({ tx_hash: String(i).padStart(2, '0').repeat(32), amount: String(1000 * (i + 1)), num_confirmations: i + 1, time_stamp: String(now - 600 * (i + 1)) }))
      .concat({ tx_hash: 'ee'.repeat(32), amount: '20000', num_confirmations: 0, time_stamp: String(now) });
    t.m.st.invoices = [{ state: 'SETTLED', amt_paid_sat: '2100', memo: 'boost', settle_date: String(now) }, { state: 'OPEN', value: '5' }];
    const a = await t.api('wallet/activity');
    assert.equal(a.ready, true); assert.equal(a.onchain.length, 10);
    assert.deepEqual(a.onchain[0], { txid: 'ee'.repeat(32), sats: 20000, confs: 0, time: now * 1000 });
    assert.equal(a.onchain[1].confs, 1);
    assert.match(t.m.st.txQuery, /start_height=865968&end_height=-1/);
    assert.match(t.m.st.invQuery, /reversed=true&num_max_invoices=5/);
    assert.deepEqual(a.lightning.map(i => i.sats), [2100]);
    assert.ok(a.checked > 0);
  } finally { t.close(); }
});
