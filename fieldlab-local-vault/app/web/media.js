import {
  deriveMedia, generateMediaKey, wrapMediaKey, unwrapMediaKey, wrapItemKey, unwrapItemKey,
  sealMediaIndex, openMediaIndex, encryptFileChunks, decryptChunk, encryptMeta, decryptMeta,
  CHUNK_PLAIN, MAX_MEDIA_ITEM, chunkCount,
} from './media-crypto.js';
import {authHash, b64, random, ITERATIONS, utf8} from './crypto.js';

const $ = id => document.getElementById(id);
let mediaSession = null;
let mediaUrls = new Set();
let mediaLastActivity = Date.now();
let mediaViewOpen = false;
let swReg = null;

export function mediaIsUnlocked() {
  return Boolean(mediaSession);
}

export async function initMediaServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  swReg = await navigator.serviceWorker.register('/media-sw.js', {scope: '/'});
}

async function mediaApi(path, options = {}, mainSession) {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${mainSession.token}`);
  if (mediaSession) headers.set('X-Media-Authorization', `Bearer ${mediaSession.token}`);
  if (typeof options.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {...options, headers, cache: 'no-store', signal: mainSession.abort.signal});
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Error(data.error || `Request failed (${response.status})`);
  }
  return response;
}

export function lockMedia() {
  mediaViewOpen = false;
  const ms = mediaSession;
  mediaSession = null;
  for (const url of mediaUrls) URL.revokeObjectURL(url);
  mediaUrls.clear();
  $('media-workspace')?.remove();
  $('media-gate')?.remove();
  if (swReg?.active) swReg.active.postMessage({type: 'vault-media-lock'});
  document.querySelectorAll('.media-thumb, .media-full').forEach(n => n.remove());
  if (ms?.mediaKey) ms.mediaKey = null;
}

function touchMediaActivity() {
  mediaLastActivity = Date.now();
}

export function checkMediaIdle(mainSession, minutes) {
  if (!mediaSession || !mediaViewOpen) return;
  if (Date.now() - mediaLastActivity >= minutes * 60000) lockMedia();
}

function authHeaderPair(mainSession) {
  return {
    Authorization: `Bearer ${mainSession.token}`,
    'X-Media-Authorization': `Bearer ${mediaSession.token}`,
  };
}

async function saveMediaIndex(mainSession) {
  const box = await sealMediaIndex(mediaSession.mediaKey, mediaSession.index, mediaSession.envelope.vaultId);
  const body = {
    ...mediaSession.envelope,
    indexIv: box.indexIv,
    indexCiphertext: box.indexCiphertext,
    revision: mediaSession.envelope.revision + 1,
    usedBytes: mediaSession.envelope.usedBytes,
  };
  const res = await mediaApi('/api/media/vault', {method: 'PUT', body: JSON.stringify(body)}, mainSession);
  const data = await res.json();
  mediaSession.envelope = {...body, revision: data.revision};
}

async function masterDigest(password) {
  return b64(await crypto.subtle.digest('SHA-256', utf8.encode(password)));
}

async function unlockMediaFlow(mainSession, masterDigestB64, onMessage, onBusy) {
  const status = await (await mediaApi('/api/media/status', {}, mainSession)).json();
  const setup = !status.initialized;
  const mediaPassword = prompt(setup ? 'Create a Photos & Videos password (must differ from master):' : 'Photos & Videos password:');
  if (!mediaPassword) return;
  if (await masterDigest(mediaPassword) === masterDigestB64) throw Error('Media password must differ from the master password.');
  onMessage('Deriving media key…');
  const salt = setup ? b64(random(32)) : status.salt;
  const derived = await deriveMedia(mediaPassword, salt);
  let envelope;
  let mediaKey;
  if (setup) {
    mediaKey = await generateMediaKey();
    const wrap = await wrapMediaKey(derived.key, mediaKey, mainSession.config.vaultId);
    const index = {version: 1, items: []};
    const sealed = await sealMediaIndex(mediaKey, index, mainSession.config.vaultId);
    envelope = {
      version: 1, vaultId: mainSession.config.vaultId, salt, iterations: ITERATIONS,
      wrapIv: wrap.wrapIv, wrappedKey: wrap.wrappedKey, revision: 1,
      indexIv: sealed.indexIv, indexCiphertext: sealed.indexCiphertext, usedBytes: 0,
      authHash: await authHash(derived.token),
    };
    await mediaApi('/api/media/setup', {method: 'POST', body: JSON.stringify(envelope)}, mainSession);
    mediaSession = {token: derived.token, mediaKey, envelope, index, kek: derived.key};
  } else {
    envelope = await (await mediaApi('/api/media/vault', {}, mainSession)).json();
    try {
      mediaKey = await unwrapMediaKey(derived.key, envelope.wrapIv, envelope.wrappedKey, envelope.vaultId);
    } catch {
      throw Error('Wrong media password.');
    }
    let index;
    try {
      index = await openMediaIndex(mediaKey, envelope);
    } catch {
      throw Error('Unable to decrypt media index.');
    }
    mediaSession = {token: derived.token, mediaKey, envelope, index, kek: derived.key};
  }
  touchMediaActivity();
  renderMediaWorkspace(mainSession, onMessage, onBusy);
}

async function makeThumbnail(file) {
  if (file.type.startsWith('image/') && file.type !== 'image/heic' && file.type !== 'image/heif') {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, 320 / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      return await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.82));
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (file.type.startsWith('video/')) {
    const url = URL.createObjectURL(file);
    try {
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.src = url;
      await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = rej; });
      video.currentTime = Math.min(1, video.duration / 4 || 0);
      await new Promise(res => { video.onseeked = res; });
      const w = Math.min(320, video.videoWidth || 320);
      const h = Math.round(w * (video.videoHeight || 180) / (video.videoWidth || 320));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      return await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.82));
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return null;
}

async function uploadMediaFile(mainSession, file, onMessage, onProgress) {
  if (file.size > MAX_MEDIA_ITEM) throw Error(`${file.name} exceeds 4 GiB.`);
  const status = await (await mediaApi('/api/media/status', {}, mainSession)).json();
  if (!status.uploadAllowed) throw Error('Insufficient disk space on server.');
  const itemId = crypto.randomUUID();
  const itemKey = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
  const wrapped = await wrapItemKey(mediaSession.mediaKey, itemKey, mainSession.config.vaultId, itemId);
  const thumbBlob = await makeThumbnail(file);
  let thumbMeta = {thumb: null};
  if (thumbBlob) {
    const thumbBytes = await thumbBlob.arrayBuffer();
    const tbox = await encryptMeta(itemKey, {bytes: b64(thumbBytes)}, mainSession.config.vaultId, itemId);
    thumbMeta = {thumbIv: tbox.metaIv, thumbCiphertext: tbox.metaCiphertext};
  }
  const meta = {
    filename: file.name, type: file.type || 'application/octet-stream', size: file.size,
    date: new Date(file.lastModified || Date.now()).toISOString(), ...thumbMeta,
  };
  const mbox = await encryptMeta(itemKey, meta, mainSession.config.vaultId, itemId);
  const chunks = await encryptFileChunks(itemKey, file, mainSession.config.vaultId, itemId, onProgress);
  for (const c of chunks) {
    onMessage(`Uploading ${file.name} chunk ${c.index + 1}/${chunks.length}…`);
    await mediaApi(`/api/media/items/${itemId}/chunks/${c.index}`, {
      method: 'PUT',
      body: new Blob([c.bytes], {type: 'application/octet-stream'}),
      headers: {'Content-Length': String(c.bytes.byteLength)},
    }, mainSession);
  }
  await mediaApi(`/api/media/items/${itemId}/commit`, {method: 'POST', body: JSON.stringify({chunkCount: chunks.length})}, mainSession);
  const stat = await (await mediaApi('/api/media/status', {}, mainSession)).json();
  mediaSession.envelope.usedBytes = stat.usedBytes;
  mediaSession.index.items.push({
    id: itemId, chunkCount: chunks.length, plaintextSize: file.size,
    wrappedKey: wrapped, metaIv: mbox.metaIv, metaCiphertext: mbox.metaCiphertext,
    chunks: chunks.map(c => ({index: c.index, iv: c.iv})),
  });
  await saveMediaIndex(mainSession);
  return itemId;
}

async function decryptThumb(item, mainSession) {
  const itemKey = await unwrapItemKey(mediaSession.mediaKey, item.wrappedKey, mainSession.config.vaultId, item.id);
  const meta = await decryptMeta(itemKey, item.metaIv, item.metaCiphertext, mainSession.config.vaultId, item.id);
  if (!meta.thumbIv) return null;
  const inner = await decryptMeta(itemKey, meta.thumbIv, meta.thumbCiphertext, mainSession.config.vaultId, item.id);
  return new Blob([Uint8Array.from(atob(inner.bytes), c => c.charCodeAt(0))], {type: 'image/jpeg'});
}

async function decryptItemToBlob(item, mainSession) {
  const itemKey = await unwrapItemKey(mediaSession.mediaKey, item.wrappedKey, mainSession.config.vaultId, item.id);
  const parts = [];
  for (let i = 0; i < item.chunkCount; i++) {
    const res = await mediaApi(`/api/media/items/${item.id}/chunks/${i}`, {}, mainSession);
    const cipher = new Uint8Array(await res.arrayBuffer());
    const final = i === item.chunkCount - 1;
    const plain = new Uint8Array(await decryptChunk(itemKey, cipher, item.chunks[i].iv, mainSession.config.vaultId, item.id, i, final));
    parts.push(plain);
  }
  const meta = await decryptMeta(itemKey, item.metaIv, item.metaCiphertext, mainSession.config.vaultId, item.id);
  return new Blob(parts, {type: meta.type || 'application/octet-stream'});
}

async function pushVideoKeys(mainSession, item, meta, itemKey) {
  if (!swReg?.active) return;
  const raw = await crypto.subtle.exportKey('raw', itemKey);
  swReg.active.postMessage({
    type: 'vault-media-keys',
    vaultId: mainSession.config.vaultId,
    items: {
      [item.id]: {
        itemId: item.id,
        size: item.plaintextSize,
        mime: meta.type,
        chunks: item.chunks,
        itemKeyBytes: new Uint8Array(raw),
        authHeaders: authHeaderPair(mainSession),
      },
    },
  });
}

function renderMediaWorkspace(mainSession, onMessage, onBusy) {
  mediaViewOpen = true;
  let ws = $('media-workspace');
  if (!ws) {
    ws = document.createElement('section');
    ws.id = 'media-workspace';
    $('workspace').after(ws);
  }
  ws.hidden = false;
  ws.replaceChildren();
  const head = document.createElement('div');
  head.className = 'toolbar media-toolbar';
  const title = document.createElement('h2');
  title.textContent = 'Photos & Videos';
  const lockBtn = document.createElement('button');
  lockBtn.type = 'button'; lockBtn.textContent = 'Lock media';
  lockBtn.onclick = () => { lockMedia(); onMessage('Photos & Videos locked.'); };
  const upload = document.createElement('label');
  upload.className = 'button';
  upload.textContent = 'Add photos or videos';
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.accept = 'image/*,video/*'; input.hidden = true;
  upload.append(input);
  const importLbl = document.createElement('label');
  importLbl.className = 'button';
  importLbl.textContent = 'Import .lvmedia';
  const importInput = document.createElement('input');
  importInput.type = 'file'; importInput.accept = '.lvmedia'; importInput.hidden = true;
  importLbl.append(importInput);
  importInput.addEventListener('change', () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    onBusy(() => importLvmedia(mainSession, file, onMessage, onBusy));
  });
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button'; exportBtn.textContent = 'Export Photos & Videos';
  exportBtn.onclick = () => onBusy(async () => {
    onMessage('Preparing encrypted media export…');
    const prep = await (await mediaApi('/api/media/export', {method: 'POST', body: '{}'}, mainSession)).json();
    const res = await mediaApi(prep.url, {}, mainSession);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `fieldlab-vault-${new Date().toISOString().slice(0, 10)}.lvmedia`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onMessage('Media export downloaded (.lvmedia).');
  });
  const idle = document.createElement('label');
  idle.className = 'idle-label';
  idle.innerHTML = 'Media auto-lock<select id="media-idle"><option value="1">1 minute</option><option value="2" selected>2 minutes</option><option value="5">5 minutes</option></select>';
  head.append(title, lockBtn, upload, importLbl, exportBtn, idle);
  const progress = document.createElement('progress');
  progress.id = 'media-progress'; progress.hidden = true; progress.max = 100; progress.value = 0;
  const grid = document.createElement('div');
  grid.id = 'media-grid'; grid.className = 'media-grid';
  ws.append(head, progress, grid);
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    onBusy(async () => {
      progress.hidden = false;
      for (const file of files) {
        await uploadMediaFile(mainSession, file, onMessage, (done, total) => {
          progress.value = Math.round((done / total) * 100);
        });
      }
      progress.hidden = true;
      onMessage(files.length === 1 ? 'Media uploaded.' : `${files.length} items uploaded.`);
      paintGrid(mainSession, grid, onMessage, onBusy);
    });
  });
  paintGrid(mainSession, grid, onMessage, onBusy);
  onMessage('Photos & Videos unlocked.');
}

async function paintGrid(mainSession, grid, onMessage, onBusy) {
  grid.replaceChildren();
  for (const item of mediaSession.index.items) {
    const card = document.createElement('article');
    card.className = 'media-card';
    const meta = await decryptMeta(
      await unwrapItemKey(mediaSession.mediaKey, item.wrappedKey, mainSession.config.vaultId, item.id),
      item.metaIv, item.metaCiphertext, mainSession.config.vaultId, item.id
    );
    const img = document.createElement('img');
    img.className = 'media-thumb';
  const thumb = await decryptThumb(item, mainSession);
    if (thumb) {
      const url = URL.createObjectURL(thumb);
      mediaUrls.add(url);
      img.src = url;
    } else {
      img.alt = 'No preview';
      img.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect fill="#20353c" width="100%" height="100%"/><text x="50%" y="50%" fill="#9eb0b5" text-anchor="middle" font-size="12">No preview</text></svg>');
    }
    const cap = document.createElement('p');
    cap.textContent = meta.filename;
    const actions = document.createElement('div');
    actions.className = 'attachment-actions';
    const openBtn = document.createElement('button');
    openBtn.type = 'button'; openBtn.textContent = meta.type.startsWith('video/') ? 'Play' : 'View';
    openBtn.onclick = () => onBusy(() => openItem(item, meta, mainSession, onMessage));
    const dl = document.createElement('button');
    dl.type = 'button'; dl.textContent = 'Download';
    dl.onclick = () => onBusy(async () => {
      onMessage('Decrypting…');
      const blob = await decryptItemToBlob(item, mainSession);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = meta.filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      onMessage('Downloaded decrypted copy.');
    });
    const rename = document.createElement('button');
    rename.type = 'button'; rename.textContent = 'Rename';
    rename.onclick = () => {
      const next = prompt('New filename:', meta.filename);
      if (!next || next === meta.filename) return;
      onBusy(async () => {
        const itemKey = await unwrapItemKey(mediaSession.mediaKey, item.wrappedKey, mainSession.config.vaultId, item.id);
        const newMeta = {...meta, filename: next};
        const box = await encryptMeta(itemKey, newMeta, mainSession.config.vaultId, item.id);
        item.metaIv = box.metaIv; item.metaCiphertext = box.metaCiphertext;
        await saveMediaIndex(mainSession);
        paintGrid(mainSession, grid, onMessage, onBusy);
        onMessage('Renamed.');
      });
    };
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'danger'; del.textContent = 'Delete';
    del.onclick = () => {
      if (!confirm(`Delete “${meta.filename}”?`)) return;
      onBusy(async () => {
        await mediaApi(`/api/media/items/${item.id}`, {method: 'DELETE'}, mainSession);
        mediaSession.index.items = mediaSession.index.items.filter(x => x.id !== item.id);
        await saveMediaIndex(mainSession);
        paintGrid(mainSession, grid, onMessage, onBusy);
        onMessage('Deleted.');
      });
    };
    actions.append(openBtn, dl, rename, del);
    card.append(img, cap, actions);
    grid.append(card);
  }
  if (!mediaSession.index.items.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No photos or videos yet.';
    grid.append(empty);
  }
}

async function openItem(item, meta, mainSession, onMessage) {
  touchMediaActivity();
  if (meta.type.startsWith('video/')) {
    const itemKey = await unwrapItemKey(mediaSession.mediaKey, item.wrappedKey, mainSession.config.vaultId, item.id);
    await pushVideoKeys(mainSession, item, meta, itemKey);
    const wrap = document.createElement('div');
    wrap.className = 'media-viewer';
    const video = document.createElement('video');
    video.controls = true; video.className = 'media-full';
    video.src = `/__vault-media/${item.id}`;
    video.addEventListener('timeupdate', touchMediaActivity);
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.onclick = () => wrap.remove();
    wrap.append(video, close);
    $('media-workspace').append(wrap);
    video.play().catch(() => {});
    onMessage('Streaming decrypted video.');
    return;
  }
  onMessage('Decrypting photo…');
  const blob = await decryptItemToBlob(item, mainSession);
  const url = URL.createObjectURL(blob);
  mediaUrls.add(url);
  const img = document.createElement('img');
  img.className = 'media-full'; img.src = url;
  const wrap = document.createElement('div');
  wrap.className = 'media-viewer';
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.onclick = () => { wrap.remove(); URL.revokeObjectURL(url); mediaUrls.delete(url); };
  wrap.append(img, close);
  $('media-workspace').append(wrap);
}

export function wireMedia(mainSession, onMessage, onBusy, masterDigestB64) {
  initMediaServiceWorker().catch(() => {});
  let btn = $('open-media');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'open-media'; btn.type = 'button'; btn.textContent = 'Photos & Videos';
    $('.toolbar')?.prepend(btn);
    btn.addEventListener('click', () => onBusy(async () => {
    if (mediaSession) {
      renderMediaWorkspace(mainSession, onMessage, onBusy);
      return;
    }
      await unlockMediaFlow(mainSession, masterDigestB64, onMessage, onBusy);
    }));
    document.addEventListener('visibilitychange', () => { if (document.hidden) lockMedia(); });
  }
}

export function onVaultLockMedia() {
  lockMedia();
}

export function mediaIdleMinutes() {
  const el = $('media-idle');
  return Number(el?.value || 2);
}

export function touchMediaFromVault() {
  touchMediaActivity();
}

async function importLvmedia(mainSession, file, onMessage, onBusy) {
  const password = prompt('Media password used when this .lvmedia was exported:');
  if (!password) return;
  const head = new Uint8Array(await file.slice(0, 13).arrayBuffer());
  if (new TextDecoder().decode(head.slice(0, 9)) !== 'LVMEDIA01') throw Error('Not a .lvmedia file.');
  const metaLen = new DataView(head.buffer).getUint32(9);
  const header = JSON.parse(await file.slice(13, 13 + metaLen).text());
  const remote = header.state;
  const derived = await deriveMedia(password, remote.salt);
  if (await authHash(derived.token) !== remote.authHash) throw Error('Wrong media password.');
  const mediaKey = await unwrapMediaKey(derived.key, remote.wrapIv, remote.wrappedKey, remote.vaultId);
  const importedIndex = await openMediaIndex(mediaKey, remote);
  let offset = 13 + metaLen;
  const byItem = new Map();
  for (const entry of header.files) {
    byItem.set(`${entry.itemId}:${entry.chunk}`, {entry, offset});
    offset += entry.size;
  }
  if (offset !== file.size) throw Error('Truncated .lvmedia archive.');
  for (const item of importedIndex.items) {
    const oldId = item.id;
    const newId = crypto.randomUUID();
    const oldKey = await unwrapItemKey(mediaKey, item.wrappedKey, remote.vaultId, oldId);
    item.wrappedKey = await wrapItemKey(mediaSession.mediaKey, oldKey, mainSession.config.vaultId, newId);
    item.id = newId;
    for (let i = 0; i < item.chunkCount; i++) {
      const pos = byItem.get(`${oldId}:${i}`);
      if (!pos) throw Error('Missing chunk in archive.');
      const blob = await file.slice(pos.offset, pos.offset + pos.entry.size).arrayBuffer();
      onMessage(`Importing chunk ${i + 1}/${item.chunkCount}…`);
      await mediaApi(`/api/media/items/${newId}/chunks/${i}`, {
        method: 'PUT', body: blob, headers: {'Content-Length': String(blob.byteLength)},
      }, mainSession);
    }
    await mediaApi(`/api/media/items/${newId}/commit`, {method: 'POST', body: JSON.stringify({chunkCount: item.chunkCount})}, mainSession);
    mediaSession.index.items.push(item);
  }
  await saveMediaIndex(mainSession);
  const grid = $('media-grid');
  if (grid) await paintGrid(mainSession, grid, onMessage, onBusy);
  onMessage(`Imported ${importedIndex.items.length} media item(s).`);
}
