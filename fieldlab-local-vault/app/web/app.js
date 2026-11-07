import {ITERATIONS, MAX_FILE, b64, unb64, random, derive, authHash, encrypt, decrypt, sealIndex, openIndex, migrateIndexToV2, fileAAD} from './crypto.js';
const $ = id => document.getElementById(id);
let setup = false, session = null, busy = false, pendingImport = null, generation = 0;
let lastActivity = Date.now(), dirty = false;
let editingNoteId = null, editingAttachment = null;
const urls = new Set();
const message = text => { $('message').textContent = text; };
const ensure = s => {
  if (!s) throw Error('Vault locked. Unlock to continue.');
  if (session && session !== s) throw Error('Vault locked. Unlock to continue.');
};
const formatMiB = size => `${(size / 1048576).toFixed(2)} MiB`;
function controls() {
  document.querySelectorAll('#workspace button, #workspace input, #workspace select, #import-form button, #attachment-form button').forEach(e => {e.disabled = busy;});
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
  $('notes').replaceChildren(); $('editor').replaceChildren();
  $('search').value = ''; $('password').value = ''; $('confirm-password').value = ''; $('backup-password').value = '';
  { const el = document.getElementById('note-attach'); if (el) el.value = ''; }
  $('import').value = '';
  if ($('import-dialog').open) $('import-dialog').close();
  if ($('attachment-dialog').open) $('attachment-dialog').close();
  pendingImport = null; editingNoteId = null; editingAttachment = null;
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
function noteHaystack(note) {
  const parts = [note.title, note.body];
  for (const a of note.attachments || []) parts.push(a.label, a.description, a.name);
  return parts.join('\n').toLocaleLowerCase();
}
function allAttachments(index) {
  return index.notes.flatMap(n => n.attachments || []);
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
      index = {version: 2, notes: []};
      const box = await sealIndex(s.key, index, config.vaultId);
      const envelope = {...config, ...box, revision: 1, authHash: await authHash(s.token)};
      await api('/api/setup', {method: 'POST', body: JSON.stringify(envelope)}, null);
      s.revision = 1; setup = false;
      $('confirm-wrap').hidden = true; $('confirm-password').required = false;
      $('gate-title').textContent = 'Unlock your vault'; $('unlock-submit').textContent = 'Unlock';
      $('gate-help').textContent = 'Your password and decrypted content stay in this browser tab.';
    } else {
      const envelope = await (await api('/api/vault', {}, s)).json();
      let opened;
      try { opened = await openIndex(s.key, envelope); }
      catch { throw Error('Unable to decrypt: wrong password or damaged vault.'); }
      const migrated = migrateIndexToV2(opened);
      index = migrated.index;
      s.revision = envelope.revision;
      if (migrated.changed) {
        await save(s, index);
        message('Vault index upgraded: files now live inside notes.');
      }
    }
    if (generation !== stamp) {s.abort.abort(); return;}
    s.index = index; session = s; dirty = false; lastActivity = Date.now();
    $('gate').hidden = true; $('workspace').hidden = false; $('lock').hidden = false;
    render();
    if (!setup) message('Unlocked. Auto-lock is on. Export an encrypted backup after changes.');
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
  const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = cls;
  b.addEventListener('click', handler); return b;
}
function render() {
  const s = session; if (!s) return;
  const query = $('search').value.toLocaleLowerCase();
  $('notes').replaceChildren();
  for (const note of s.index.notes.filter(n => !query || noteHaystack(n).includes(query))) {
    const label = note.title || 'Untitled note';
    const count = note.attachments?.length || 0;
    const title = count ? `${label} (${count})` : label;
    $('notes').append(button(title, () => editNote(note.id), 'item'));
  }
  if (!s.index.notes.length) $('notes').textContent = 'No notes yet.';
}
function currentNoteInIndex(noteId) {
  return session.index.notes.find(n => n.id === noteId);
}
function persistNote(note) {
  const s = session; ensure(s);
  const index = structuredClone(s.index);
  const pos = index.notes.findIndex(n => n.id === note.id);
  const entry = {id: note.id, title: note.title, body: note.body, updated: new Date().toISOString(), attachments: structuredClone(note.attachments || [])};
  if (pos < 0) index.notes.push(entry); else index.notes[pos] = entry;
  return save(s, index);
}
function renderAttachments(container, note) {
  container.replaceChildren();
  const heading = document.createElement('h3'); heading.textContent = 'Attachments'; container.append(heading);
  if (!note.attachments.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No files attached to this note yet.';
    container.append(empty); return;
  }
  for (const att of note.attachments) {
    const row = document.createElement('div'); row.className = 'note-attachment';
    const title = document.createElement('strong'); title.textContent = att.label || att.name;
    const desc = document.createElement('p'); desc.className = 'muted attachment-desc'; desc.textContent = att.description || '(no description)';
    const meta = document.createElement('small'); meta.textContent = `${att.name} · ${formatMiB(att.size)}`;
    const actions = document.createElement('div'); actions.className = 'attachment-actions';
    actions.append(
      button('Download', () => task(() => downloadAttachment(att)), ''),
      button('Edit', () => openAttachmentEditor(note.id, att.id), ''),
      button('Delete', () => task(() => deleteAttachment(note.id, att.id)), 'danger')
    );
    row.append(title, desc, meta, actions);
    container.append(row);
  }
}
function openAttachmentEditor(noteId, attachmentId) {
  const note = currentNoteInIndex(noteId);
  const att = note?.attachments?.find(a => a.id === attachmentId);
  if (!att) return;
  editingAttachment = {noteId, attachmentId};
  $('attachment-label').value = att.label;
  $('attachment-description').value = att.description;
  $('attachment-dialog').showModal();
  $('attachment-label').focus();
}
function editNote(id = null) {
  if (busy) return;
  if (dirty && !confirm('Discard unsaved edits to this note?')) return;
  const note = id ? structuredClone(currentNoteInIndex(id)) : {id: crypto.randomUUID(), title: '', body: '', attachments: []};
  if (!note) return;
  if (!note.attachments) note.attachments = [];
  editingNoteId = note.id;
  $('editor').replaceChildren();
  const heading = document.createElement('h2'); heading.textContent = id ? 'Edit note' : 'New note';
  const title = document.createElement('input'); title.id = 'note-title'; title.placeholder = 'Note title'; title.ariaLabel = 'Note title'; title.value = note.title; title.maxLength = 1000;
  const body = document.createElement('textarea'); body.id = 'note-body'; body.placeholder = 'Write something private…'; body.ariaLabel = 'Note text'; body.value = note.body; body.maxLength = 1000000;
  title.addEventListener('input', () => {dirty = true;}); body.addEventListener('input', () => {dirty = true;});
  const attachWrap = document.createElement('label'); attachWrap.className = 'button'; attachWrap.textContent = 'Attach file';
  const attachInput = document.createElement('input'); attachInput.type = 'file'; attachInput.id = 'note-attach'; attachInput.multiple = true; attachInput.hidden = true;
  attachWrap.append(attachInput);
  attachInput.addEventListener('change', () => {
    const files = [...attachInput.files]; attachInput.value = '';
    if (!files.length) return;
    task(async () => {
      const s = session; ensure(s);
      let current = structuredClone(currentNoteInIndex(editingNoteId) || note);
      if (!current.attachments) current.attachments = [];
      for (const file of files) {
        if (file.size > MAX_FILE) throw Error(`${file.name}: exceeds 128 MiB.`);
        message(`Encrypting ${file.name}…`);
        const meta = await uploadBytes(s, file.name, await file.arrayBuffer(), file.type);
        current.attachments.push({id: meta.id, label: file.name, description: '', name: meta.name, type: meta.type, size: meta.size, iv: meta.iv, added: meta.added});
      }
      current.title = title.value; current.body = body.value;
      await persistNote(current);
      editingNoteId = current.id; dirty = false;
      render();
      const list = document.getElementById('note-attachments');
      if (list) renderAttachments(list, currentNoteInIndex(editingNoteId));
      message(files.length === 1 ? 'File attached.' : `${files.length} files attached.`);
    });
  });
  const attachments = document.createElement('div'); attachments.id = 'note-attachments';
  renderAttachments(attachments, structuredClone(currentNoteInIndex(note.id) || note));
  const hint = document.createElement('p'); hint.className = 'muted'; hint.textContent = 'Save the note text with Save note. Attachments are stored when you attach or edit them. Locking discards unsaved title/body text.';
  const saveBtn = button('Save note', () => task(async () => {
    const s = session; ensure(s);
    const current = structuredClone(currentNoteInIndex(editingNoteId) || note);
    current.title = title.value; current.body = body.value;
    await persistNote(current); dirty = false; render(); message('Note saved.');
  }));
  $('editor').append(heading, title, body, attachWrap, attachments, saveBtn, hint);
  if (id) $('editor').append(button('Delete note', () => task(async () => {
    if (!confirm('Permanently delete this note and its attachments? Existing exported backups are not changed.')) return;
    const s = session; ensure(s);
    const existing = currentNoteInIndex(id);
    for (const att of existing?.attachments || []) await api(`/api/files/${att.id}`, {method: 'DELETE'}, s).catch(() => {});
    const index = structuredClone(s.index); index.notes = index.notes.filter(n => n.id !== id);
    await save(s, index); dirty = false; editingNoteId = null; $('editor').replaceChildren(); render(); message('Note deleted.');
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
function download(blob, name) {
  const url = URL.createObjectURL(blob); urls.add(url);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => {URL.revokeObjectURL(url); urls.delete(url);}, 30000);
}
async function downloadAttachment(att) {
  const s = session; message('Decrypting file…');
  const bytes = await (await api(`/api/files/${att.id}`, {}, s)).arrayBuffer(); ensure(s);
  let plain;
  try { plain = await decrypt(s.key, bytes, att.iv, fileAAD(s.config.vaultId, att.id)); }
  catch { throw Error('File integrity check failed. Nothing was downloaded.'); }
  ensure(s);
  download(new Blob([plain], {type: 'application/octet-stream'}), att.name);
  message('File downloaded. The downloaded copy is NOT encrypted; protect or remove it yourself.');
}
async function deleteAttachment(noteId, attachmentId) {
  const note = currentNoteInIndex(noteId);
  const att = note?.attachments?.find(a => a.id === attachmentId);
  if (!att) return;
  if (!confirm(`Permanently delete attachment “${att.label || att.name}”?`)) return;
  const s = session; ensure(s);
  const current = structuredClone(note);
  current.attachments = current.attachments.filter(a => a.id !== attachmentId);
  await persistNote(current);
  await api(`/api/files/${attachmentId}`, {method: 'DELETE'}, s); ensure(s);
  render();
  if (editingNoteId === noteId) {
    const list = document.getElementById('note-attachments');
    if (list) renderAttachments(list, currentNoteInIndex(noteId));
  }
  message('Attachment deleted.');
}
$('attachment-form').addEventListener('submit', event => {
  event.preventDefault();
  task(async () => {
    if (!editingAttachment) return;
    const {noteId, attachmentId} = editingAttachment;
    const note = currentNoteInIndex(noteId);
    const att = note?.attachments?.find(a => a.id === attachmentId);
    if (!att) return;
    const label = $('attachment-label').value.trim();
    if (!label) throw Error('Label cannot be empty.');
    const current = structuredClone(note);
    const pos = current.attachments.findIndex(a => a.id === attachmentId);
    current.attachments[pos] = {...att, label, description: $('attachment-description').value.trim()};
    await persistNote(current);
    $('attachment-dialog').close();
    editingAttachment = null;
    $('attachment-label').value = ''; $('attachment-description').value = '';
    render();
    if (editingNoteId === noteId) {
      const list = document.getElementById('note-attachments');
      if (list) renderAttachments(list, currentNoteInIndex(noteId));
    }
    message('Attachment details saved.');
  });
});
$('cancel-attachment-edit').onclick = () => {
  editingAttachment = null;
  $('attachment-label').value = ''; $('attachment-description').value = '';
  $('attachment-dialog').close();
};
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
    let opened;
    try { opened = await openIndex(old.key, config); }
    catch { throw Error('Wrong backup password or corrupted backup. Nothing was imported.'); }
    const {index: importedIndex} = migrateIndexToV2(opened);
    const positions = new Map(); let offset = 12 + length;
    if (!Array.isArray(header.files)) throw Error('Invalid backup file list.');
    for (const f of header.files) {
      if (typeof f.id !== 'string' || positions.has(f.id) || !Number.isSafeInteger(f.size) || f.size < 16 || f.size > MAX_FILE + 16) throw Error('Invalid backup file entry.');
      positions.set(f.id, {offset, size: f.size}); offset += f.size;
    }
    if (offset !== file.size) throw Error('Backup is incomplete or has trailing data. Nothing was imported.');
    const index = structuredClone(s.index);
    let attachmentTotal = 0;
    try {
      for (const note of importedIndex.notes) {
        if (typeof note.title !== 'string' || typeof note.body !== 'string' || note.title.length > 1000 || note.body.length > 1000000) throw Error('Invalid backup note.');
        const copy = {id: crypto.randomUUID(), title: note.title, body: note.body, updated: new Date().toISOString(), attachments: []};
        for (const att of note.attachments || []) {
          const pos = positions.get(att.id);
          if (!pos || typeof att.name !== 'string' || att.name.length > 4096 || !Number.isSafeInteger(att.size) || att.size < 0 || pos.size !== att.size + 16) throw Error('Invalid backup attachment.');
          message(`Importing ${att.name}…`);
          const cipher = await file.slice(pos.offset, pos.offset + pos.size).arrayBuffer(); ensure(s);
          const plain = await decrypt(old.key, cipher, att.iv, fileAAD(config.vaultId, att.id)); ensure(s);
          const meta = await uploadBytes(s, att.name, plain, att.type || 'application/octet-stream');
          copy.attachments.push({
            id: meta.id, label: att.label || att.name, description: att.description || '', name: att.name,
            type: att.type || meta.type, size: meta.size, iv: meta.iv, added: new Date().toISOString()
          });
          attachmentTotal++;
        }
        index.notes.push(copy);
      }
      await save(s, index); render();
      message(`Imported ${importedIndex.notes.length} note(s) and ${attachmentTotal} attachment(s) as copies.`);
    } catch (error) {
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
