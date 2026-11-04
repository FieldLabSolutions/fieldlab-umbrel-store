'use strict';
// Mock LND REST + LNURL server + feed host (plain http) for tests and local UI demo.
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual'.split(' ');
function start(port = 0, { walletState = 'SERVER_ACTIVE', adminMacPath } = {}) {
  const sent = [], st = { walletState, initPassword: null, baked: [], opened: [], peers: [], utxos: [{ amount_sat: '700000', confirmations: '6' }] };
  const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    const mac = req.headers['grpc-metadata-macaroon'];
    if (p === '/v1/state') return json(res, 200, { state: st.walletState });
    if (p === '/v1/genseed') return st.walletState === 'NON_EXISTING' ? json(res, 200, { cipher_seed_mnemonic: WORDS }) : json(res, 500, { message: 'wallet already exists' });
    if (p === '/v1/initwallet' && req.method === 'POST') { const b = JSON.parse(raw); if (st.walletState !== 'NON_EXISTING') return json(res, 500, { message: 'wallet already exists' });
      st.initPassword = Buffer.from(b.wallet_password, 'base64').toString(); st.initWords = b.cipher_seed_mnemonic.join(' '); st.walletState = 'SERVER_ACTIVE';
      if (adminMacPath) fs.writeFileSync(adminMacPath, Buffer.from('ad00', 'hex')); return json(res, 200, { admin_macaroon: 'ad00' }); }
    if (['NON_EXISTING', 'LOCKED'].includes(st.walletState) && p.startsWith('/v1/')) return json(res, 503, { message: 'wallet locked, unlock it to enable full RPC access' });
    if (p === '/v1/macaroon' && req.method === 'POST') { if (mac !== 'ad00') return json(res, 401, { message: 'verification failed: bad macaroon' }); st.baked.push(JSON.parse(raw).permissions); return json(res, 200, { macaroon: 'deadbeef' }); }
    if (p.startsWith('/v1/') && mac !== 'deadbeef') return json(res, 401, { message: 'verification failed: bad macaroon' });
    if (p === '/feed.xml') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); return res.end(fs.readFileSync(path.join(__dirname, 'sample-feed.xml'), 'utf8').replace('PORT', srv.address().port)); }
    if (p === '/v1/getinfo') return json(res, 200, { alias: 'NodeMaster-mock', identity_pubkey: '02' + 'ab'.repeat(32), synced_to_chain: true, num_active_channels: 2 });
    if (p === '/v1/balance/channels') return json(res, 200, { local_balance: { sat: '150000' }, remote_balance: { sat: '80000' } });
    if (p === '/v1/balance/blockchain') return json(res, 200, { confirmed_balance: '700000', unconfirmed_balance: '20000' });
    if (p === '/v1/utxos') return json(res, 200, { utxos: Number(u.searchParams.get('min_confs')) >= 3 ? st.utxos : st.utxos.concat({ amount_sat: '20000' }) });
    if (p === '/v1/newaddress') return json(res, 200, { address: 'bc1qmockdeposit' + u.searchParams.get('type').length });
    if (p === '/v1/channels/pending') return json(res, 200, { pending_open_channels: st.opened.map(() => ({})) });
    if (p === '/v1/peers' && req.method === 'POST') { const b = JSON.parse(raw); if (st.peers.includes(b.addr.pubkey)) return json(res, 500, { message: 'already connected to peer' }); st.peers.push(b.addr.pubkey); return json(res, 200, {}); }
    if (p === '/v1/channels' && req.method === 'POST') { const b = JSON.parse(raw); st.opened.push(b); return json(res, 200, { funding_txid_bytes: Buffer.from('11'.repeat(31) + '22', 'hex').toString('base64'), output_index: 0 }); }
    if (p === '/v1/channels') return json(res, 200, { channels: [{ remote_pubkey: '03' + 'cd'.repeat(32), active: true, local_balance: '150000', remote_balance: '80000', capacity: '230000' }] });
    if (p.startsWith('/v1/payreq/')) { const pr = decodeURIComponent(p.slice(11)); const m = pr.match(/^lnbcmock(\d+)/); if (!m) return json(res, 400, { message: 'invalid payment request' });
      return json(res, 200, { num_satoshis: m[1], description: 'mock invoice ' + m[1], destination: '02' + 'ef'.repeat(32), payment_hash: crypto.createHash('sha256').update(pr).digest('hex'), timestamp: String(Math.floor(Date.now() / 1000)), expiry: '3600' }); }
    if (p === '/v1/invoices' && req.method === 'POST') { const b = JSON.parse(raw); return json(res, 200, { r_hash: crypto.randomBytes(32).toString('base64'), payment_request: 'lnbcmock' + b.value + 'n1' + crypto.randomBytes(20).toString('hex') }); }
    if (p.startsWith('/v1/invoice/')) return json(res, 200, { state: 'OPEN' });
    if (p === '/v2/router/send' && req.method === 'POST') { const b = JSON.parse(raw); sent.push(b);
      const nd = (...o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(o.map(x => JSON.stringify(x)).join('\n') + '\n'); };
      if (b.dest_custom_records) { const pre = Buffer.from(b.dest_custom_records['5482373484'], 'base64'); if (crypto.createHash('sha256').update(pre).digest('base64') !== b.payment_hash) return nd({ result: { status: 'FAILED', failure_reason: 'FAILURE_REASON_INCORRECT_PAYMENT_DETAILS' } }); }
      if (/fail/.test(b.payment_request || '')) return nd({ result: { status: 'IN_FLIGHT' } }, { result: { status: 'FAILED', failure_reason: 'FAILURE_REASON_NO_ROUTE' } });
      if (/err/.test(b.payment_request || '')) return nd({ error: { code: 2, message: 'invoice ' + 'ab'.repeat(32) + ' is bad' } });
      return nd({ result: { status: 'SUCCEEDED', fee_sat: '1' } }); }
    if (p === '/.well-known/lnurlp/cohost') return json(res, 200, { tag: 'payRequest', callback: `http://127.0.0.1:${srv.address().port}/lnurl/cb`, minSendable: 1000, maxSendable: 1e9, commentAllowed: 100 });
    if (p === '/lnurl/cb') { const msat = Number(u.searchParams.get('amount')); return json(res, 200, { pr: 'lnbcmock' + msat / 1000 + 'n1lnurl', routes: [] }); }
    json(res, 404, { message: 'not found' });
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r({ srv, sent, st, port: srv.address().port, close: () => srv.close() })));
}
module.exports = { start };
if (require.main === module) start(Number(process.env.MOCK_PORT || 18080)).then(m => console.log('mock LND/LNURL/feed on :' + m.port));
