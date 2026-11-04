'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { parseFeed, effectiveValue, computeSplits } = require('./lib/value');
const { buildKeysend, buildBoostRecord } = require('./lib/keysend');
const { resolveInvoice } = require('./lib/lnurl');
const { createLnd } = require('./lib/lnd');
const { createHistory } = require('./lib/history');
const { createShows } = require('./lib/shows');
const { createWallet, walletPaths, READY } = require('./lib/wallet');
const { request, getJson } = require('./lib/http');

function config(env = process.env) {
  return {
    port: Number(env.PORT || 8080),
    dataDir: env.DATA_DIR || '/data',
    dryRun: String(env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
    senderName: env.SENDER_NAME ?? 'Field Lab',
    maxSats: Number(env.MAX_PAYMENT_SATS || 50000),
    piKey: env.PODCASTINDEX_KEY || '', piSecret: env.PODCASTINDEX_SECRET || '',
    piBase: env.PODCASTINDEX_BASE || 'https://api.podcastindex.org/api/1.0',
    allowHttp: env.ALLOW_HTTP_LOCAL === 'true', // tests only
    lnd: { rest: env.LND_REST || 'https://10.21.21.91:8080', certPath: env.TLS_CERT_PATH || '/data/lnd/tls.cert',
      macaroonPath: env.MACAROON_PATH || '/data/boost-node.macaroon',
      adminMacaroonPath: env.ADMIN_MACAROON_PATH || '/data/lnd/data/chain/bitcoin/mainnet/admin.macaroon' },
    walletPasswordPath: env.WALLET_PASSWORD_FILE || '/data/lnd/wallet-password',
  };
}

function createApp(cfg = config()) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const resetMarker = walletPaths(cfg).marker;
  const lnd = createLnd({ ...cfg.lnd, blocked: () => fs.existsSync(resetMarker) });
  const history = createHistory(cfg.dataDir);
  const shows = createShows(cfg.dataDir);
  const wallet = createWallet({ lnd, cfg, history });
  const plans = new Map(); // planId -> plan, short-lived, requires explicit confirm
  const pub = path.join(__dirname, 'public');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

  const checkSats = s => { s = Math.floor(Number(s)); if (!(s > 0)) throw new Error('Enter an amount in sats'); if (s > cfg.maxSats) throw new Error(`Over the ${cfg.maxSats} sat safety limit`); return s; };

  async function fetchFeed(url) {
    if (!/^https?:\/\//i.test(url)) throw new Error('Feed URL must start with http(s)://');
    const r = await request(url);
    if (r.status >= 400) throw new Error('Feed fetch failed: HTTP ' + r.status);
    return parseFeed(r.text);
  }

  async function piSearch(q) {
    if (!cfg.piKey || !cfg.piSecret) throw new Error('Podcast Index search is off (no API key). Paste a feed URL instead.');
    const date = String(Math.floor(Date.now() / 1000));
    const auth = crypto.createHash('sha1').update(cfg.piKey + cfg.piSecret + date).digest('hex');
    const j = await getJson(`${cfg.piBase}/search/byterm?q=${encodeURIComponent(q)}&max=15`, { headers: { 'X-Auth-Key': cfg.piKey, 'X-Auth-Date': date, Authorization: auth } });
    return (j.feeds || []).map(f => ({ id: f.id, title: f.title, author: f.author, url: f.url, image: f.artwork || f.image }));
  }

  const routes = {
    'GET /api/status': async () => ({ dryRun: cfg.dryRun, search: !!(cfg.piKey && cfg.piSecret), maxSats: cfg.maxSats, senderName: cfg.senderName }),
    'GET /api/summary': async () => {
      const state = await lnd.state();
      if (!READY.includes(state)) return { ready: false, state };
      const [info, cb, ch] = await Promise.all([lnd.getInfo(), lnd.channelBalance(), lnd.listChannels()]);
      const chans = ch.channels || [];
      return {
        ready: true, state, alias: info.alias, pubkey: info.identity_pubkey, synced: info.synced_to_chain, activeChannels: info.num_active_channels,
        localSats: Number(cb.local_balance?.sat ?? cb.balance ?? 0), remoteSats: Number(cb.remote_balance?.sat ?? 0),
        channels: chans.map(c => ({ peer: c.remote_pubkey?.slice(0, 12) + '…', active: c.active, local: Number(c.local_balance), remote: Number(c.remote_balance), capacity: Number(c.capacity) })),
      };
    },
    'GET /api/search': async (q) => ({ results: await piSearch(q.get('q') || '') }),
    'POST /api/feed': async (_q, b) => {
      const feed = await fetchFeed(b.url);
      return { title: feed.title, author: feed.author, image: feed.image, hasValue: !!(feed.value || feed.items.some(i => i.value)),
        episodes: feed.items.slice(0, 50).map((i, idx) => ({ idx, title: i.title, pubDate: i.pubDate, ownValue: !!i.value })) };
    },
    'POST /api/boost/preview': async (_q, b) => {
      const sats = checkSats(b.sats);
      const feed = await fetchFeed(b.feedUrl);
      const idx = Number(b.episode || 0);
      const vb = effectiveValue(feed, idx);
      if (!vb || !vb.recipients.length) throw new Error('This show has no Lightning value block');
      if (vb.type && vb.type !== 'lightning') throw new Error('Unsupported value type: ' + vb.type);
      const payees = computeSplits(vb.recipients, sats).filter(p => p.sats > 0);
      const item = feed.items[idx] || {};
      const plan = { id: crypto.randomBytes(8).toString('hex'), created: Date.now(), feedUrl: b.feedUrl, show: feed.title, image: feed.image, podcastGuid: feed.podcastGuid,
        episode: item.title || null, episodeGuid: item.guid || null, sats, message: String(b.message || '').slice(0, 500), senderName: String(b.senderName || cfg.senderName).slice(0, 60),
        payees: payees.map(p => ({ name: p.name, type: p.type, address: p.address, customKey: p.customKey, customValue: p.customValue, split: p.split, fee: p.fee, sats: p.sats, supported: ['node', 'lnaddress'].includes(p.type) })) };
      plans.set(plan.id, plan);
      return { ...plan, dryRun: cfg.dryRun };
    },
    'POST /api/boost/send': async (_q, b) => {
      if (b.confirm !== true) throw new Error('Confirmation required');
      const plan = plans.get(b.planId);
      if (!plan || Date.now() - plan.created > 10 * 60e3) throw new Error('Preview expired, preview again');
      plans.delete(plan.id);
      const results = [];
      for (const p of plan.payees) {
        const r = { name: p.name, type: p.type, address: p.address, sats: p.sats };
        try {
          const boost = buildBoostRecord({ podcast: plan.show, podcastGuid: plan.podcastGuid, feedUrl: plan.feedUrl, episode: plan.episode, episodeGuid: plan.episodeGuid,
            valueMsat: p.sats * 1000, valueMsatTotal: plan.sats * 1000, senderName: plan.senderName, message: plan.message, recipientName: p.name, ts: Math.floor(Date.now() / 1000) });
          if (p.type === 'node') {
            const ks = buildKeysend({ dest: p.address, sats: p.sats, boost, customKey: p.customKey, customValue: p.customValue });
            r.paymentHash = ks.paymentHashHex;
            if (cfg.dryRun) r.status = 'dry-run';
            else { const res = await lnd.sendPayment(ks.body); if (res.payment_error) throw new Error(res.payment_error); r.status = 'sent'; r.feeSats = Number(res.payment_route?.total_fees || 0); }
          } else if (p.type === 'lnaddress') {
            const inv = await resolveInvoice(p.address, p.sats, plan.message, { allowHttp: cfg.allowHttp });
            const dec = await lnd.decodePayReq(inv.pr);
            if (Number(dec.num_satoshis) !== p.sats) throw new Error('LNURL invoice amount mismatch');
            r.paymentHash = dec.payment_hash;
            if (cfg.dryRun) r.status = 'dry-run';
            else { const res = await lnd.sendPayment({ payment_request: inv.pr, fee_limit: { fixed: String(Math.max(10, Math.ceil(p.sats * 0.05))) } }); if (res.payment_error) throw new Error(res.payment_error); r.status = 'sent'; }
          } else { r.status = 'skipped'; r.error = 'Unsupported recipient type'; }
        } catch (e) { r.status = 'failed'; r.error = e.message; }
        results.push(r);
      }
      const entry = history.add({ kind: 'boost', dryRun: cfg.dryRun, show: plan.show, episode: plan.episode, sats: plan.sats, message: plan.message, results });
      return entry;
    },
    'POST /api/decode': async (_q, b) => {
      const pr = String(b.invoice || '').trim().replace(/^lightning:/i, '');
      const d = await lnd.decodePayReq(pr);
      const expires = Number(d.timestamp) + Number(d.expiry);
      return { invoice: pr, sats: Number(d.num_satoshis), description: d.description, destination: d.destination, paymentHash: d.payment_hash, expired: expires * 1000 < Date.now(), expiresAt: new Date(expires * 1000).toISOString() };
    },
    'POST /api/pay': async (_q, b) => {
      if (b.confirm !== true) throw new Error('Confirmation required');
      const pr = String(b.invoice || '').trim().replace(/^lightning:/i, '');
      const d = await lnd.decodePayReq(pr);
      const sats = Number(d.num_satoshis);
      if (!(sats > 0)) throw new Error('Zero-amount invoices are not supported yet');
      checkSats(sats);
      if (b.expectSats != null && Number(b.expectSats) !== sats) throw new Error('Invoice changed since decode');
      let status = 'dry-run', error, fee;
      if (!cfg.dryRun) {
        const res = await lnd.sendPayment({ payment_request: pr, fee_limit: { fixed: String(Math.max(10, Math.ceil(sats * 0.05))) } });
        if (res.payment_error) { status = 'failed'; error = res.payment_error; } else { status = 'sent'; fee = Number(res.payment_route?.total_fees || 0); }
      }
      return history.add({ kind: 'payment', dryRun: cfg.dryRun, sats, description: d.description, paymentHash: d.payment_hash, status, error, feeSats: fee });
    },
    'POST /api/invoice': async (_q, b) => {
      const sats = checkSats(b.sats);
      const memo = String(b.memo || '').slice(0, 200);
      const inv = await lnd.addInvoice(sats, memo);
      const hash = Buffer.from(inv.r_hash, 'base64').toString('hex');
      history.add({ kind: 'invoice', sats, description: memo, paymentHash: hash, status: 'created' });
      return { invoice: inv.payment_request, paymentHash: hash, sats, memo };
    },
    'GET /api/invoice': async (q) => { const i = await lnd.lookupInvoice(String(q.get('hash')).replace(/[^0-9a-f]/gi, '')); return { settled: i.state === 'SETTLED' || i.settled === true, state: i.state }; },
    'GET /api/wallet': async () => wallet.status(),
    'POST /api/wallet/seed': async () => wallet.seed(),
    'POST /api/wallet/init': async (_q, b) => wallet.init(b),
    'POST /api/wallet/restore': async (_q, b) => wallet.restore(b),
    'POST /api/wallet/reset': async (_q, b) => wallet.reset(b),
    'POST /api/backup/restore': async (_q, b) => wallet.backupRestore(b),
    'POST /api/wallet/address': async () => wallet.address(),
    'GET /api/channel/peers': async () => ({ peers: wallet.PEERS, defaultSats: 500000 }),
    'POST /api/channel/preview': async (_q, b) => wallet.preview(b),
    'POST /api/channel/open': async (_q, b) => wallet.open(b),
    'GET /api/shows': async () => ({ shows: shows.list() }),
    'POST /api/shows': async (_q, b) => shows.add(b),
    'POST /api/shows/remove': async (_q, b) => ({ removed: shows.remove(String(b.feedUrl || '')) }),
    'GET /api/history': async () => ({ items: history.list() }),
  };

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && u.pathname === '/api/backup/download') {
      try { const f = await wallet.backupDownload();
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${f.name}"`, 'cache-control': 'no-store' }); return res.end(f.data);
      } catch (e) { console.error(`GET ${u.pathname}: ${e.message}`); return send(400, { error: e.message }); }
    }
    const h = routes[`${req.method} ${u.pathname}`];
    if (h) {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) return send(413, { error: 'Too large' }); }
      let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'Bad JSON' }); }
      try { send(200, await h(u.searchParams, body)); } catch (e) { console.error(`${req.method} ${u.pathname}: ${e.message}`); send(400, { error: e.message }); }
      return;
    }
    if (req.method !== 'GET') return send(404, { error: 'Not found' });
    const f = path.normalize(path.join(pub, u.pathname === '/' ? 'index.html' : u.pathname === '/favicon.ico' ? 'favicon-32.png' : u.pathname));
    if (!f.startsWith(pub) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
}

if (require.main === module) {
  const cfg = config();
  createApp(cfg).listen(cfg.port, () => console.log(`Dirty Boost Whore on :${cfg.port} (DRY_RUN=${cfg.dryRun}, LND ${cfg.lnd.rest})`));
}
module.exports = { createApp, config };
