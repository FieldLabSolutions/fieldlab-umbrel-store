import {ITERATIONS, MAX_FILE, b64, unb64, random, derive, authHash, encrypt, decrypt, sealIndex, openIndex, fileAAD} from './crypto.js';
const $ = id => document.getElementById(id);
let setup = false, session = null, busy = false, pendingImport = null, generation = 0;
let lastActivity = Date.now(), dirty = false;
const urls = new Set();
const message = text => { $('message').textContent = text; };
const ensure = s => { if (!s || session !== s) throw Error('Vault locked. Unlock to continue.'); };
function controls() {
  document.querySelectorAll('#workspace button, #workspace input, #workspace select, #import-form button').forEach(e => {e.disabled = busy;});
  $('unlock-submit').disabled = busy;
}
async function task(fn) {
  if (busy) return;
  busy = true; controls();
  try { await fn(); } catch (err) { message(err.name === 'AbortError' ? 'Vault locked. Operation stopped.' : (err.message || 'Operation failed.')); }
  finally { busy = false; controls(); }
}
async function api(path, options = {}, s = session) {
  const headers = new Headers(options.headers);
  if (s) headers.set('Authorization', `Bearer ${s.token}`);
  if (typeof options.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {...options, headers, cache: 'no-store', signal: s?.abort.signal});
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Error(data.error || `Request failed (${response.status})`);
  }
  return response;
}
function clearPlaintext() {
  $('notes').replaceChildren(); $('files').replaceChildren(); $('editor').replaceChildren();
  $('search').value = ''; $('password').value = ''; $('confirm-password').value = ''; $('backup-password').value = '';
  $('upload').value = ''; $('import').value = '';
  if ($('import-dialog').open) $('import-dialog').close();
  pendingImport = null;
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear(); dirty = false;
}
function lock() {
  const unsaved = dirty;
  generation++;
  session?.abort.abort(); session = null;
  clearPlaintext();
  $('workspace').hidden = true; $('lock').hidden = true; $('gate').hidden = false;
  message(unsaved ? 'Locked. Unsaved note edits were discarded.' : 'Locked.');
  $('password').focus();
}
async function init() {
  if (!isSecureContext || !crypto.subtle) {
    message('Open this vault over HTTPS in a current browser. Encryption requires a secure context.');
    $('unlock-submit').disabled = true; return;
  }
  const status = await (await api('/api/status', {}, null)).json();
  setup = !status.initialized;
  $('gate-title').textContent = setup ? 'Create your private vault' : 'Unlock your vault';
  $('gate-help').textContent = setup ? 'Choose a unique passphrase of at least 16 characters. Only you will know it. Do not put it in chat.' : 'Your password and decrypted content stay in this browser tab.';
  $('confirm-wrap').hidden = !setup;
  $('confirm-password').required = setup;
  $('password').autocomplete = setup ? 'new-password' : 'current-password';
  $('unlock-submit').textContent = setup ? 'Create vault' : 'Unlock';
}
$('unlock-form').addEventListener('submit', event => {
  event.preventDefault();
  task(async () => {
    const stamp = generation;
    let password = $('password').value;
    if (setup && (password.length < 16 || password !== $('confirm-password').value)) throw Error('Use at least 16 characters and matching passwords.');
    $('password').value = ''; $('confirm-password').value = '';
    const config = setup ? {version: 1, vaultId: crypto.randomUUID(), salt: b64(random(32)), iterations: ITERATIONS} : await (await api('/api/status', {}, null)).json();
    message('Deriving encryption key…');
    const derived = await derive(password, config.salt, config.iterations); password = '';
    if (generation !== stamp) return;
    const s = {...derived, config, abort: new AbortController(), index: null, revision: 0};
    let index;
    if (setup) {
      index = {version: 1, notes: [], files: []};
      const box = await sealIndex(s.key, index, config.vaultId);
      const envelope = {...config, ...box, revision: 1, authHash: await authHash(s.token)};
      await api('/api/setup', {method: 'POST', body: JSON.stringify(envelope)}, null);
      s.revision = 1; setup = false;
      $('confirm-wrap').hidden = true; $('confirm-password').required = false;
      $('gate-title').textContent = 'Unlock your vault'; $('unlock-submit').textContent = 'Unlock';
      $('gate-help').textContent = 'Your password and decrypted content stay in this browser tab.';
    } else {
      const envelope = await (await api('/api/vault', {}, s)).json();
      try { index = await openIndex(s.key, envelope); }
      catch { throw Error('Unable to decrypt: wrong password or damaged vault.'); }
      s.revision = envelope.revision;
    }
    if (generation !== stamp) {s.abort.abort(); return;}
    s.index = index; session = s; dirty = false; lastActivity = Date.now();
    $('gate').hidden = true; $('workspace').hidden = false; $('lock').hidden = false;
    render(); message('Unlocked. Auto-lock is on. Export an encrypted backup after changes.');
  });
});
async function save(s, index) {
  ensure(s);
  const box = await sealIndex(s.key, index, s.config.vaultId); ensure(s);
  const envelope = {version: 1, vaultId: s.config.vaultId, salt: s.config.salt, iterations: ITERATIONS, ...box, revision: s.revision + 1};
  await api('/api/vault', {method: 'PUT', body: JSON.stringify(envelope)}, s); ensure(s);
  s.index = index; s.revision = envelope.revision;
}
function button(text, handler, cls = '') {
  const b = document.createElement('button'); b.textContent = text; b.className = cls;
  b.addEventListener('click', handler); return b;
}
function render() {
  const s = session; if (!s) return;
  const query = $('search').value.toLocaleLowerCase();
  $('notes').replaceChildren(); $('files').replaceChildren();
  for (const note of s.index.notes.filter(n => `${n.title}\n${n.body}`.toLocaleLowerCase().includes(query))) {
    $('notes').append(button(note.title || 'Untitled note', () => editNote(note.id), 'item'));
  }
  for (const file of s.index.files.filter(f => f.name.toLocaleLowerCase().includes(query))) {
    const row = document.createElement('div'); row.className = 'file';
    const name = document.createElement('span'); name.textContent = file.name;
    const size = document.createElement('small'); size.textContent = `${(file.size / 1048576).toFixed(2)} MiB`;
    row.append(name, size, button('Download', () => task(() => downloadFile(file))), button('Delete', () => task(() => deleteFile(file)), 'danger'));
    $('files').append(row);
  }
  if (!s.index.notes.length) $('notes').textContent = 'No notes yet.';
  if (!s.index.files.length) $('files').textContent = 'No files yet.';
}
function editNote(id = null) {
  if (busy) return;
  if (dirty && !confirm('Discard unsaved edits to this note?')) return;
  const note = session.index.notes.find(n => n.id === id) || {id: crypto.randomUUID(), title: '', body: ''};
  $('editor').replaceChildren();
  const heading = document.createElement('h2'); heading.textContent = id ? 'Edit note' : 'New note';
  const title = document.createElement('input'); title.id = 'note-title'; title.placeholder = 'Note title'; title.ariaLabel = 'Note title'; title.value = note.title; title.maxLength = 1000;
  const body = document.createElement('textarea'); body.id = 'note-body'; body.placeholder = 'Write something private…'; body.ariaLabel = 'Note text'; body.value = note.body; body.maxLength = 1000000;
  title.addEventListener('input', () => {dirty = true;}); body.addEventListener('input', () => {dirty = true;});
  const hint = document.createElement('p'); hint.className = 'muted'; hint.textContent = 'Click Save to keep edits. Locking or idle auto-lock discards unsaved changes.';
  $('editor').append(heading, title, body, button('Save note', () => task(async () => {
    const s = session; ensure(s);
    const index = structuredClone(s.index);
    const updated = {id: note.id, title: title.value, body: body.value, updated: new Date().toISOString()};
    const pos = index.notes.findIndex(n => n.id === note.id);
    if (pos < 0) index.notes.push(updated); else index.notes[pos] = updated;
    await save(s, index); dirty = false; render(); message('Note saved.');
  })), hint);
  if (id) $('editor').append(button('Delete note', () => task(async () => {
    if (!confirm('Permanently delete this note? Existing exported backups are not changed.')) return;
    const s = session; const index = structuredClone(s.index); index.notes = index.notes.filter(n => n.id !== id);
    await save(s, index); dirty = false; $('editor').replaceChildren(); render(); message('Note deleted.');
  }), 'danger'));
  dirty = false; title.focus();
}
async function uploadBytes(s, name, bytes, type = 'application/octet-stream') {
  ensure(s);
  if (bytes.byteLength > MAX_FILE) throw Error('File exceeds 128 MiB.');
  const id = crypto.randomUUID();
  const box = await encrypt(s.key, bytes, fileAAD(s.config.vaultId, id)); ensure(s);
  await api(`/api/files/${id}`, {method: 'PUT', body: new Blob([box.ciphertext], {type: 'application/octet-stream'})}, s); ensure(s);
  return {id, name, type, size: bytes.byteLength, iv: box.iv, added: new Date().toISOString()};
}
$('upload').addEventListener('change', () => {
  const files = [...$('upload').files]; $('upload').value = '';
  task(async () => {
    const s = session;
    for (const file of files) {
      if (file.size > MAX_FILE) throw Error(`${file.name}: exceeds 128 MiB. Earlier files, if any, were saved.`);
      message(`Encrypting ${file.name}…`);
      const meta = await uploadBytes(s, file.name, await file.arrayBuffer(), file.type);
      const index = structuredClone(s.index); index.files.push(meta);
      await save(s, index); render();
    }
    message(`${files.length} file(s) encrypted and saved.`);
  });
});
function download(blob, name) {
  const url = URL.createObjectURL(blob); urls.add(url);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => {URL.revokeObjectURL(url); urls.delete(url);}, 30000);
}
async function downloadFile(file) {
  const s = session; message('Decrypting file…');
  const bytes = await (await api(`/api/files/${file.id}`, {}, s)).arrayBuffer(); ensure(s);
  let plain;
  try { plain = await decrypt(s.key, bytes, file.iv, fileAAD(s.config.vaultId, file.id)); }
  catch { throw Error('File integrity check failed. Nothing was downloaded.'); }
  ensure(s);
  download(new Blob([plain], {type: 'application/octet-stream'}), file.name);
  message('File downloaded. The downloaded copy is NOT encrypted; protect or remove it yourself.');
}
async function deleteFile(file) {
  if (!confirm(`Permanently delete “${file.name}”? Existing exports are not changed.`)) return;
  const s = session; const index = structuredClone(s.index); index.files = index.files.filter(f => f.id !== file.id);
  await save(s, index);
  await api(`/api/files/${file.id}`, {method: 'DELETE'}, s); ensure(s); render(); message('File deleted.');
}
$('export').addEventListener('click', () => task(async () => {
  const s = session;
  let target;
  if ('showSaveFilePicker' in window) {
    try { target = await showSaveFilePicker({suggestedName: `local-vault-${new Date().toISOString().slice(0,10)}.lvbak`}); }
    catch (error) { if (error.name === 'AbortError') return; throw error; }
  }
  message('Downloading encrypted vault backup…');
  const response = await api('/api/export', {}, s);
  if (target) {
    const writable = await target.createWritable();
    try { await response.body.pipeTo(writable, {signal: s.abort.signal}); }
    catch (err) { await writable.abort().catch(() => {}); throw err; }
  } else {
    const blob = await response.blob(); ensure(s); download(blob, `local-vault-${new Date().toISOString().slice(0,10)}.lvbak`);
  }
  ensure(s); message('Encrypted backup exported. Keep it on another device with your password stored separately.');
}));
$('import').addEventListener('change', () => {
  pendingImport = $('import').files[0] || null; $('import').value = '';
  if (pendingImport) { $('backup-password').value = ''; $('import-dialog').showModal(); $('backup-password').focus(); }
});
$('cancel-import').onclick = () => {pendingImport = null; $('backup-password').value = ''; $('import-dialog').close();};
$('import-form').addEventListener('submit', event => {
  event.preventDefault();
  task(async () => {
    const s = session, file = pendingImport;
    let password = $('backup-password').value; $('backup-password').value = '';
    if (!file) throw Error('Select a backup first.');
    $('import-dialog').close(); pendingImport = null;
    const start = new Uint8Array(await file.slice(0,12).arrayBuffer()); ensure(s);
    if (start.length !== 12 || new TextDecoder().decode(start.slice(0,8)) !== 'LVBAK001') throw Error('Not a Local Vault backup.');
    const length = new DataView(start.buffer).getUint32(8);
    if (length > 16 * 1024 * 1024 || length + 12 > file.size) throw Error('Invalid backup header.');
    const header = JSON.parse(await file.slice(12,12+length).text());
    const config = header.state;
    const old = await derive(password, config.salt, config.iterations); password = ''; ensure(s);
    let imported;
    try { imported = await openIndex(old.key, config); }
    catch { throw Error('Wrong backup password or corrupted backup. Nothing was imported.'); }
    const positions = new Map(); let offset = 12 + length;
    if (!Array.isArray(header.files)) throw Error('Invalid backup file list.');
    for (const f of header.files) {
      if (typeof f.id !== 'string' || positions.has(f.id) || !Number.isSafeInteger(f.size) || f.size < 16 || f.size > MAX_FILE + 16) throw Error('Invalid backup file entry.');
      positions.set(f.id, {offset, size: f.size}); offset += f.size;
    }
    if (offset !== file.size) throw Error('Backup is incomplete or has trailing data. Nothing was imported.');
    const index = structuredClone(s.index);
    try {
      for (const note of imported.notes) {
        if (typeof note.title !== 'string' || typeof note.body !== 'string' || note.title.length > 1000 || note.body.length > 1000000) throw Error('Invalid backup note.');
        index.notes.push({id: crypto.randomUUID(), title: note.title, body: note.body, updated: new Date().toISOString()});
      }
      for (const f of imported.files) {
        const pos = positions.get(f.id);
        if (!pos || typeof f.name !== 'string' || f.name.length > 4096 || !Number.isSafeInteger(f.size) || f.size < 0 || pos.size !== f.size + 16) throw Error('Invalid backup attachment.');
        message(`Importing ${f.name}…`);
        const cipher = await file.slice(pos.offset, pos.offset + pos.size).arrayBuffer(); ensure(s);
        const plain = await decrypt(old.key, cipher, f.iv, fileAAD(config.vaultId, f.id)); ensure(s);
        const meta = await uploadBytes(s, f.name, plain, f.type); index.files.push(meta);
      }
      await save(s, index); render();
      message(`Imported ${imported.notes.length} note(s) and ${imported.files.length} file(s) as copies.`);
    } catch (error) {
      // Never remove uploads after an ambiguous commit: a lost response may hide a successful save.
      // An interrupted import may leave harmless unreferenced ciphertext, not lost content.
      throw error;
    }
  });
});
$('new-note').onclick = () => editNote();
$('search').addEventListener('input', render);
$('lock').onclick = lock;
for (const event of ['pointerdown','keydown','input','touchstart','wheel']) window.addEventListener(event, () => {
  const limit = Number($('idle').value) * 60000;
  if (session && Date.now() - lastActivity >= limit) lock();
  lastActivity = Date.now();
}, {passive: true, capture: true});
setInterval(() => {if (session && Date.now() - lastActivity >= Number($('idle').value) * 60000) lock();}, 1000);
window.addEventListener('pagehide', lock);
window.addEventListener('beforeunload', event => {if (dirty) {event.preventDefault(); event.returnValue = '';}});
document.addEventListener('visibilitychange', () => {if (session && Date.now() - lastActivity >= Number($('idle').value) * 60000) lock();});
init().catch(error => message(error.message));
