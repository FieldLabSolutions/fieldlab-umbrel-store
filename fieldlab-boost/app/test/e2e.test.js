'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const mock = require('./mock-servers');
const { createApp, config } = require('../server');

async function boot(dryRun) {
  const m = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boost-'));
  fs.writeFileSync(path.join(dir, 'boost.macaroon'), Buffer.from('deadbeef', 'hex'));
  const cfg = config({ DATA_DIR: dir, DRY_RUN: String(dryRun), LND_REST: `http://127.0.0.1:${m.port}`, MACAROON_PATH: path.join(dir, 'boost.macaroon'), TLS_CERT_PATH: '/nonexistent', ALLOW_HTTP_LOCAL: 'true', MAX_PAYMENT_SATS: '50000' });
  const app = createApp(cfg); await new Promise(r => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}/api/`;
  const api = async (p, body) => { const r = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); const j = await r.json(); return { ok: r.ok, ...j }; };
  return { m, app, api, dir, feed: `http://127.0.0.1:${m.port}/feed.xml`, close: () => { app.closeAllConnections(); app.close(); m.srv.closeAllConnections(); m.close(); } };
}
for (const dryRun of [true, false]) test(`full flow DRY_RUN=${dryRun}`, async () => {
  const t = await boot(dryRun);
  try {
    const s = await t.api('summary'); assert.equal(s.alias, 'NodeMaster-mock'); assert.equal(s.localSats, 150000);
    assert.ok(!JSON.stringify(s).includes('deadbeef'));
    const f = await t.api('feed', { url: t.feed }); assert.equal(f.title, 'Field Lab & Friends'); assert.equal(f.episodes.length, 2);
    assert.deepEqual((await t.api('shows')).shows, []);
    await t.api('shows', { name: f.title, feedUrl: t.feed, artwork: f.image });
    assert.equal((await t.api('shows')).shows[0].feedUrl, t.feed);
    assert.equal((await t.api('shows/remove', { feedUrl: t.feed })).removed, true);
    assert.equal((await t.api('shows', { name: 'x', feedUrl: 'nope' })).ok, false);
    const pv = await t.api('boost/preview', { feedUrl: t.feed, episode: 1, sats: 1000, message: 'Great show' });
    assert.deepEqual(pv.payees.map(p => p.sats), [891, 99, 10]);
    const noConfirm = await t.api('boost/send', { planId: pv.id }); assert.equal(noConfirm.ok, false);
    const sent = await t.api('boost/send', { planId: pv.id, confirm: true });
    assert.deepEqual(sent.results.map(r => r.status), dryRun ? ['dry-run', 'dry-run', 'dry-run'] : ['sent', 'sent', 'sent'], JSON.stringify(sent.results));
    assert.equal(t.m.sent.length, dryRun ? 0 : 3);
    if (!dryRun) { assert.equal(t.m.sent[0].dest_custom_records['696969'], Buffer.from('eChoVKtO1KujpAA5HCoB').toString('base64')); assert.equal(t.m.sent[1].payment_request, 'lnbcmock99n1lnurl');
      const k = t.m.sent[0]; assert.equal(k.final_cltv_delta, 80); assert.equal(k.no_inflight_updates, true); assert.equal(k.timeout_seconds, 60); assert.ok(k.fee_limit_sat); assert.equal(k.fee_limit, undefined); assert.equal(t.m.sent[1].final_cltv_delta, undefined); }
    const replay = await t.api('boost/send', { planId: pv.id, confirm: true }); assert.equal(replay.ok, false);
    const d = await t.api('decode', { invoice: 'lnbcmock2100n1xyz' }); assert.equal(d.sats, 2100); assert.equal(d.expired, false);
    const changed = await t.api('pay', { invoice: 'lnbcmock2100n1xyz', expectSats: 5, confirm: true }); assert.equal(changed.ok, false);
    const p = await t.api('pay', { invoice: 'lnbcmock2100n1xyz', expectSats: 2100, confirm: true }); assert.equal(p.status, dryRun ? 'dry-run' : 'sent'); if (!dryRun) assert.equal(p.feeSats, 1);
    if (!dryRun) {
      const nr = await t.api('pay', { invoice: 'lnbcmock300n1fail', confirm: true }); assert.equal(nr.status, 'failed'); assert.equal(nr.error, 'NO_ROUTE');
      const er = await t.api('pay', { invoice: 'lnbcmock300n1err', confirm: true }); assert.equal(er.ok, false); assert.match(er.error, /^LND: invoice \[redacted\] is bad/);
    }
    const big = await t.api('pay', { invoice: 'lnbcmock999999n1', confirm: true }); assert.match(big.error, /safety limit/);
    const inv = await t.api('invoice', { sats: 500, memo: 'tip' }); assert.match(inv.invoice, /^lnbcmock500/);
    const h = await t.api('history'); assert.deepEqual(h.items.map(i => i.kind), dryRun ? ['invoice', 'payment', 'boost'] : ['invoice', 'payment', 'payment', 'boost']);
    assert.ok(!fs.readFileSync(path.join(t.dir, 'history.json'), 'utf8').includes('deadbeef'));
  } finally { t.close(); }
});
