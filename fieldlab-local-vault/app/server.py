#!/usr/bin/env python3
"""Field Lab Local Vault: ciphertext storage only; Python stdlib server."""
import base64
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import ssl
import struct
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('VAULT_DATA', '/data'))
HTTP_PORT = int(os.environ.get('VAULT_HTTP_PORT', '8080'))
HTTPS_PORT = int(os.environ.get('VAULT_HTTPS_PORT', os.environ.get('VAULT_PORT', '8449')))
HTTPS_BIND = os.environ.get('VAULT_BIND', '0.0.0.0')
CERT_PATH = Path(os.environ.get('VAULT_CERT', '/cert/tls.crt'))
KEY_PATH = Path(os.environ.get('VAULT_KEY', '/cert/tls.key'))
CONFIGURED_ORIGIN = os.environ.get('VAULT_ORIGIN', '').strip()
LOCK = threading.RLock()
MAGIC = b'LVBAK001'
MAX_FILE = 128 * 1024 * 1024 + 16
MAX_INDEX = 8 * 1024 * 1024
ID = re.compile(r'^[0-9a-f-]{36}$')
# Top-level document navigations from the HTTP landing page (different port) use cross-site fetches.
NAV_STATIC_PATHS = frozenset({
    '/', '/index.html', '/app.js', '/crypto.js', '/style.css',
    '/favicon.ico', '/favicon-32x32.png', '/apple-touch-icon.png',
})
FAVICON_LINKS = (
    '<link rel="icon" href="/favicon.ico" sizes="any">'
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">'
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">'
)
FAVICON_STATIC = {
    '/favicon.ico': ('favicon.ico', 'image/x-icon'),
    '/favicon-32x32.png': ('favicon-32x32.png', 'image/png'),
    '/apple-touch-icon.png': ('apple-touch-icon.png', 'image/png'),
}

LANDING_STYLE = """\
body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#111}
h1{font-size:1.4rem}code,pre{font-family:ui-monospace,monospace;font-size:.9rem}
a.button{display:inline-block;margin:1rem 0;padding:.6rem 1rem;background:#1a4;color:#fff;text-decoration:none;border-radius:6px}
.muted{color:#555;font-size:.95rem}footer{margin-top:2rem;font-size:.85rem;color:#666}
"""


def encoded(value, length=None):
    if not isinstance(value, str):
        raise ValueError('Invalid encoding')
    b = base64.b64decode(value, validate=True)
    if length is not None and len(b) != length:
        raise ValueError('Invalid length')
    return b


def validate_state(s):
    if set(s) != {'version', 'vaultId', 'salt', 'iterations', 'iv', 'ciphertext', 'authHash', 'revision'}:
        raise ValueError('Invalid vault format')
    if s['version'] != 1 or not ID.fullmatch(s['vaultId']) or s['iterations'] != 600000:
        raise ValueError('Unsupported vault format')
    encoded(s['salt'], 32)
    encoded(s['iv'], 12)
    encoded(s['authHash'], 32)
    if not 16 <= len(encoded(s['ciphertext'])) <= MAX_INDEX:
        raise ValueError('Invalid encrypted index')
    if type(s['revision']) is not int or s['revision'] < 1:
        raise ValueError('Invalid revision')


def state():
    p = DATA / 'state.json'
    return json.loads(p.read_bytes()) if p.exists() else None


def atomic_state(s):
    raw = json.dumps(s, separators=(',', ':')).encode()
    fd, name = tempfile.mkstemp(prefix='.state-', dir=DATA)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, DATA / 'state.json')
        d = os.open(DATA, os.O_RDONLY)
        try:
            os.fsync(d)
        finally:
            os.close(d)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def client_allowed(addr):
    ip = ipaddress.ip_address(addr[0])
    if ip.is_loopback or ip.is_private:
        return True
    extra = os.environ.get('VAULT_LAN', '').strip()
    if extra:
        try:
            return ip in ipaddress.ip_network(extra, strict=False)
        except ValueError:
            pass
    return False


def host_header_parts(value):
    if not value:
        return '', HTTPS_PORT
    if value.startswith('['):
        end = value.find(']')
        if end == -1:
            return value, HTTPS_PORT
        host = value[1:end]
        rest = value[end + 1:]
        port = int(rest.lstrip(':')) if rest.startswith(':') else HTTPS_PORT
        return host, port
    if ':' in value:
        host, port_s = value.rsplit(':', 1)
        try:
            return host, int(port_s)
        except ValueError:
            return value, HTTPS_PORT
    return value, HTTPS_PORT


def valid_vault_hostname(name):
    lowered = name.lower().rstrip('.')
    if lowered in {'localhost', 'umbrel', 'umbrel.local'}:
        return True
    if lowered.endswith('.local'):
        return True
    try:
        ip = ipaddress.ip_address(lowered)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private


def request_vault_hostname(headers):
    forwarded = headers.get('X-Forwarded-Host') or headers.get('Host', '')
    host, _ = host_header_parts(forwarded)
    return host


def expected_https_origin(headers):
    if CONFIGURED_ORIGIN:
        return CONFIGURED_ORIGIN
    host = request_vault_hostname(headers)
    return f'https://{host}:{HTTPS_PORT}'


def expected_https_host(headers):
    if CONFIGURED_ORIGIN:
        return urlsplit(CONFIGURED_ORIGIN).netloc
    host = request_vault_hostname(headers)
    return f'{host}:{HTTPS_PORT}'


def cert_sha256_fingerprint():
    if not CERT_PATH.is_file():
        return '(certificate not generated yet)'
    try:
        out = subprocess.check_output(
            ['openssl', 'x509', '-in', str(CERT_PATH), '-noout', '-fingerprint', '-sha256'],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return out.split('=', 1)[-1].strip() if '=' in out else out
    except (subprocess.CalledProcessError, FileNotFoundError):
        return '(fingerprint unavailable)'


class LandingHandler(BaseHTTPRequestHandler):
    server_version = 'FieldLabVaultLanding/1.0'

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        path = self.path.split('?', 1)[0].split('#', 1)[0]
        if path in FAVICON_STATIC:
            name, kind = FAVICON_STATIC[path]
            raw = (ROOT / 'web' / name).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(raw)
            return
        if path not in ('/', '/index.html'):
            self.send_error(404)
            return
        forwarded = self.headers.get('X-Forwarded-Host') or self.headers.get('Host', 'localhost')
        hostname, _ = host_header_parts(forwarded)
        vault_url = f'https://{hostname}:{HTTPS_PORT}/'
        fingerprint = cert_sha256_fingerprint()
        body = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Field Lab Vault</title>{FAVICON_LINKS}<style>{LANDING_STYLE}</style></head>
<body><h1>Field Lab Vault</h1>
<p class="muted">This page is only a pointer. Passwords and secrets are never entered over plain HTTP.</p>
<p>WebCrypto requires a <strong>secure context</strong> (HTTPS). Open the vault on your home LAN using the link below, verify the certificate fingerprint, then create or unlock your vault there.</p>
<p><a class="button" href="{vault_url}">Open vault on HTTPS port {HTTPS_PORT}</a></p>
<p>Direct URL: <code>{vault_url}</code></p>
<h2>TLS certificate SHA-256 fingerprint</h2>
<pre>{fingerprint}</pre>
<p class="muted">Compare this fingerprint when your browser warns about the self-signed certificate. The certificate and key are generated on first run and stored only under this app&apos;s data directory on your Umbrel.</p>
<footer>Field Lab Vault · Umbrel opens an optional Tor hidden service to this HTTP landing page only, not to the HTTPS vault port on your LAN.</footer>
</body></html>"""
        raw = body.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(raw)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(60)

    server_version = 'FieldLabVault/1.0'

    def log_message(self, fmt, *args):
        pass

    def headers_base(self, status, kind='application/json', length=0):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
            "img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        )
        self.send_header('Connection', 'close')

    def reply(self, status, obj):
        raw = json.dumps(obj).encode()
        self.headers_base(status, length=len(raw))
        self.end_headers()
        self.wfile.write(raw)

    def is_top_level_nav_static(self):
        if self.command not in ('GET', 'HEAD'):
            return False
        if self.headers.get('Sec-Fetch-Mode') != 'navigate':
            return False
        path = self.path.split('?', 1)[0].split('#', 1)[0]
        return path in NAV_STATIC_PATHS

    def guard(self):
        if not client_allowed(self.client_address):
            self.reply(403, {'error': 'Home LAN only'})
            return False
        host_header = self.headers.get('Host', '')
        if CONFIGURED_ORIGIN:
            if host_header != urlsplit(CONFIGURED_ORIGIN).netloc:
                self.reply(403, {'error': 'Invalid host'})
                return False
        else:
            name, _ = host_header_parts(host_header)
            if not valid_vault_hostname(name):
                self.reply(403, {'error': 'Invalid host'})
                return False
        if self.is_top_level_nav_static():
            return True
        origin = self.headers.get('Origin')
        expected = expected_https_origin(self.headers)
        if origin is not None and origin != expected:
            self.reply(403, {'error': 'Cross-origin request refused'})
            return False
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self.reply(403, {'error': 'Cross-site request refused'})
            return False
        return True

    def auth(self):
        s = state()
        token = self.headers.get('Authorization', '')
        supplied = token[7:] if token.startswith('Bearer ') else ''
        digest = base64.b64encode(hashlib.sha256(supplied.encode()).digest()).decode()
        if not s or not hmac.compare_digest(digest, s['authHash']):
            time.sleep(0.35)
            self.reply(401, {'error': 'Wrong password or locked vault'})
            return None
        return s

    def read_json(self):
        n = int(self.headers.get('Content-Length', '-1'))
        if not 0 <= n <= MAX_INDEX * 2:
            raise ValueError('Request too large')
        if self.headers.get_content_type() != 'application/json':
            raise ValueError('Expected JSON')
        return json.loads(self.rfile.read(n))

    def file_id(self):
        ident = self.path.removeprefix('/api/files/')
        if not ID.fullmatch(ident):
            raise ValueError('Invalid file ID')
        return ident

    def do_GET(self):
        try:
            if not self.guard():
                return
            if self.path == '/api/status':
                with LOCK:
                    s = state()
                return self.reply(200, {'initialized': bool(s), **({k: s[k] for k in ('version', 'vaultId', 'salt', 'iterations')} if s else {})})
            if self.path == '/api/vault':
                with LOCK:
                    s = self.auth()
                    if s:
                        return self.reply(200, {k: v for k, v in s.items() if k != 'authHash'})
                return
            if self.path.startswith('/api/files/'):
                with LOCK:
                    if not self.auth():
                        return
                    path = DATA / 'files' / self.file_id()
                    if not path.is_file():
                        return self.reply(404, {'error': 'File missing'})
                    f = path.open('rb')
                    n = path.stat().st_size
                with f:
                    self.headers_base(200, 'application/octet-stream', n)
                    self.end_headers()
                    while chunk := f.read(1024 * 1024):
                        self.wfile.write(chunk)
                return
            if self.path == '/api/export':
                with LOCK:
                    s = self.auth()
                    if not s:
                        return
                    with tempfile.TemporaryFile(dir=DATA) as archive:
                        paths = sorted((DATA / 'files').iterdir())
                        files = [{'id': p.name, 'size': p.stat().st_size} for p in paths if ID.fullmatch(p.name)]
                        meta = json.dumps({'state': {k: v for k, v in s.items() if k != 'authHash'}, 'files': files}, separators=(',', ':')).encode()
                        archive.write(MAGIC + struct.pack('>I', len(meta)) + meta)
                        for item in files:
                            with (DATA / 'files' / item['id']).open('rb') as f:
                                while chunk := f.read(1024 * 1024):
                                    archive.write(chunk)
                        size = archive.tell()
                        archive.seek(0)
                        self.headers_base(200, 'application/octet-stream', size)
                        self.send_header('Content-Disposition', 'attachment; filename="fieldlab-vault.lvbak"')
                        self.end_headers()
                        while chunk := archive.read(1024 * 1024):
                            self.wfile.write(chunk)
                return
            static = {
                '/': ('index.html', 'text/html; charset=utf-8'),
                '/favicon.ico': ('favicon.ico', 'image/x-icon'),
                '/favicon-32x32.png': ('favicon-32x32.png', 'image/png'),
                '/apple-touch-icon.png': ('apple-touch-icon.png', 'image/png'),
                '/app.js': ('app.js', 'text/javascript'),
                '/crypto.js': ('crypto.js', 'text/javascript'),
                '/bip39.js': ('bip39.js', 'text/javascript'),
                '/bip39-data.js': ('bip39-data.js', 'text/javascript'),
                '/bip39-english.txt': ('bip39-english.txt', 'text/plain; charset=utf-8'),
                '/style.css': ('style.css', 'text/css'),
            }
            if self.path not in static:
                return self.reply(404, {'error': 'Not found'})
            name, kind = static[self.path]
            raw = (ROOT / 'web' / name).read_bytes()
            self.headers_base(200, kind, len(raw))
            self.end_headers()
            self.wfile.write(raw)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            self.reply(400, {'error': 'Invalid request'})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        try:
            if not self.guard():
                return
            if self.path != '/api/setup':
                return self.reply(404, {'error': 'Not found'})
            s = self.read_json()
            validate_state(s)
            if s['revision'] != 1:
                raise ValueError('Invalid initial revision')
            with LOCK:
                if state():
                    return self.reply(409, {'error': 'Vault already initialized'})
                atomic_state(s)
            return self.reply(201, {'revision': 1})
        except (ValueError, KeyError, TypeError):
            self.reply(400, {'error': 'Invalid setup'})

    def do_PUT(self):
        temp = None
        try:
            if not self.guard():
                return
            with LOCK:
                old = self.auth()
                if not old:
                    return
            if self.path == '/api/vault':
                new = self.read_json()
                new['authHash'] = old['authHash']
                validate_state(new)
                with LOCK:
                    latest = state()
                    if new['revision'] != latest['revision'] + 1:
                        return self.reply(409, {'error': 'Vault changed in another tab. Lock and unlock, then retry.'})
                    if any(new[k] != latest[k] for k in ('salt', 'iterations', 'vaultId', 'authHash', 'version')):
                        raise ValueError('Immutable vault configuration')
                    atomic_state(new)
                return self.reply(200, {'revision': new['revision']})
            if not self.path.startswith('/api/files/'):
                return self.reply(404, {'error': 'Not found'})
            ident = self.file_id()
            n = int(self.headers.get('Content-Length', '-1'))
            if not 16 <= n <= MAX_FILE:
                return self.reply(413, {'error': 'Files must be no larger than 128 MiB'})
            fd, temp = tempfile.mkstemp(prefix='.upload-', dir=DATA / 'files')
            with os.fdopen(fd, 'wb') as f:
                remaining = n
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('Incomplete upload')
                    f.write(chunk)
                    remaining -= len(chunk)
                f.flush()
                os.fsync(f.fileno())
            with LOCK:
                path = DATA / 'files' / ident
                if path.exists():
                    return self.reply(409, {'error': 'File ID already exists'})
                os.replace(temp, path)
                temp = None
            self.reply(201, {'ok': True})
        except (ValueError, KeyError, TypeError):
            self.reply(400, {'error': 'Invalid upload'})
        finally:
            if temp and os.path.exists(temp):
                os.unlink(temp)

    def do_DELETE(self):
        try:
            if not self.guard():
                return
            with LOCK:
                if not self.auth():
                    return
                if not self.path.startswith('/api/files/'):
                    return self.reply(404, {'error': 'Not found'})
                (DATA / 'files' / self.file_id()).unlink(missing_ok=True)
            self.reply(200, {'ok': True})
        except ValueError:
            self.reply(400, {'error': 'Invalid file ID'})


class VaultServer(ThreadingHTTPServer):
    request_queue_size = 16
    slots = threading.BoundedSemaphore(24)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


def serve_http():
    http_srv = VaultServer((HTTPS_BIND, HTTP_PORT), LandingHandler)
    http_srv.daemon_threads = True
    print(f'Field Lab Vault HTTP landing ready on {HTTP_PORT}', flush=True)
    http_srv.serve_forever()


def main():
    os.umask(0o077)
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / 'files').mkdir(exist_ok=True)
    if not CONFIGURED_ORIGIN and os.environ.get('VAULT_ENABLE_LANDING_HTTP', '1') != '0':
        threading.Thread(target=serve_http, daemon=True).start()
    srv = VaultServer((HTTPS_BIND, HTTPS_PORT), Handler)
    srv.daemon_threads = True
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(str(CERT_PATH), str(KEY_PATH))
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    print(f'Field Lab Vault HTTPS ready on {HTTPS_PORT}', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
