'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { parseFeed, effectiveValue, computeSplits } = require('../lib/value');
const { buildKeysend, buildBoostRecord } = require('../lib/keysend');
const { lnaddressToUrl, decodeLnurl } = require('../lib/lnurl');
const xml = fs.readFileSync(path.join(__dirname, 'sample-feed.xml'), 'utf8');

test('parses channel metadata and value block', () => {
  const f = parseFeed(xml);
  assert.equal(f.title, 'Field Lab & Friends');
  assert.equal(f.image, 'https://example.com/art.jpg');
  assert.equal(f.podcastGuid, '917393e3-1b1e-5cef-ace4-edaa54e1f810');
  assert.equal(f.value.type, 'lightning');
  assert.equal(f.value.recipients.length, 3);
  const [h, c, fee] = f.value.recipients;
  assert.deepEqual([h.type, h.customKey, h.customValue, h.split], ['node', '696969', 'eChoVKtO1KujpAA5HCoB', 90]);
  assert.equal(c.type, 'lnaddress'); assert.equal(fee.fee, true);
  assert.equal(f.items.length, 2); assert.equal(f.items[0].title, 'Ep 2: Guest show');
});
test('item value block overrides channel; falls back otherwise', () => {
  const f = parseFeed(xml);
  assert.deepEqual(effectiveValue(f, 0).recipients.map(r => r.name), ['Guest', 'Host']);
  assert.equal(effectiveValue(f, 1).recipients.length, 3);
});
test('splits: fee off the top, shares proportional, sums exactly', () => {
  const f = parseFeed(xml);
  const s = computeSplits(f.value.recipients, 1000);
  assert.deepEqual(s.map(x => x.sats), [891, 99, 10]);
  for (const n of [1, 7, 333, 12345]) assert.equal(computeSplits(f.value.recipients, n).reduce((a, x) => a + x.sats, 0), n);
  assert.throws(() => computeSplits(f.value.recipients, 0));
});
test('keysend payload: preimage record, sha256 hash, boost + custom records', () => {
  const pre = crypto.randomBytes(32);
  const boost = buildBoostRecord({ podcast: 'P', episode: 'E', valueMsat: 5000, valueMsatTotal: 10000, senderName: 'D', message: 'hi' });
  const ks = buildKeysend({ dest: '02' + 'aa'.repeat(32), sats: 5, boost, customKey: '696969', customValue: 'abc', preimage: pre });
  const r = ks.body.dest_custom_records;
  assert.equal(Buffer.from(r['5482373484'], 'base64').toString('hex'), pre.toString('hex'));
  assert.equal(ks.body.payment_hash, crypto.createHash('sha256').update(pre).digest('base64'));
  assert.equal(ks.paymentHashHex, crypto.createHash('sha256').update(pre).digest('hex'));
  const b = JSON.parse(Buffer.from(r['7629169'], 'base64'));
  assert.equal(b.action, 'boost'); assert.equal(b.app_name, 'Dirty Boost Whore'); assert.equal(b.value_msat_total, 10000); assert.equal(b.message, 'hi');
  assert.equal(Buffer.from(r['696969'], 'base64').toString(), 'abc');
  assert.equal(Buffer.from(ks.body.dest, 'base64').toString('hex'), '02' + 'aa'.repeat(32));
  assert.equal(ks.body.amt, '5');
  assert.throws(() => buildKeysend({ dest: 'nope', sats: 1, boost }));
  assert.notEqual(buildKeysend({ dest: '02' + 'aa'.repeat(32), sats: 1, boost }).preimageHex, buildKeysend({ dest: '02' + 'aa'.repeat(32), sats: 1, boost }).preimageHex);
});
test('lnurl helpers', () => {
  assert.equal(lnaddressToUrl('Bob@example.com'), 'https://example.com/.well-known/lnurlp/bob');
  // LUD-01 example
  assert.equal(decodeLnurl('LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS'), 'https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df');
});

test('shows: add/list/dedupe/remove', () => {
  const { createShows } = require('../lib/shows');
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shows-'));
  const s = createShows(dir);
  assert.deepEqual(s.list(), []);
  s.add({ name: 'Zed Show', feedUrl: 'https://z.example/feed', artwork: 'https://z.example/a.jpg' });
  s.add({ name: 'Alpha', feedUrl: 'https://a.example/feed', artwork: 'javascript:alert(1)' });
  assert.deepEqual(s.list().map(x => x.name), ['Alpha', 'Zed Show']);
  assert.equal(s.list()[0].artwork, '');
  s.add({ name: 'Zed Renamed', feedUrl: 'https://z.example/feed' });
  assert.equal(s.list().length, 2);
  assert.throws(() => s.add({ name: 'x', feedUrl: 'ftp://nope' }));
  assert.throws(() => s.add({ name: '', feedUrl: 'https://ok.example' }));
  assert.equal(createShows(dir).list().length, 2); // persisted
  assert.equal(s.remove('https://a.example/feed'), true);
  assert.equal(s.remove('https://a.example/feed'), false);
  assert.deepEqual(s.list().map(x => x.name), ['Zed Renamed']);
});
