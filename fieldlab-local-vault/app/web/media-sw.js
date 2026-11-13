/* Decrypt video byte ranges on demand; keys are held only while the media area is unlocked. */
const PLAIN = 4 * 1024 * 1024;
const jobs = new Map();

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'vault-media-keys') {
    jobs.clear();
    for (const [id, spec] of Object.entries(data.items || {})) jobs.set(id, {...spec, vaultId: data.vaultId});
  } else if (data.type === 'vault-media-lock') {
    jobs.clear();
  }
});

async function decryptRange(spec, start, end) {
  const chunkStart = Math.floor(start / PLAIN);
  const chunkEnd = Math.floor(end / PLAIN);
  const parts = [];
  for (let i = chunkStart; i <= chunkEnd; i++) {
    const iv = spec.chunks[i]?.iv;
    if (!iv) throw Error('missing chunk');
    const headers = new Headers(spec.authHeaders);
    const res = await fetch(`/api/media/items/${spec.itemId}/chunks/${i}`, {headers, cache: 'no-store'});
    if (!res.ok) throw Error('chunk fetch failed');
    const cipher = new Uint8Array(await res.arrayBuffer());
    const final = i === spec.chunks.length - 1;
    const key = await crypto.subtle.importKey('raw', spec.itemKeyBytes, 'AES-GCM', false, ['decrypt']);
    const aad = `local-vault:media:chunk:${spec.vaultId}:${spec.itemId}:${i}:${final ? 1 : 0}`;
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv: Uint8Array.from(atob(iv), c => c.charCodeAt(0)), additionalData: new TextEncoder().encode(aad)}, key, cipher
    ));
    const expected = final ? spec.size - i * PLAIN : PLAIN;
    if (plain.length !== expected) throw Error('decrypted chunk length mismatch');
    parts.push({index: i, plain});
  }
  const out = new Uint8Array(end - start + 1);
  let pos = 0;
  for (let i = chunkStart; i <= chunkEnd; i++) {
    const plain = parts.find(p => p.index === i).plain;
    const chunkOff = i * PLAIN;
    const sliceStart = Math.max(start, chunkOff) - chunkOff;
    const sliceEnd = Math.min(end + 1, chunkOff + plain.length) - chunkOff;
    out.set(plain.subarray(sliceStart, sliceEnd), pos);
    pos += sliceEnd - sliceStart;
  }
  return out;
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/__vault-media/')) {
    const itemId = url.pathname.split('/')[2];
    const spec = jobs.get(itemId);
    if (!spec) return;
    event.respondWith((async () => {
      const range = event.request.headers.get('Range');
      const total = spec.size;
      let start = 0; let end = total - 1;
      if (range?.startsWith('bytes=')) {
        const [a, b] = range.slice(6).split('-');
        start = a ? parseInt(a, 10) : Math.max(0, total - parseInt(b, 10));
        end = b ? Math.min(parseInt(b, 10), total - 1) : total - 1;
        start = Math.min(start, total - 1);
      }
      const body = await decryptRange(spec, start, end);
      const headers = {'Content-Type': spec.mime || 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(body.length)};
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
      return new Response(body, {status: range ? 206 : 200, headers});
    })());
  }
});
