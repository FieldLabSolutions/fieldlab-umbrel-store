'use strict';
const http = require('http'), https = require('https');
function request(url, { method = 'GET', headers = {}, body, ca, timeout = 20000, max = 5 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = mod.request(u, { method, headers: { 'user-agent': 'FieldLabBoost/0.1', ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers }, ca, timeout }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && method === 'GET') {
        res.resume(); return resolve(request(new URL(res.headers.location, u).toString(), { method, headers, ca, timeout, max }));
      }
      const chunks = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > max) { req.destroy(new Error('Response too large')); } else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function getJson(url, opts) {
  const r = await request(url, opts);
  let j; try { j = JSON.parse(r.text); } catch { throw new Error(`Non-JSON response (${r.status}) from ${new URL(url).host}`); }
  if (r.status >= 400) throw Object.assign(new Error(j.message || j.reason || `HTTP ${r.status}`), { status: r.status, body: j });
  return j;
}
module.exports = { request, getJson };
