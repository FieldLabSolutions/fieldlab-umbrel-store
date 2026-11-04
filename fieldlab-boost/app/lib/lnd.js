'use strict';
const fs = require('fs');
const { getJson } = require('./http');
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
  return {
    getInfo: () => call('GET', '/v1/getinfo'),
    channelBalance: () => call('GET', '/v1/balance/channels'),
    walletBalance: () => call('GET', '/v1/balance/blockchain'),
    listChannels: () => call('GET', '/v1/channels'),
    decodePayReq: pr => call('GET', '/v1/payreq/' + encodeURIComponent(pr)),
    addInvoice: (value, memo) => call('POST', '/v1/invoices', { value: String(value), memo }),
    lookupInvoice: hashHex => call('GET', '/v1/invoice/' + hashHex),
    sendPayment: body => call('POST', '/v1/channels/transactions', body),
  };
}
module.exports = { createLnd };
