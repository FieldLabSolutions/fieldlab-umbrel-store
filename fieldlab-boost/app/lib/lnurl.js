'use strict';
const { getJson } = require('./http');
function lnaddressToUrl(addr, allowHttp) {
  const m = String(addr).trim().match(/^([a-z0-9._+-]+)@([a-z0-9.-]+(?::\d+)?)$/i);
  if (!m) throw new Error('Bad Lightning address: ' + addr);
  const scheme = allowHttp && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(m[2]) ? 'http' : 'https';
  return `${scheme}://${m[2]}/.well-known/lnurlp/${m[1].toLowerCase()}`;
}
// Bech32 LNURL decode (lnurl1...) without deps.
function decodeLnurl(s) {
  const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  s = s.toLowerCase().replace(/^lightning:/, '');
  const pos = s.lastIndexOf('1');
  const data = [...s.slice(pos + 1, -6)].map(c => { const v = CH.indexOf(c); if (v < 0) throw new Error('Bad LNURL'); return v; });
  let acc = 0, bits = 0; const out = [];
  for (const v of data) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
  return Buffer.from(out).toString('utf8');
}
async function resolveInvoice(target, sats, comment, { allowHttp = false } = {}) {
  const url = /@/.test(target) ? lnaddressToUrl(target, allowHttp) : /^(lightning:)?lnurl1/i.test(target) ? decodeLnurl(target) : target;
  if (!/^https:/.test(url) && !(allowHttp && /^http:\/\/(localhost|127\.0\.0\.1)/.test(url))) throw new Error('LNURL must be https');
  const p = await getJson(url);
  if (p.status === 'ERROR') throw new Error('LNURL: ' + p.reason);
  if (p.tag !== 'payRequest') throw new Error('Not an LNURL-pay endpoint');
  const msat = sats * 1000;
  if (msat < p.minSendable || msat > p.maxSendable) throw new Error(`Amount outside LNURL range ${p.minSendable / 1000}-${p.maxSendable / 1000} sats`);
  const cb = new URL(p.callback);
  cb.searchParams.set('amount', String(msat));
  if (comment && p.commentAllowed) cb.searchParams.set('comment', comment.slice(0, p.commentAllowed));
  const r = await getJson(cb.toString());
  if (r.status === 'ERROR') throw new Error('LNURL: ' + r.reason);
  if (!r.pr) throw new Error('LNURL returned no invoice');
  return { pr: r.pr, msat };
}
module.exports = { resolveInvoice, lnaddressToUrl, decodeLnurl };
