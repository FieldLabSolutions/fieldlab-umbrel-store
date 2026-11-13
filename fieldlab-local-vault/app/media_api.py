"""Photos & Videos vault: ciphertext blobs under data/media/ (stdlib only)."""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import struct
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

_MEDIA_LOCK = threading.RLock()
_EXPORT_TOKENS = {}
_ID = re.compile(r'^[0-9a-f-]{36}$')
_CHUNK = re.compile(r'^/api/media/items/([0-9a-f-]{36})/chunks/([0-9]+)$')
_THUMB = re.compile(r'^/api/media/items/([0-9a-f-]{36})/thumb$')
_MAGIC = b'LVMEDIA01'
_MAX_INDEX = 8 * 1024 * 1024
_CHUNK_PLAIN = 4 * 1024 * 1024
_MAX_THUMB = 512 * 1024 + 16


def media_paths(data: Path):
    root = data / 'media'
    return root, root / 'state.json', root / 'blobs'


def media_env_limits(data: Path):
    quota = int(os.environ.get('VAULT_MEDIA_QUOTA_BYTES', str(100 * 1024 ** 3)))
    min_free = int(os.environ.get('VAULT_MEDIA_MIN_DISK_FREE_BYTES', str(50 * 1024 ** 3)))
    max_item = int(os.environ.get('VAULT_MEDIA_MAX_ITEM_BYTES', str(4 * 1024 ** 3)))
    chunk_max = _CHUNK_PLAIN + 16
    return quota, min_free, max_item, chunk_max


def disk_ok(data: Path):
    _, min_free, _, _ = media_env_limits(data)
    return shutil.disk_usage(data).free >= min_free


def media_state(data: Path):
    _, state_path, _ = media_paths(data)
    if not state_path.is_file():
        return None
    return json.loads(state_path.read_bytes())


def validate_media_state(s, vault_id: str):
    keys = {
        'version', 'vaultId', 'salt', 'iterations', 'wrapIv', 'wrappedKey',
        'authHash', 'revision', 'indexIv', 'indexCiphertext', 'usedBytes',
    }
    if set(s) != keys:
        raise ValueError('Invalid media format')
    if s['version'] != 1 or s['vaultId'] != vault_id or s['iterations'] != 600000:
        raise ValueError('Unsupported media format')
    for field, n in (('salt', 32), ('wrapIv', 12), ('indexIv', 12), ('authHash', 32)):
        b = base64.b64decode(s[field], validate=True)
        if len(b) != n:
            raise ValueError('Invalid media encoding')
    if len(base64.b64decode(s['wrappedKey'], validate=True)) < 16:
        raise ValueError('Invalid wrapped key')
    ct = base64.b64decode(s['indexCiphertext'], validate=True)
    if not 16 <= len(ct) <= _MAX_INDEX:
        raise ValueError('Invalid media index')
    if type(s['revision']) is not int or s['revision'] < 1:
        raise ValueError('Invalid revision')
    if type(s['usedBytes']) is not int or s['usedBytes'] < 0:
        raise ValueError('Invalid usedBytes')


def atomic_media_state(data: Path, s):
    root, state_path, _ = media_paths(data)
    root.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(s, separators=(',', ':')).encode()
    fd, name = tempfile.mkstemp(prefix='.media-state-', dir=root)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, state_path)
        d = os.open(root, os.O_RDONLY)
        try:
            os.fsync(d)
        finally:
            os.close(d)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def media_blob_dir(data: Path, item_id: str) -> Path:
    if not _ID.fullmatch(item_id):
        raise ValueError('Invalid item ID')
    return media_paths(data)[2] / item_id


def chunk_path(data: Path, item_id: str, index: int) -> Path:
    if index < 0 or index > 1_000_000:
        raise ValueError('Invalid chunk index')
    return media_blob_dir(data, item_id) / f'{index}.bin'


def thumb_path(data: Path, item_id: str) -> Path:
    return media_blob_dir(data, item_id) / 'thumb.bin'


def max_item_ciphertext(max_item: int) -> int:
    chunks = (max_item + _CHUNK_PLAIN - 1) // _CHUNK_PLAIN
    return max_item + chunks * 16


def item_data_bytes(data: Path, item_id: str) -> int:
    item_dir = media_blob_dir(data, item_id)
    if not item_dir.is_dir():
        return 0
    total = 0
    for path in item_dir.iterdir():
        if path.name == 'thumb.bin':
            total += path.stat().st_size
        elif path.name.endswith('.bin') and path.name[:-4].isdigit():
            total += path.stat().st_size
    return total


def media_used_bytes(data: Path) -> int:
    _, _, blobs = media_paths(data)
    total = 0
    if blobs.is_dir():
        for p in blobs.rglob('*.bin'):
            total += p.stat().st_size
    return total


def reconcile_used_bytes(data: Path, s):
    actual = media_used_bytes(data)
    if s['usedBytes'] != actual:
        s = {**s, 'usedBytes': actual}
        atomic_media_state(data, s)
    return s


def parse_media_token(headers):
    raw = headers.get('X-Media-Authorization', '')
    return raw[7:] if raw.startswith('Bearer ') else headers.get('X-Media-Token', '')


def media_auth(data: Path, main_state, headers, reply_fn):
    if not main_state:
        reply_fn(401, {'error': 'Wrong password or locked vault'})
        return None
    ms = media_state(data)
    if not ms:
        reply_fn(404, {'error': 'Media not initialized'})
        return None
    supplied = parse_media_token(headers)
    digest = base64.b64encode(hashlib.sha256(supplied.encode()).digest()).decode()
    if not hmac.compare_digest(digest, ms['authHash']):
        time.sleep(0.35)
        reply_fn(401, {'error': 'Wrong media password or locked area'})
        return None
    return ms


def parse_range(header: str, total: int):
    if not header or not header.startswith('bytes='):
        return None
    spec = header[6:].split(',')[0].strip()
    if '-' not in spec:
        return None
    start_s, end_s = spec.split('-', 1)
    if start_s == '':
        if not end_s.isdigit():
            return None
        suffix = int(end_s)
        if suffix <= 0:
            return None
        start = max(0, total - suffix)
        return start, total - 1
    start = int(start_s)
    end = total - 1 if end_s == '' else int(end_s)
    if start < 0 or end < start or start >= total:
        return None
    return start, min(end, total - 1)


def stream_file_with_range(handler, path: Path, range_header: str | None):
    total = path.stat().st_size
    rng = parse_range(range_header, total) if range_header else None
    if range_header and rng is None:
        handler.send_response(416)
        handler.send_header('Content-Range', f'bytes */{total}')
        handler.send_header('Content-Length', '0')
        handler.send_header('Accept-Ranges', 'bytes')
        handler.send_header('Connection', 'close')
        handler.end_headers()
        return
    start, end = rng if rng else (0, total - 1)
    length = end - start + 1
    status = 206 if rng else 200
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/octet-stream')
    handler.send_header('Content-Length', str(length))
    handler.send_header('Accept-Ranges', 'bytes')
    if rng:
        handler.send_header('Content-Range', f'bytes {start}-{end}/{total}')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    handler.send_header('Connection', 'close')
    handler.end_headers()
    with path.open('rb') as f:
        f.seek(start)
        remaining = length
        while remaining > 0:
            data = f.read(min(1024 * 1024, remaining))
            if not data:
                break
            handler.wfile.write(data)
            remaining -= len(data)


def prune_export_tokens():
    now = time.time()
    for tok in list(_EXPORT_TOKENS):
        if _EXPORT_TOKENS[tok]['expires'] < now:
            del _EXPORT_TOKENS[tok]


def media_export_stream(handler, data: Path, ms):
    prune_export_tokens()
    files = []
    _, _, blobs = media_paths(data)
    if blobs.is_dir():
        for item_dir in sorted(blobs.iterdir()):
            if not item_dir.is_dir() or not _ID.fullmatch(item_dir.name):
                continue
            thumb = item_dir / 'thumb.bin'
            if thumb.is_file():
                files.append({
                    'itemId': item_dir.name,
                    'kind': 'thumb',
                    'size': thumb.stat().st_size,
                    'path': str(thumb.relative_to(data)),
                })
            for chunk in sorted(item_dir.glob('*.bin')):
                if not chunk.name[:-4].isdigit():
                    continue
                files.append({
                    'itemId': item_dir.name,
                    'kind': 'chunk',
                    'chunk': int(chunk.name[:-4]),
                    'size': chunk.stat().st_size,
                    'path': str(chunk.relative_to(data)),
                })
    meta = json.dumps({
        'state': {k: v for k, v in ms.items() if k != 'authHash'},
        'files': files,
    }, separators=(',', ':')).encode()
    handler.send_response(200)
    handler.send_header('Content-Type', 'application/octet-stream')
    handler.send_header('Content-Disposition', 'attachment; filename="fieldlab-vault.lvmedia"')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    handler.send_header('Connection', 'close')
    handler.end_headers()
    handler.wfile.write(_MAGIC + struct.pack('>I', len(meta)) + meta)
    for entry in files:
        with (data / entry['path']).open('rb') as f:
            while block := f.read(1024 * 1024):
                handler.wfile.write(block)


def handle_media_get(handler, data: Path, main_state, path: str, headers, reply_fn):
    query = ''
    if '?' in handler.path:
        path, query = handler.path.split('?', 1)
    if path == '/api/media/status':
        with _MEDIA_LOCK:
            ms = media_state(data)
            quota, min_free, max_item, _ = media_env_limits(data)
            free = shutil.disk_usage(data).free
            reply_fn(200, {
                'initialized': bool(ms),
                'uploadAllowed': disk_ok(data),
                'diskFreeBytes': free,
                'quotaBytes': quota,
                'maxItemBytes': max_item,
                'minDiskFreeBytes': min_free,
                **({k: ms[k] for k in ('version', 'vaultId', 'salt', 'iterations', 'revision', 'usedBytes')} if ms else {}),
            })
            return True
    if path == '/api/media/vault':
        with _MEDIA_LOCK:
            ms = media_state(data)
            if not ms:
                reply_fn(404, {'error': 'Media not initialized'})
                return True
            ms = media_auth(data, main_state, headers, reply_fn)
            if not ms:
                return True
            ms = reconcile_used_bytes(data, ms)
            reply_fn(200, {k: v for k, v in ms.items() if k != 'authHash'})
            return True
    m = _CHUNK.match(path)
    if m:
        item_id, index_s = m.groups()
        index = int(index_s)
        with _MEDIA_LOCK:
            if not media_auth(data, main_state, headers, reply_fn):
                return
            blob = chunk_path(data, item_id, index)
            if not blob.is_file():
                return reply_fn(404, {'error': 'Chunk missing'})
        stream_file_with_range(handler, blob, headers.get('Range'))
        return True
    t = _THUMB.match(path)
    if t:
        item_id = t.group(1)
        with _MEDIA_LOCK:
            if not media_auth(data, main_state, headers, reply_fn):
                return True
            blob = thumb_path(data, item_id)
            if not blob.is_file():
                reply_fn(404, {'error': 'Thumbnail missing'})
                return True
        stream_file_with_range(handler, blob, headers.get('Range'))
        return True
    if path.startswith('/api/media/export/'):
        token = path.removeprefix('/api/media/export/')
        if not token or len(token) > 64:
            reply_fn(400, {'error': 'Invalid export token'})
            return True
        with _MEDIA_LOCK:
            if not media_auth(data, main_state, headers, reply_fn):
                return True
            entry = _EXPORT_TOKENS.pop(token, None)
            if not entry or entry['expires'] < time.time():
                reply_fn(404, {'error': 'Export link expired or already used'})
                return True
            ms = media_state(data)
            if not ms:
                reply_fn(404, {'error': 'Media not initialized'})
                return True
        media_export_stream(handler, data, ms)
        return True
    return False


def handle_media_post(handler, data: Path, main_state, path: str, headers, read_json, reply_fn):
    if path == '/api/media/setup':
        body = read_json()
        validate_media_state(body, main_state['vaultId'])
        if body['revision'] != 1:
            raise ValueError('Invalid initial revision')
        if not disk_ok(data):
            return reply_fn(507, {'error': 'Insufficient disk space for media uploads'})
        with _MEDIA_LOCK:
            if media_state(data):
                return reply_fn(409, {'error': 'Media already initialized'})
            atomic_media_state(data, body)
        return reply_fn(201, {'revision': 1})
    if path == '/api/media/export':
        with _MEDIA_LOCK:
            if not media_auth(data, main_state, headers, reply_fn):
                return
            if not media_state(data):
                return reply_fn(404, {'error': 'Media not initialized'})
            prune_export_tokens()
            token = secrets.token_urlsafe(32)
            _EXPORT_TOKENS[token] = {'expires': time.time() + 300}
        return reply_fn(200, {'token': token, 'url': f'/api/media/export/{token}', 'expiresIn': 300})
    m = re.match(r'^/api/media/items/([0-9a-f-]{36})/commit$', path)
    if m:
        item_id = m.group(1)
        body = read_json()
        chunk_count = body.get('chunkCount')
        plaintext_size = body.get('plaintextSize')
        if type(chunk_count) is not int or chunk_count < 1 or chunk_count > 1_000_000:
            raise ValueError('Invalid chunk count')
        _, _, max_item, _ = media_env_limits(data)
        if type(plaintext_size) is not int or not 1 <= plaintext_size <= max_item:
            return reply_fn(413, {'error': 'Item exceeds maximum size'})
        expected = (plaintext_size + _CHUNK_PLAIN - 1) // _CHUNK_PLAIN
        if chunk_count != expected:
            return reply_fn(400, {'error': 'Chunk count mismatch'})
        with _MEDIA_LOCK:
            if not media_auth(data, main_state, headers, reply_fn):
                return
            for i in range(chunk_count):
                if not chunk_path(data, item_id, i).is_file():
                    return reply_fn(400, {'error': 'Upload incomplete'})
            ms = reconcile_used_bytes(data, media_state(data))
        return reply_fn(200, {'ok': True, 'usedBytes': ms['usedBytes']})
    return False


def handle_media_put(handler, data: Path, main_state, path: str, headers, reply_fn):
    m = _THUMB.match(path)
    if m:
        item_id = m.group(1)
        n = int(headers.get('Content-Length', '-1'))
        if not 16 <= n <= _MAX_THUMB:
            return reply_fn(413, {'error': 'Thumbnail too large'})
        with _MEDIA_LOCK:
            if not media_auth(data, main_state, headers, reply_fn):
                return True
            if not disk_ok(data):
                return reply_fn(507, {'error': 'Insufficient disk space'})
            ms = reconcile_used_bytes(data, media_state(data))
            quota, _, max_item, _ = media_env_limits(data)
            prior = item_data_bytes(data, item_id)
            thumb = thumb_path(data, item_id)
            prior -= thumb.stat().st_size if thumb.is_file() else 0
            if prior + n > max_item_ciphertext(max_item):
                return reply_fn(413, {'error': 'Item exceeds maximum size'})
            if ms['usedBytes'] + n > quota:
                return reply_fn(413, {'error': 'Media quota exceeded'})
            media_blob_dir(data, item_id).mkdir(parents=True, exist_ok=True)
            if thumb.exists():
                return reply_fn(409, {'error': 'Thumbnail already uploaded'})
            fd, temp = tempfile.mkstemp(prefix='.thumb-', dir=media_blob_dir(data, item_id))
            try:
                with os.fdopen(fd, 'wb') as f:
                    remaining = n
                    while remaining:
                        block = handler.rfile.read(min(1024 * 1024, remaining))
                        if not block:
                            raise ValueError('Incomplete upload')
                        f.write(block)
                        remaining -= len(block)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(temp, thumb)
                temp = None
                ms = reconcile_used_bytes(data, ms)
            finally:
                if temp and os.path.exists(temp):
                    os.unlink(temp)
        return reply_fn(201, {'ok': True, 'usedBytes': ms['usedBytes']})
    m = _CHUNK.match(path)
    if not m:
        return False
    item_id, index_s = m.groups()
    index = int(index_s)
    _, _, max_item, chunk_max = media_env_limits(data)
    n = int(headers.get('Content-Length', '-1'))
    if not 16 <= n <= chunk_max:
        return reply_fn(413, {'error': 'Chunk too large'})
    with _MEDIA_LOCK:
        ms = media_auth(data, main_state, headers, reply_fn)
        if not ms:
            return True
        if not disk_ok(data):
            return reply_fn(507, {'error': 'Insufficient disk space'})
        ms = reconcile_used_bytes(data, media_state(data))
        quota, _, _, _ = media_env_limits(data)
        prior = item_data_bytes(data, item_id)
        dest = chunk_path(data, item_id, index)
        if dest.exists():
            prior -= dest.stat().st_size
        if prior + n > max_item_ciphertext(max_item):
            return reply_fn(413, {'error': 'Item exceeds maximum size'})
        if ms['usedBytes'] + n > quota:
            return reply_fn(413, {'error': 'Media quota exceeded'})
        item_dir = media_blob_dir(data, item_id)
        item_dir.mkdir(parents=True, exist_ok=True)
        dest = chunk_path(data, item_id, index)
        if dest.exists():
            return reply_fn(409, {'error': 'Chunk already uploaded'})
        fd, temp = tempfile.mkstemp(prefix='.chunk-', dir=item_dir)
        try:
            with os.fdopen(fd, 'wb') as f:
                remaining = n
                while remaining:
                    block = handler.rfile.read(min(1024 * 1024, remaining))
                    if not block:
                        raise ValueError('Incomplete upload')
                    f.write(block)
                    remaining -= len(block)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp, dest)
            temp = None
            ms = reconcile_used_bytes(data, ms)
        finally:
            if temp and os.path.exists(temp):
                os.unlink(temp)
    return reply_fn(201, {'ok': True, 'usedBytes': ms['usedBytes']})


def handle_media_delete(handler, data: Path, main_state, path: str, headers, reply_fn):
    m = re.match(r'^/api/media/items/([0-9a-f-]{36})$', path)
    if not m:
        return False
    item_id = m.group(1)
    with _MEDIA_LOCK:
        if not media_auth(data, main_state, headers, reply_fn):
            return True
        item_dir = media_blob_dir(data, item_id)
        if item_dir.is_dir():
            shutil.rmtree(item_dir)
        ms = media_state(data)
        if ms:
            reconcile_used_bytes(data, ms)
    return reply_fn(200, {'ok': True})


def handle_media_put_vault(handler, data: Path, main_state, path: str, headers, read_json, reply_fn):
    if path != '/api/media/vault':
        return False
    with _MEDIA_LOCK:
        old = media_auth(data, main_state, headers, reply_fn)
        if not old:
            return True
    new = read_json()
    new['authHash'] = old['authHash']
    validate_media_state(new, main_state['vaultId'])
    with _MEDIA_LOCK:
        latest = media_state(data)
        if new['revision'] != latest['revision'] + 1:
            return reply_fn(409, {'error': 'Media changed in another tab. Lock and retry.'})
        for key in ('vaultId', 'salt', 'iterations'):
            if new[key] != latest[key]:
                raise ValueError('Immutable media configuration')
        atomic_media_state(data, {**new, 'usedBytes': media_used_bytes(data)})
    return reply_fn(200, {'revision': new['revision']})
