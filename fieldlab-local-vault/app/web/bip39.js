import {BIP39_WORDS, BIP39_WORDLIST_SHA256} from './bip39-data.js';

export {BIP39_WORDLIST_SHA256};
export const BIP39_WORD_COUNTS = [12, 15, 18, 21, 24];
const wordSet = new Set(BIP39_WORDS);
const byPrefix = new Map();
for (const word of BIP39_WORDS) {
  const p = word.slice(0, 4);
  if (!byPrefix.has(p)) byPrefix.set(p, word);
  else if (byPrefix.get(p) !== word) byPrefix.set(p, null);
}
export const isBip39Word = w => wordSet.has(w);
export function uniqueWordForPrefix(prefix) {
  if (prefix.length !== 4) return null;
  const hit = byPrefix.get(prefix);
  return hit || null;
}
export function suggestions(prefix) {
  const p = prefix.toLowerCase();
  if (!p) return [];
  return BIP39_WORDS.filter(w => w.startsWith(p)).slice(0, 8);
}
export function assertPrefixUniqueness() {
  const seen = new Map();
  for (const word of BIP39_WORDS) {
    const p = word.slice(0, 4);
    if (seen.has(p)) return false;
    seen.set(p, word);
  }
  return true;
}
function wordsToBits(words) {
  let bits = '';
  for (const w of words) {
    const i = BIP39_WORDS.indexOf(w);
    if (i < 0) throw new Error('Unknown word');
    bits += i.toString(2).padStart(11, '0');
  }
  return bits;
}
export async function validateBip39Checksum(words) {
  const n = words.length;
  if (!BIP39_WORD_COUNTS.includes(n)) return {valid: false, reason: 'Unsupported word count'};
  if (words.some(w => !isBip39Word(w))) return {valid: false, reason: 'Unknown word in mnemonic'};
  const csLen = n / 3;
  const entLen = n * 11 - csLen;
  const bits = wordsToBits(words);
  const entropyBits = bits.slice(0, entLen);
  const checksumBits = bits.slice(entLen);
  const ent = new Uint8Array(entLen / 8);
  for (let i = 0; i < ent.length; i++) ent[i] = parseInt(entropyBits.slice(i * 8, i * 8 + 8), 2);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', ent));
  const hashBits = Array.from(hash).map(b => b.toString(2).padStart(8, '0')).join('');
  return {valid: hashBits.slice(0, csLen) === checksumBits, reason: hashBits.slice(0, csLen) === checksumBits ? 'Checksum OK' : 'Checksum mismatch'};
}
