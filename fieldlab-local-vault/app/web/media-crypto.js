import {ITERATIONS, b64, unb64, random, derive, authHash, encrypt, decrypt, utf8} from './crypto.js';

export const CHUNK_PLAIN = 4 * 1024 * 1024;
export const MAX_MEDIA_ITEM = 4 * 1024 * 1024 * 1024;

export const chunkAAD = (vaultId, itemId, index, final) =>
  `local-vault:media:chunk:${vaultId}:${itemId}:${index}:${final ? 1 : 0}`;
export const mediaWrapAAD = vaultId => `local-vault:media:wrap:${vaultId}`;
export const itemWrapAAD = (vaultId, itemId) => `local-vault:media:item-wrap:${vaultId}:${itemId}`;
export const mediaIndexAAD = vaultId => `local-vault:media:index:${vaultId}`;
export const mediaMetaAAD = (vaultId, itemId) => `local-vault:media:meta:${vaultId}:${itemId}`;
export const mediaThumbAAD = (vaultId, itemId) => `local-vault:media:thumb:${vaultId}:${itemId}`;

export async function deriveMedia(password, salt, iterations = ITERATIONS) {
  if (iterations !== ITERATIONS || unb64(salt).length !== 32) throw Error('Unsupported vault encryption settings');
  const base = await crypto.subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations}, base, 512));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
  const token = b64(bits.slice(32));
  bits.fill(0);
  return {key, token};
}

export async function generateMediaKey() {
  return crypto.subtle.importKey('raw', random(32), 'AES-GCM', true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
}

export async function mediaKeyForSession(extractableMediaKey) {
  const raw = await crypto.subtle.exportKey('raw', extractableMediaKey);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
}

export async function wrapMediaKey(kek, mediaKey, vaultId) {
  const iv = random(12);
  const wrapped = await crypto.subtle.wrapKey('raw', mediaKey, kek, {name: 'AES-GCM', iv, additionalData: utf8.encode(mediaWrapAAD(vaultId))});
  return {wrapIv: b64(iv), wrappedKey: b64(wrapped)};
}

export async function unwrapMediaKey(kek, wrapIv, wrappedKey, vaultId) {
  const raw = await crypto.subtle.unwrapKey(
    'raw', unb64(wrappedKey), kek, {name: 'AES-GCM', iv: unb64(wrapIv), additionalData: utf8.encode(mediaWrapAAD(vaultId))},
    'AES-GCM', false, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  );
  return raw;
}

export async function wrapItemKey(mediaKey, itemKey, vaultId, itemId) {
  const iv = random(12);
  const wrapped = await crypto.subtle.wrapKey('raw', itemKey, mediaKey, {name: 'AES-GCM', iv, additionalData: utf8.encode(itemWrapAAD(vaultId, itemId))});
  return {iv: b64(iv), wrapped: b64(wrapped)};
}

export async function unwrapItemKey(mediaKey, entry, vaultId, itemId) {
  return crypto.subtle.unwrapKey(
    'raw', unb64(entry.wrapped), mediaKey, {name: 'AES-GCM', iv: unb64(entry.iv), additionalData: utf8.encode(itemWrapAAD(vaultId, itemId))},
    'AES-GCM', true, ['encrypt', 'decrypt']
  );
}

export async function encryptChunk(itemKey, bytes, vaultId, itemId, index, final) {
  const box = await encrypt(itemKey, bytes, chunkAAD(vaultId, itemId, index, final));
  return {iv: box.iv, ciphertext: box.ciphertext};
}

export async function decryptChunk(itemKey, ciphertext, iv, vaultId, itemId, index, final) {
  return decrypt(itemKey, ciphertext, iv, chunkAAD(vaultId, itemId, index, final));
}

export async function sealMediaIndex(mediaKey, index, vaultId) {
  const box = await encrypt(mediaKey, utf8.encode(JSON.stringify(index)), mediaIndexAAD(vaultId));
  return {indexIv: box.iv, indexCiphertext: b64(box.ciphertext)};
}

export async function openMediaIndex(mediaKey, envelope) {
  const raw = await decrypt(mediaKey, unb64(envelope.indexCiphertext), envelope.indexIv, mediaIndexAAD(envelope.vaultId));
  const data = JSON.parse(new TextDecoder().decode(raw));
  if (data.version !== 1 || !Array.isArray(data.items)) throw Error('Invalid media index');
  return data;
}

export async function encryptMeta(itemKey, meta, vaultId, itemId) {
  const box = await encrypt(itemKey, utf8.encode(JSON.stringify(meta)), mediaMetaAAD(vaultId, itemId));
  return {metaIv: box.iv, metaCiphertext: b64(box.ciphertext)};
}

export async function decryptMeta(itemKey, metaIv, metaCiphertext, vaultId, itemId) {
  const raw = await decrypt(itemKey, unb64(metaCiphertext), metaIv, mediaMetaAAD(vaultId, itemId));
  return JSON.parse(new TextDecoder().decode(raw));
}

export async function encryptThumb(itemKey, bytes, vaultId, itemId) {
  const box = await encrypt(itemKey, bytes, mediaThumbAAD(vaultId, itemId));
  return {thumbIv: box.iv, ciphertext: box.ciphertext};
}

export async function decryptThumb(itemKey, iv, ciphertext, vaultId, itemId) {
  return decrypt(itemKey, ciphertext, iv, mediaThumbAAD(vaultId, itemId));
}

export function chunkCount(size) {
  return Math.max(1, Math.ceil(size / CHUNK_PLAIN));
}

export async function encryptFileChunks(itemKey, file, vaultId, itemId, onProgress) {
  const total = file.size;
  const chunks = [];
  let offset = 0;
  let index = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK_PLAIN, total);
    const slice = file.slice(offset, end);
    const buf = await slice.arrayBuffer();
    const final = end >= total;
    const box = await encryptChunk(itemKey, buf, vaultId, itemId, index, final);
    chunks.push({index, iv: box.iv, bytes: new Uint8Array(box.ciphertext)});
    offset = end;
    index++;
    if (onProgress) onProgress(offset, total);
  }
  return chunks;
}
