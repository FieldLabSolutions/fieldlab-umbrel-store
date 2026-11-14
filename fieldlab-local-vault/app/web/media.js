import {
  deriveMedia, generateMediaKey, mediaKeyForSession, wrapMediaKey, unwrapMediaKey, wrapItemKey, unwrapItemKey,
  sealMediaIndex, openMediaIndex, encryptFileChunks, encryptChunk, decryptChunk, encryptMeta, decryptMeta,
  encryptThumb, decryptThumb, MEDIA_INDEX_VERSION,
  CHUNK_PLAIN, MAX_MEDIA_ITEM,
} from './media-crypto.js';
import {authHash, b64, random, ITERATIONS, utf8} from './crypto.js';
import {
  ensureIndex, createFolder, renameFolder, deleteFolder, itemsInFolder, folderChildren, folderBreadcrumb,
  resolveOrCreateFolderPath, cloneFoldersWithNewIds, moveItemsToFolder,
} from './media-index.js';
import {openMediaLightbox} from './media-lightbox.js';

const $ = id => document.getElementById(id);
let mediaSession = null;
let mediaUrls = new Set();
let mediaLastActivity = Date.now();
let mediaViewOpen = false;
let swReg = null;
const MEDIA_HIDDEN_LOCK_MS = 60_000;
let mediaTransferCount = 0;
let mediaFilePickerOpen = false;
let mediaHiddenSince = 0;
let mediaVisibilityTimer = null;
let mediaStatusEl = null;
let mediaGlobalMessage = null;
let currentFolderId = null;
let selectedItemIds = new Set();
const mediaPreloadCache = new Map();

function mediaStatus(line, alsoGlobal = true) {
  if (mediaStatusEl) {
    mediaStatusEl.textContent = line;
    mediaStatusEl.hidden = !line;
  }
  if (alsoGlobal && mediaGlobalMessage) mediaGlobalMessage(line);
}

function mediaTransferBegin() {
  mediaTransferCount++;
  touchMediaActivity();
}

function mediaTransferEnd() {
  mediaTransferCount = Math.max(0, mediaTransferCount - 1);
}

function wireFilePickerGuard(input) {
  if (!input || input.dataset.pickerGuard) return;
  input.dataset.pickerGuard = '1';
  input.addEventListener('pointerdown', () => { mediaFilePickerOpen = true; touchMediaActivity(); });
  input.addEventListener('click', () => { mediaFilePickerOpen = true; touchMediaActivity(); });
  input.addEventListener('cancel', () => { mediaFilePickerOpen = false; });
  input.addEventListener('change', () => { setTimeout(() => { mediaFilePickerOpen = false; }, 1000); });
}

function mediaMayLockFromHidden() {
  if (!mediaSession || !mediaViewOpen) return;
  if (mediaTransferCount > 0 || mediaFilePickerOpen) return;
  if (!document.hidden || !mediaHiddenSince) return;
  if (Date.now() - mediaHiddenSince < MEDIA_HIDDEN_LOCK_MS) return;
  lockMedia('Photos & Videos locked — tab was hidden too long. Unlock and try again.');
}

function onMediaVisibilityChange() {
  if (!mediaSession) return;
  if (document.hidden) {
    if (!mediaHiddenSince) mediaHiddenSince = Date.now();
    if (!mediaVisibilityTimer) {
      mediaVisibilityTimer = setInterval(mediaMayLockFromHidden, 2000);
    }
  } else {
    mediaHiddenSince = 0;
    if (mediaVisibilityTimer) {
      clearInterval(mediaVisibilityTimer);
      mediaVisibilityTimer = null;
    }
  }
}

const THUMBNAIL_TIMEOUT_MS = 10_000;

function promiseWithTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function isHeicFile(file) {
  const t = (file.type || '').toLowerCase();
  return t === 'image/heic' || t === 'image/heif' || /\.hei[cf]$/i.test(file.name);
}

function isMediaFile(file) {
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('image/') || t.startsWith('video/')) return true;
  return /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|mp4|mov|webm|mkv|m4v)$/i.test(file.name || '');
}

export function mediaIsUnlocked() {
  return Boolean(mediaSession);
}

export async function initMediaServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  swReg = await navigator.serviceWorker.register('/media-sw.js', {scope: '/'});
}

async function mediaApi(path, options = {}, mainSession, mediaToken = null) {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${mainSession.token}`);
  const mt = mediaToken ?? mediaSession?.token;
  if (mt) headers.set('X-Media-Authorization', `Bearer ${mt}`);
  if (typeof options.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {...options, headers, cache: 'no-store', signal: mainSession.abort.signal});
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = data.error ? `${data.error}` : 'request failed';
    throw Error(`${path}: ${detail} (HTTP ${response.status})`);
  }
  return response;
}

export function lockMedia(reason) {
  const msg = reason || 'Photos & Videos locked.';
  mediaStatus(msg);
  mediaViewOpen = false;
  mediaHiddenSince = 0;
  mediaFilePickerOpen = false;
  currentFolderId = null;
  selectedItemIds.clear();
  mediaPreloadCache.clear();
  if (mediaVisibilityTimer) {
    clearInterval(mediaVisibilityTimer);
    mediaVisibilityTimer = null;
  }
  const ms = mediaSession;
  mediaSession = null;
  for (const url of mediaUrls) URL.revokeObjectURL(url);
  mediaUrls.clear();
  $('media-workspace')?.remove();
  mediaStatusEl = null;
  $('media-gate')?.remove();
  $('media-lightbox')?.remove();
  if (swReg?.active) swReg.active.postMessage({type: 'vault-media-lock'});
  document.querySelectorAll('.media-thumb, .media-full').forEach(n => n.remove());
  if (ms?.mediaKey) ms.mediaKey = null;
}

function touchMediaActivity() {
  mediaLastActivity = Date.now();
}

export function checkMediaIdle(mainSession, minutes) {
  if (!mediaSession || !mediaViewOpen) return;
  if (Date.now() - mediaLastActivity >= minutes * 60000) {
    lockMedia(`Photos & Videos locked automatically after ${minutes} minute(s) of inactivity. Unlock and try again.`);
  }
}

function authHeaderPair(mainSession) {
  return {
    Authorization: `Bearer ${mainSession.token}`,
    'X-Media-Authorization': `Bearer ${mediaSession.token}`,
  };
}

async function saveMediaIndex(mainSession) {
  ensureIndex(mediaSession);
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
    const mediaKeyWrapping = await generateMediaKey();
    const wrap = await wrapMediaKey(derived.key, mediaKeyWrapping, mainSession.config.vaultId);
    mediaKey = await mediaKeyForSession(mediaKeyWrapping);
    const index = {version: MEDIA_INDEX_VERSION, folders: [], items: []};
    const sealed = await sealMediaIndex(mediaKey, index, mainSession.config.vaultId);
    envelope = {
      version: 1, vaultId: mainSession.config.vaultId, salt, iterations: ITERATIONS,
      wrapIv: wrap.wrapIv, wrappedKey: wrap.wrappedKey, revision: 1,
      indexIv: sealed.indexIv, indexCiphertext: sealed.indexCiphertext, usedBytes: 0,
      authHash: await authHash(derived.token),
    };
    await mediaApi('/api/media/setup', {method: 'POST', body: JSON.stringify(envelope)}, mainSession, derived.token);
    mediaSession = {token: derived.token, mediaKey, envelope, index, kek: derived.key};
  } else {
    envelope = await (await mediaApi('/api/media/vault', {}, mainSession, derived.token)).json();
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
    ensureIndex(mediaSession);
  }
  touchMediaActivity();
  renderMediaWorkspace(mainSession, onMessage, onBusy);
}

async function makeThumbnail(file) {
  if (isHeicFile(file)) return null;
  const isImage = (file.type || '').startsWith('image/');
  const isVideo = (file.type || '').startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name);
  if (isImage) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await promiseWithTimeout(new Promise((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('Image load failed'));
        img.onabort = () => rej(new Error('Image load aborted'));
        img.src = url;
      }), THUMBNAIL_TIMEOUT_MS, 'Thumbnail image load timed out');
      const scale = Math.min(1, 320 / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      return await promiseWithTimeout(new Promise((res, rej) => {
        canvas.toBlob(b => (b ? res(b) : rej(new Error('Thumbnail encode failed'))), 'image/jpeg', 0.82);
      }), THUMBNAIL_TIMEOUT_MS, 'Thumbnail encode timed out');
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (isVideo) {
    const url = URL.createObjectURL(file);
    try {
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.preload = 'metadata';
      await promiseWithTimeout(new Promise((res, rej) => {
        video.onloadeddata = () => res();
        video.onloadedmetadata = () => res();
        video.onerror = () => rej(new Error('Video load failed'));
        video.onabort = () => rej(new Error('Video load aborted'));
        video.src = url;
      }), THUMBNAIL_TIMEOUT_MS, 'Thumbnail video load timed out');
      const seekTo = Math.min(1, (video.duration || 0) / 4 || 0);
      video.currentTime = seekTo;
      await promiseWithTimeout(new Promise((res, rej) => {
        const done = () => { clearTimeout(t); res(); };
        const t = setTimeout(() => rej(new Error('Video seek timed out')), THUMBNAIL_TIMEOUT_MS);
        video.onseeked = done;
        video.onerror = () => { clearTimeout(t); rej(new Error('Video seek failed')); };
      }), THUMBNAIL_TIMEOUT_MS, 'Thumbnail video seek timed out');
      const w = Math.min(320, video.videoWidth || 320);
      const h = Math.max(1, Math.round(w * (video.videoHeight || 180) / (video.videoWidth || 320)));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      return await promiseWithTimeout(new Promise((res, rej) => {
        canvas.toBlob(b => (b ? res(b) : rej(new Error('Thumbnail encode failed'))), 'image/jpeg', 0.82);
      }), THUMBNAIL_TIMEOUT_MS, 'Thumbnail encode timed out');
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return null;
}

async function uploadMediaFile(mainSession, file, onMessage, onProgress, batchLabel = '', folderId = null) {
  mediaTransferBegin();
  try {
  if (file.size > MAX_MEDIA_ITEM) throw Error(`${file.name} exceeds 4 GiB.`);
  const status = await (await mediaApi('/api/media/status', {}, mainSession)).json();
  if (!status.uploadAllowed) throw Error('Insufficient disk space on server.');
  const itemId = crypto.randomUUID();
  const itemKey = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
  const wrapped = await wrapItemKey(mediaSession.mediaKey, itemKey, mainSession.config.vaultId, itemId);
  let thumbIv = null;
  const prefix = batchLabel ? `[${batchLabel}] ` : '';
  onMessage(`${prefix}Preparing preview for ${file.name}…`);
  let thumbBlob = null;
  try {
    thumbBlob = await makeThumbnail(file);
  } catch (err) {
    onMessage(`${file.name}: preview skipped (${err.message || 'unavailable'}).`);
  }
  if (thumbBlob) {
    const tbox = await encryptThumb(itemKey, await thumbBlob.arrayBuffer(), mainSession.config.vaultId, itemId);
    thumbIv = tbox.thumbIv;
    const thumbCipher = new Uint8Array(tbox.ciphertext);
    await mediaApi(`/api/media/items/${itemId}/thumb`, {
      method: 'PUT',
      body: thumbCipher,
    }, mainSession);
  }
  const meta = {
    filename: file.name, type: file.type || 'application/octet-stream', size: file.size,
    date: new Date(file.lastModified || Date.now()).toISOString(),
  };
  const mbox = await encryptMeta(itemKey, meta, mainSession.config.vaultId, itemId);
  onMessage(`${prefix}Encrypting ${file.name}…`);
  const chunks = await encryptFileChunks(itemKey, file, mainSession.config.vaultId, itemId, (done, total) => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    onMessage(`${prefix}Encrypting ${file.name} (${pct}%)…`);
    if (onProgress) onProgress(done, total);
  });
  for (const c of chunks) {
    onMessage(`${prefix}Uploading chunk ${c.index + 1}/${chunks.length} — ${file.name}…`);
    await mediaApi(`/api/media/items/${itemId}/chunks/${c.index}`, {
      method: 'PUT',
      body: c.bytes,
    }, mainSession);
  }
  await mediaApi(`/api/media/items/${itemId}/commit`, {
    method: 'POST',
    body: JSON.stringify({chunkCount: chunks.length, plaintextSize: file.size}),
  }, mainSession);
  onMessage(`${prefix}Committed ${file.name}.`);
  const stat = await (await mediaApi('/api/media/status', {}, mainSession)).json();
  mediaSession.envelope.usedBytes = stat.usedBytes;
  const targetFolder = folderId ?? currentFolderId ?? null;
  mediaSession.index.items.push({
    id: itemId, chunkCount: chunks.length, plaintextSize: file.size,
    wrappedKey: wrapped, metaIv: mbox.metaIv, metaCiphertext: mbox.metaCiphertext,
    chunks: chunks.map(c => ({index: c.index, iv: c.iv})),
    folderId: targetFolder,
    ...(thumbIv ? {thumbIv} : {}),
  });
  await saveMediaIndex(mainSession);
  return itemId;
  } finally {
    mediaTransferEnd();
  }
}

async function decryptThumbBlob(item, mainSession) {
  if (!item.thumbIv) return null;
  const itemKey = await unwrapItemKey(mediaSession.mediaKey, item.wrappedKey, mainSession.config.vaultId, item.id);
  const res = await mediaApi(`/api/media/items/${item.id}/thumb`, {}, mainSession);
  const cipher = await res.arrayBuffer();
  const plain = new Uint8Array(await decryptThumb(itemKey, item.thumbIv, cipher, mainSession.config.vaultId, item.id));
  return new Blob([plain], {type: 'image/jpeg'});
}

async function decryptItemToBlob(item, mainSession) {
  const itemKey = await unwrapItemKey(mediaSession.mediaKey, item.wrappedKey, mainSession.config.vaultId, item.id);
  const parts = [];
  let total = 0;
  for (let i = 0; i < item.chunkCount; i++) {
    const res = await mediaApi(`/api/media/items/${item.id}/chunks/${i}`, {}, mainSession);
    const cipher = new Uint8Array(await res.arrayBuffer());
    const final = i === item.chunkCount - 1;
    const plain = new Uint8Array(await decryptChunk(itemKey, cipher, item.chunks[i].iv, mainSession.config.vaultId, item.id, i, final));
    const expected = final ? item.plaintextSize - i * CHUNK_PLAIN : CHUNK_PLAIN;
    if (plain.length !== expected) throw Error('Decrypted size does not match metadata.');
    total += plain.length;
    parts.push(plain);
  }
  if (total !== item.plaintextSize) throw Error('Decrypted size does not match metadata.');
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

async function itemMeta(item, mainSession) {
  const itemKey = await unwrapItemKey(mediaSession.mediaKey, item.wrappedKey, mainSession.config.vaultId, item.id);
  return decryptMeta(itemKey, item.metaIv, item.metaCiphertext, mainSession.config.vaultId, item.id);
}

async function loadLightboxEntry(item, meta, mainSession) {
  if (meta.type.startsWith('video/')) {
    const itemKey = await unwrapItemKey(mediaSession.mediaKey, item.wrappedKey, mainSession.config.vaultId, item.id);
    await pushVideoKeys(mainSession, item, meta, itemKey);
    return {kind: 'video', src: `/__vault-media/${item.id}`};
  }
  if (mediaPreloadCache.has(item.id)) {
    return {kind: 'image', url: mediaPreloadCache.get(item.id), revoke: false};
  }
  const blob = await decryptItemToBlob(item, mainSession);
  const url = URL.createObjectURL(blob);
  mediaUrls.add(url);
  mediaPreloadCache.set(item.id, url);
  return {kind: 'image', url};
}

function renderBreadcrumb(container, mainSession, grid, onMessage, onBusy) {
  container.replaceChildren();
  const rootBtn = document.createElement('button');
  rootBtn.type = 'button';
  rootBtn.className = 'media-crumb';
  rootBtn.textContent = 'All photos';
  rootBtn.onclick = () => {
    currentFolderId = null;
    selectedItemIds.clear();
    paintGrid(mainSession, grid, onMessage, onBusy);
  };
  container.append(rootBtn);
  for (const folder of folderBreadcrumb(mediaSession.index, currentFolderId)) {
    container.append(document.createTextNode(' / '));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'media-crumb';
    btn.textContent = folder.name;
    btn.onclick = () => {
      currentFolderId = folder.id;
      selectedItemIds.clear();
      paintGrid(mainSession, grid, onMessage, onBusy);
    };
    container.append(btn);
  }
}

async function openFolderLightbox(mainSession, startItemId, onMessage) {
  const folderItems = itemsInFolder(mediaSession.index, currentFolderId);
  const entries = [];
  for (const item of folderItems) {
    const meta = await itemMeta(item, mainSession);
    entries.push({item, meta});
  }
  const startIndex = Math.max(0, entries.findIndex(e => e.item.id === startItemId));
  openMediaLightbox({
    entries,
    startIndex,
    touchActivity: touchMediaActivity,
    loadEntry: (item, meta) => loadLightboxEntry(item, meta, mainSession),
    preloadEntry: (item, meta) => loadLightboxEntry(item, meta, mainSession),
    onClose: () => onMessage('Closed viewer.'),
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
  lockBtn.onclick = () => lockMedia('Photos & Videos locked manually.');
  const upload = document.createElement('label');
  upload.className = 'button';
  upload.textContent = 'Add photos or videos';
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.accept = 'image/*,video/*'; input.hidden = true;
  upload.append(input);
  const folderUpload = document.createElement('label');
  folderUpload.className = 'button';
  folderUpload.textContent = 'Add folder';
  const folderInput = document.createElement('input');
  folderInput.type = 'file'; folderInput.multiple = true; folderInput.webkitdirectory = true; folderInput.hidden = true;
  folderUpload.append(folderInput);
  const newFolderBtn = document.createElement('button');
  newFolderBtn.type = 'button';
  newFolderBtn.textContent = 'New folder';
  newFolderBtn.onclick = () => {
    const name = prompt('Folder name:');
    if (!name) return;
    onBusy(async () => {
      try {
        createFolder(mediaSession.index, name, currentFolderId);
        await saveMediaIndex(mainSession);
        await paintGrid(mainSession, $('media-grid'), onMessage, onBusy);
        onMessage('Folder created.');
      } catch (err) {
        onMessage(err.message || 'Could not create folder.');
      }
    });
  };
  const renameFolderBtn = document.createElement('button');
  renameFolderBtn.type = 'button';
  renameFolderBtn.textContent = 'Rename folder';
  renameFolderBtn.onclick = () => {
    if (!currentFolderId) { onMessage('Open a folder to rename.'); return; }
    const folder = mediaSession.index.folders.find(f => f.id === currentFolderId);
    const name = prompt('Rename folder:', folder?.name || '');
    if (!name) return;
    onBusy(async () => {
      renameFolder(mediaSession.index, currentFolderId, name);
      await saveMediaIndex(mainSession);
      renderBreadcrumb($('media-breadcrumb'), mainSession, $('media-grid'), onMessage, onBusy);
      await paintGrid(mainSession, $('media-grid'), onMessage, onBusy);
      onMessage('Folder renamed.');
    });
  };
  const deleteFolderBtn = document.createElement('button');
  deleteFolderBtn.type = 'button';
  deleteFolderBtn.textContent = 'Delete folder';
  deleteFolderBtn.onclick = () => {
    if (!currentFolderId) { onMessage('Open a folder to delete.'); return; }
    if (!confirm('Delete this empty folder?')) return;
    onBusy(async () => {
      try {
        deleteFolder(mediaSession.index, currentFolderId);
        currentFolderId = null;
        await saveMediaIndex(mainSession);
        renderBreadcrumb($('media-breadcrumb'), mainSession, $('media-grid'), onMessage, onBusy);
        await paintGrid(mainSession, $('media-grid'), onMessage, onBusy);
        onMessage('Folder deleted.');
      } catch (err) {
        onMessage(err.message || 'Could not delete folder.');
      }
    });
  };
  const moveBtn = document.createElement('button');
  moveBtn.type = 'button';
  moveBtn.id = 'media-move-selected';
  moveBtn.textContent = 'Move selected';
  moveBtn.hidden = true;
  moveBtn.onclick = () => {
    if (!selectedItemIds.size) return;
    const target = prompt('Move into folder name (leave empty for root):', '');
    if (target === null) return;
    onBusy(async () => {
      let targetId = null;
      if (String(target).trim()) {
        const existing = mediaSession.index.folders.find(
          f => f.name === target.trim() && (f.parentId ?? null) === (currentFolderId ?? null),
        );
        targetId = existing ? existing.id : createFolder(mediaSession.index, target.trim(), currentFolderId);
      }
      moveItemsToFolder(mediaSession.index, [...selectedItemIds], targetId);
      selectedItemIds.clear();
      await saveMediaIndex(mainSession);
      moveBtn.hidden = true;
      await paintGrid(mainSession, $('media-grid'), onMessage, onBusy);
      onMessage('Items moved.');
    });
  };
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
    onBusy(async () => {
      mediaTransferBegin();
      try {
        await importLvmedia(mainSession, file, onMessage, onBusy);
      } catch (err) {
        onMessage(err.message || 'Import failed.');
        throw err;
      } finally {
        mediaTransferEnd();
      }
    });
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
  idle.innerHTML = 'Media auto-lock<select id="media-idle"><option value="1">1 minute</option><option value="2" selected>2 minutes</option><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option></select>';
  head.append(title, lockBtn, upload, folderUpload, newFolderBtn, renameFolderBtn, deleteFolderBtn, moveBtn, importLbl, exportBtn, idle);
  const breadcrumb = document.createElement('nav');
  breadcrumb.id = 'media-breadcrumb';
  breadcrumb.className = 'media-breadcrumb';
  breadcrumb.setAttribute('aria-label', 'Media folders');
  const statusLine = document.createElement('p');
  statusLine.id = 'media-status';
  statusLine.className = 'media-status muted';
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-live', 'polite');
  statusLine.hidden = true;
  mediaStatusEl = statusLine;
  const progress = document.createElement('progress');
  progress.id = 'media-progress'; progress.hidden = true; progress.max = 100; progress.value = 0;
  const grid = document.createElement('div');
  grid.id = 'media-grid'; grid.className = 'media-grid';
  ws.append(head, breadcrumb, statusLine, progress, grid);
  wireFilePickerGuard(input);
  wireFilePickerGuard(folderInput);
  wireFilePickerGuard(importInput);

  const report = (line) => {
    touchMediaActivity();
    if (mediaStatusEl) {
      mediaStatusEl.textContent = line;
      mediaStatusEl.hidden = !line;
    }
    onMessage(line);
  };

  async function runUploadBatch(files, resolveFolder) {
    if (!mediaSession) {
      report('Media locked; unlock Photos & Videos and try again.');
      return;
    }
    progress.hidden = false;
    let uploaded = 0;
    const failures = [];
    const mediaFiles = files.filter(isMediaFile);
    const total = mediaFiles.length;
    try {
      for (let i = 0; i < mediaFiles.length; i++) {
        const file = mediaFiles[i];
        if (!mediaSession) {
          report('Media locked; unlock Photos & Videos and try again.');
          return;
        }
        let folderId = currentFolderId;
        const rel = file.webkitRelativePath || file.name;
        if (resolveFolder && file.webkitRelativePath) {
          folderId = resolveOrCreateFolderPath(mediaSession.index, file.webkitRelativePath);
        }
        const batchLabel = `${i + 1}/${total}`;
        try {
          report(`File ${batchLabel}: encrypting ${file.name}…`);
          await uploadMediaFile(mainSession, file, report, (done, totalBytes) => {
            progress.value = totalBytes ? Math.round((done / totalBytes) * 100) : 0;
          }, batchLabel, folderId);
          uploaded++;
          if (!mediaSession) throw Error('Vault locked. Operation stopped.');
          await paintGrid(mainSession, grid, onMessage, onBusy);
        } catch (err) {
          const msg = err.message || 'Upload failed.';
          failures.push(`${file.name}: ${msg}`);
          report(`Error — ${file.name}: ${msg}`);
        }
      }
    } finally {
      progress.hidden = true;
      progress.value = 0;
    }
    if (failures.length) {
      const okPart = uploaded ? `${uploaded} uploaded. ` : '';
      report(`${okPart}Failed: ${failures.join(' · ')}`);
    } else {
      report(uploaded === 1 ? 'All files uploaded and committed.' : `${uploaded} items uploaded and committed.`);
    }
    if (uploaded && mediaSession) await paintGrid(mainSession, grid, onMessage, onBusy);
  }

  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    if (!mediaSession) {
      report('Media locked; unlock Photos & Videos and try again.');
      return;
    }
    report(`Selected ${files.length} file(s): ${files.map(f => f.name).join(', ')}`);
    onBusy(() => runUploadBatch(files, false));
  });

  folderInput.addEventListener('change', () => {
    const files = [...folderInput.files];
    folderInput.value = '';
    if (!files.length) return;
    if (!mediaSession) {
      report('Media locked; unlock Photos & Videos and try again.');
      return;
    }
    const mediaCount = files.filter(isMediaFile).length;
    report(`Folder upload: ${mediaCount} media file(s) in ${files.length} total.`);
    onBusy(() => runUploadBatch(files, true));
  });

  let dragDepth = 0;
  const onDragEnter = ev => {
    ev.preventDefault();
    dragDepth++;
    ws.classList.add('media-drop-active');
  };
  const onDragLeave = ev => {
    ev.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) ws.classList.remove('media-drop-active');
  };
  const onDragOver = ev => { ev.preventDefault(); };
  const onDrop = ev => {
    ev.preventDefault();
    dragDepth = 0;
    ws.classList.remove('media-drop-active');
    const files = [...ev.dataTransfer?.files || []];
    if (!files.length) return;
    report(`Dropped ${files.length} file(s).`);
    onBusy(() => runUploadBatch(files, false));
  };
  ws.addEventListener('dragenter', onDragEnter);
  ws.addEventListener('dragleave', onDragLeave);
  ws.addEventListener('dragover', onDragOver);
  ws.addEventListener('drop', onDrop);

  renderBreadcrumb(breadcrumb, mainSession, grid, onMessage, onBusy);
  paintGrid(mainSession, grid, onMessage, onBusy);
  report('Photos & Videos unlocked.');
}

async function paintGrid(mainSession, grid, onMessage, onBusy) {
  grid.replaceChildren();
  ensureIndex(mediaSession);
  const moveBtn = $('media-move-selected');
  if (moveBtn) moveBtn.hidden = selectedItemIds.size === 0;

  for (const folder of folderChildren(mediaSession.index, currentFolderId)) {
    const card = document.createElement('article');
    card.className = 'media-card media-folder-card';
    const icon = document.createElement('div');
    icon.className = 'media-folder-icon';
    icon.textContent = '📁';
    const cap = document.createElement('p');
    cap.textContent = folder.name;
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Open';
    open.onclick = () => {
      currentFolderId = folder.id;
      selectedItemIds.clear();
      paintGrid(mainSession, grid, onMessage, onBusy);
      renderBreadcrumb($('media-breadcrumb'), mainSession, grid, onMessage, onBusy);
    };
    card.append(icon, cap, open);
    grid.append(card);
  }

  const folderItems = itemsInFolder(mediaSession.index, currentFolderId);
  for (const item of folderItems) {
    const card = document.createElement('article');
    card.className = 'media-card';
    if (selectedItemIds.has(item.id)) card.classList.add('media-card-selected');
    const meta = await itemMeta(item, mainSession);
    const sel = document.createElement('input');
    sel.type = 'checkbox';
    sel.className = 'media-select';
    sel.checked = selectedItemIds.has(item.id);
    sel.onchange = () => {
      if (sel.checked) selectedItemIds.add(item.id);
      else selectedItemIds.delete(item.id);
      card.classList.toggle('media-card-selected', sel.checked);
      const mb = $('media-move-selected');
      if (mb) mb.hidden = selectedItemIds.size === 0;
    };
    const img = document.createElement('img');
    img.className = 'media-thumb';
    const thumb = await decryptThumbBlob(item, mainSession);
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
    openBtn.type = 'button';
    openBtn.textContent = meta.type.startsWith('video/') ? 'Play' : 'View';
    openBtn.onclick = () => onBusy(() => openFolderLightbox(mainSession, item.id, onMessage));
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
        selectedItemIds.delete(item.id);
        await saveMediaIndex(mainSession);
        paintGrid(mainSession, grid, onMessage, onBusy);
        onMessage('Deleted.');
      });
    };
    actions.append(openBtn, dl, rename, del);
    card.append(sel, img, cap, actions);
    grid.append(card);
  }
  if (!folderItems.length && !folderChildren(mediaSession.index, currentFolderId).length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No photos or videos in this folder yet.';
    grid.append(empty);
  }
}

export function wireMedia(mainSession, onMessage, onBusy, masterDigestB64) {
  mediaGlobalMessage = onMessage;
  initMediaServiceWorker().catch(() => {});
  let btn = $('open-media');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'open-media'; btn.type = 'button'; btn.textContent = 'Photos & Videos';
    document.querySelector('#workspace .toolbar')?.prepend(btn);
    btn.addEventListener('click', () => onBusy(async () => {
    if (mediaSession) {
      renderMediaWorkspace(mainSession, onMessage, onBusy);
      return;
    }
      await unlockMediaFlow(mainSession, masterDigestB64, onMessage, onBusy);
    }));
    window.addEventListener('focus', () => { setTimeout(() => { mediaFilePickerOpen = false; }, 400); });
    document.addEventListener('visibilitychange', onMediaVisibilityChange);
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
  let exportMediaKey;
  try {
    exportMediaKey = await unwrapMediaKey(derived.key, remote.wrapIv, remote.wrappedKey, remote.vaultId);
  } catch {
    throw Error('Wrong media password.');
  }
  const importedIndex = await openMediaIndex(exportMediaKey, remote);
  let offset = 13 + metaLen;
  const byItem = new Map();
  for (const entry of header.files) {
    const key = entry.kind === 'thumb' ? `${entry.itemId}:thumb` : `${entry.itemId}:${entry.chunk}`;
    byItem.set(key, {entry, offset});
    offset += entry.size;
  }
  if (offset !== file.size) throw Error('Truncated .lvmedia archive.');
  const destVault = mainSession.config.vaultId;
  ensureIndex(mediaSession);
  if (importedIndex.folders?.length) {
    const {folders, idMap} = cloneFoldersWithNewIds(importedIndex.folders);
    mediaSession.index.folders.push(...folders);
    for (const item of importedIndex.items) {
      if (item.folderId && idMap[item.folderId]) item.folderId = idMap[item.folderId];
    }
  } else {
    for (const item of importedIndex.items) item.folderId = null;
  }
  for (const item of importedIndex.items) {
    const oldId = item.id;
    const newId = crypto.randomUUID();
    const itemKey = await unwrapItemKey(exportMediaKey, item.wrappedKey, remote.vaultId, oldId);
    item.wrappedKey = await wrapItemKey(mediaSession.mediaKey, itemKey, destVault, newId);
    const meta = await decryptMeta(itemKey, item.metaIv, item.metaCiphertext, remote.vaultId, oldId);
    const metaBox = await encryptMeta(itemKey, meta, destVault, newId);
    item.metaIv = metaBox.metaIv;
    item.metaCiphertext = metaBox.metaCiphertext;
    if (item.thumbIv) {
      const thumbPos = byItem.get(`${oldId}:thumb`);
      if (!thumbPos) throw Error('Missing thumbnail in archive.');
      const cipher = new Uint8Array(await file.slice(thumbPos.offset, thumbPos.offset + thumbPos.entry.size).arrayBuffer());
      const plain = await decryptThumb(itemKey, item.thumbIv, cipher, remote.vaultId, oldId);
      const tbox = await encryptThumb(itemKey, plain, destVault, newId);
      item.thumbIv = tbox.thumbIv;
      const thumbOut = new Uint8Array(tbox.ciphertext);
      await mediaApi(`/api/media/items/${newId}/thumb`, {method: 'PUT', body: thumbOut}, mainSession);
    }
    for (let i = 0; i < item.chunkCount; i++) {
      const pos = byItem.get(`${oldId}:${i}`);
      if (!pos) throw Error('Missing chunk in archive.');
      const cipher = new Uint8Array(await file.slice(pos.offset, pos.offset + pos.entry.size).arrayBuffer());
      const final = i === item.chunkCount - 1;
      const plain = await decryptChunk(itemKey, cipher, item.chunks[i].iv, remote.vaultId, oldId, i, final);
      const box = await encryptChunk(itemKey, plain, destVault, newId, i, final);
      const bytes = new Uint8Array(box.ciphertext);
      onMessage(`Importing chunk ${i + 1}/${item.chunkCount}…`);
      await mediaApi(`/api/media/items/${newId}/chunks/${i}`, {method: 'PUT', body: bytes}, mainSession);
      item.chunks[i] = {index: i, iv: box.iv};
    }
    item.id = newId;
    await mediaApi(`/api/media/items/${newId}/commit`, {
      method: 'POST',
      body: JSON.stringify({chunkCount: item.chunkCount, plaintextSize: item.plaintextSize}),
    }, mainSession);
    mediaSession.index.items.push(item);
  }
  await saveMediaIndex(mainSession);
  const grid = $('media-grid');
  if (grid) await paintGrid(mainSession, grid, onMessage, onBusy);
  onMessage(`Imported ${importedIndex.items.length} media item(s).`);
}