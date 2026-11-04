'use strict';
const fs = require('fs');
const { getJson, request } = require('./http');
// Thin LND REST client. The macaroon is only ever placed in the request header.
function createLnd({ rest, certPath, macaroonPath }) {
  let ca, macHex;
  function creds() {
    if (macHex === undefined) {
      ca = certPath && fs.existsSync(certPath) ? fs.readFileSync(certPath) : undefined;
      macHex = fs.readFileSync(macaroonPath).toString('hex');
    }
    return { ca, headers: { 'Grpc-Metadata-macaroon': macHex } };
  }
  async function call(method, path, body) {
    const c = creds();
    try { return await getJson(rest + path, { method, body, ca: c.ca, headers: c.headers }); }
    catch (e) { throw new Error('LND: ' + String(e.message).replace(/[0-9a-f]{40,}/gi, '[redacted]')); }
  }
  const redact = m => String(m).replace(/[0-9a-f]{40,}/gi, '[redacted]');
  // Router v2 send (the v1 SendPaymentSync endpoint is gone in newer LND). Response is NDJSON.
  async function sendRouter(body) {
    const req = { ...body, timeout_seconds: 60, no_inflight_updates: true };
    if (req.fee_limit?.fixed) req.fee_limit_sat = req.fee_limit.fixed;
    delete req.fee_limit;
    if (req.dest) req.final_cltv_delta = 80;
    const c = creds();
    let r;
    try { r = await request(rest + '/v2/router/send', { method: 'POST', body: req, ca: c.ca, headers: c.headers, timeout: 90000 }); }
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
    getInfo: () => call('GET', '/v1/getinfo'),
    channelBalance: () => call('GET', '/v1/balance/channels'),
    walletBalance: () => call('GET', '/v1/balance/blockchain'),
    listChannels: () => call('GET', '/v1/channels'),
    decodePayReq: pr => call('GET', '/v1/payreq/' + encodeURIComponent(pr)),
    addInvoice: (value, memo) => call('POST', '/v1/invoices', { value: String(value), memo }),
    lookupInvoice: hashHex => call('GET', '/v1/invoice/' + hashHex),
    sendPayment: sendRouter,
  };
}
module.exports = { createLnd };
