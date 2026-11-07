// Every content field and original filename is encrypted in the browser.
export const ITERATIONS = 600000;
export const MAX_FILE = 128 * 1024 * 1024;
export const utf8 = new TextEncoder();
const decoder = new TextDecoder();
export const b64 = b => {
  const a = new Uint8Array(b); let s = '';
  for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode(...a.subarray(i, i + 8192));
  return btoa(s);
};
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const random = n => crypto.getRandomValues(new Uint8Array(n));
export async function derive(password, salt, iterations = ITERATIONS) {
  if (iterations !== ITERATIONS || unb64(salt).length !== 32) throw Error('Unsupported vault encryption settings');
  const base = await crypto.subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations}, base, 512));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const token = b64(bits.slice(32)); bits.fill(0);
  return {key, token};
}
export async function authHash(token) { return b64(await crypto.subtle.digest('SHA-256', utf8.encode(token))); }
export async function encrypt(key, bytes, aad) {
  const iv = random(12);
  const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: utf8.encode(aad)}, key, bytes);
  return {iv: b64(iv), ciphertext};
}
export async function decrypt(key, bytes, iv, aad) {
  return crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(iv), additionalData: utf8.encode(aad)}, key, bytes);
}
export async function sealIndex(key, index, vaultId) {
  const box = await encrypt(key, utf8.encode(JSON.stringify(index)), `local-vault:1:index:${vaultId}`);
  return {iv: box.iv, ciphertext: b64(box.ciphertext)};
}
export async function openIndex(key, envelope) {
  const raw = await decrypt(key, unb64(envelope.ciphertext), envelope.iv, `local-vault:1:index:${envelope.vaultId}`);
  const data = JSON.parse(decoder.decode(raw));
  if (data.version !== 1 || !Array.isArray(data.notes) || !Array.isArray(data.files)) throw Error('Invalid encrypted index');
  return data;
}
export const fileAAD = (vaultId, fileId) => `local-vault:1:file:${vaultId}:${fileId}`;
