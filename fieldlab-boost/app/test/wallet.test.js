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
  return { m, api, dir, logs, close: () => { console.error = origErr; console.log = origLog; app.closeAllConnections(); app.close(); m.srv.closeAllConnections(); m.close(); } };
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
    const kraken = peers.find(p => p.id === 'kraken');
    const kp = await t.api('channel/preview', { peer: kraken.uri, sats: 500000 }); assert.match(kp.warnings.join(' '), /1,000,000/); assert.equal(kp.isPrivate, true);
    assert.match((await t.api('channel/preview', { peer: kraken.uri, sats: 1000000 })).error, /3\+ confirmations/);
    assert.equal((await t.api('channel/preview', { peer: 'nonsense', sats: 500000 })).ok, false);
    assert.equal((await t.api('channel/preview', { peer: kraken.uri, sats: 1000 })).ok, false);
    const acinq = peers.find(p => p.id === 'acinq');
    const pv = await t.api('channel/preview', { peer: acinq.uri, sats: 500000 }); assert.deepEqual(pv.warnings, []);
    assert.equal((await t.api('channel/open', { planId: pv.id })).ok, false, 'needs confirm');
    const r = await t.api('channel/open', { planId: pv.id, confirm: true });
    assert.equal(r.status, dryRun ? 'dry-run' : 'opening');
    assert.equal(t.m.st.opened.length, dryRun ? 0 : 1);
    if (!dryRun) { const o = t.m.st.opened[0]; assert.equal(o.private, true); assert.equal(o.min_confs, 3); assert.equal(o.spend_unconfirmed, false); assert.equal(o.local_funding_amount, '500000');
      assert.equal(Buffer.from(o.node_pubkey, 'base64').toString('hex'), acinq.uri.split('@')[0]); assert.equal(r.txid, '22' + '11'.repeat(31)); }
    assert.equal((await t.api('channel/open', { planId: pv.id, confirm: true })).ok, false, 'no replay');
  } finally { t.close(); }
});

test('parseUri', () => {
  assert.deepEqual(parseUri('03' + 'a'.repeat(64) + '@1.2.3.4:9735'), { pubkey: '03' + 'a'.repeat(64), host: '1.2.3.4:9735' });
  assert.throws(() => parseUri('04' + 'a'.repeat(64) + '@x:1'));
});
