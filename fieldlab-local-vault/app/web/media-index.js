export const MEDIA_INDEX_VERSION = 2;

export function normalizeMediaIndex(data) {
  if (!data || typeof data !== 'object') throw Error('Invalid media index');
  if (data.version === 1 && Array.isArray(data.items)) {
    return {
      version: MEDIA_INDEX_VERSION,
      folders: [],
      items: data.items.map(it => ({...it, folderId: it.folderId ?? null})),
    };
  }
  if (data.version === MEDIA_INDEX_VERSION && Array.isArray(data.items) && Array.isArray(data.folders)) {
    const folders = data.folders.map(f => ({
      id: f.id,
      name: String(f.name || ''),
      parentId: f.parentId ?? null,
    }));
    const items = data.items.map(it => ({...it, folderId: it.folderId ?? null}));
    return {version: MEDIA_INDEX_VERSION, folders, items};
  }
  throw Error('Invalid media index');
}

export function ensureIndex(mediaSession) {
  if (!mediaSession?.index) throw Error('No media index');
  mediaSession.index = normalizeMediaIndex(mediaSession.index);
  return mediaSession.index;
}

export function createFolder(index, name, parentId = null) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw Error('Folder name required');
  if (parentId != null && !index.folders.some(f => f.id === parentId)) throw Error('Parent folder not found');
  const id = crypto.randomUUID();
  index.folders.push({id, name: trimmed, parentId: parentId ?? null});
  return id;
}

export function renameFolder(index, folderId, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw Error('Folder name required');
  const folder = index.folders.find(f => f.id === folderId);
  if (!folder) throw Error('Folder not found');
  folder.name = trimmed;
}

export function folderHasContents(index, folderId) {
  if (index.items.some(it => (it.folderId ?? null) === folderId)) return true;
  return index.folders.some(f => f.parentId === folderId);
}

/** Delete only when no child folders and no items (root cannot be deleted). */
export function deleteFolder(index, folderId) {
  if (folderId == null) throw Error('Cannot delete root');
  if (!index.folders.some(f => f.id === folderId)) throw Error('Folder not found');
  if (folderHasContents(index, folderId)) throw Error('Folder is not empty. Move or delete items and subfolders first.');
  index.folders = index.folders.filter(f => f.id !== folderId);
}

export function itemsInFolder(index, folderId) {
  const fid = folderId ?? null;
  return index.items.filter(it => (it.folderId ?? null) === fid);
}

export function folderChildren(index, parentId) {
  const pid = parentId ?? null;
  return index.folders.filter(f => (f.parentId ?? null) === pid);
}

export function folderBreadcrumb(index, folderId) {
  const trail = [];
  let cur = folderId ?? null;
  const guard = new Set();
  while (cur != null) {
    if (guard.has(cur)) break;
    guard.add(cur);
    const folder = index.folders.find(f => f.id === cur);
    if (!folder) break;
    trail.unshift(folder);
    cur = folder.parentId ?? null;
  }
  return trail;
}

export function findFolderByName(index, parentId, name) {
  const pid = parentId ?? null;
  return index.folders.find(f => (f.parentId ?? null) === pid && f.name === name) || null;
}

/** relativePath like Album/sub/file.jpg → folder id for Album/sub (parent of file). */
export function resolveOrCreateFolderPath(index, relativePath) {
  const parts = String(relativePath || '').split('/').filter(Boolean);
  if (parts.length <= 1) return null;
  const dirParts = parts.slice(0, -1);
  let parentId = null;
  for (const part of dirParts) {
    let child = findFolderByName(index, parentId, part);
    if (!child) parentId = createFolder(index, part, parentId);
    else parentId = child.id;
  }
  return parentId;
}

export function remapFoldersOnImport(index, idMap) {
  for (const folder of index.folders) {
    if (idMap[folder.id]) folder.id = idMap[folder.id];
    if (folder.parentId && idMap[folder.parentId]) folder.parentId = idMap[folder.parentId];
  }
  for (const item of index.items) {
    if (item.folderId && idMap[item.folderId]) item.folderId = idMap[item.folderId];
  }
}

export function cloneFoldersWithNewIds(folders) {
  const idMap = {};
  for (const f of folders) idMap[f.id] = crypto.randomUUID();
  const out = folders.map(f => ({
    id: idMap[f.id],
    name: f.name,
    parentId: f.parentId ? idMap[f.parentId] ?? null : null,
  }));
  return {folders: out, idMap};
}

export function moveItemsToFolder(index, itemIds, targetFolderId) {
  if (targetFolderId != null && !index.folders.some(f => f.id === targetFolderId)) {
    throw Error('Target folder not found');
  }
  const set = new Set(itemIds);
  for (const item of index.items) {
    if (set.has(item.id)) item.folderId = targetFolderId ?? null;
  }
}