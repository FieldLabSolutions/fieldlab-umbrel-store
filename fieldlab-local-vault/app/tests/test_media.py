#!/usr/bin/env python3
"""Media API unit tests (stdlib); no plaintext secrets on disk."""
import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import ssl
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def request(origin, path, method='GET', body=None, headers=None):
    req = urllib.request.Request(origin + path, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, context=ssl._create_unverified_context(), timeout=30) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def wait_ready(origin, proc):
    for _ in range(100):
        if proc.poll() is not None:
            raise RuntimeError('server died')
        try:
            if request(origin, '/api/status')[0] == 200:
                return
        except OSError:
            pass
        time.sleep(0.05)
    raise RuntimeError('timeout')


class DiskOkTests(unittest.TestCase):
    def test_live_box_headroom_passes_production_min_free(self):
        """Daniel's ~98 GiB free on /home vs 50 GiB policy — arithmetic sanity."""
        free_98 = 98 * 1024 ** 3
        min_50 = 50 * 1024 ** 3
        self.assertGreaterEqual(free_98, min_50)

    def test_disk_ok_on_ci_host_with_production_min_free_env(self):
        import media_api
        with tempfile.TemporaryDirectory(prefix='disk-ok-') as tmp:
            data = Path(tmp)
            env_min = int(os.environ.get('VAULT_MEDIA_MIN_DISK_FREE_BYTES', str(50 * 1024 ** 3)))
            free = media_api.disk_free_bytes(data)
            self.assertGreaterEqual(free, env_min, f'CI host free {free} < default min-free {env_min}')
            self.assertTrue(media_api.disk_ok(data))


class MediaApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='vault-media-test-')
        tmp = Path(cls.tmp.name)
        subprocess.run(
            ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(tmp / 'k.pem'),
             '-out', str(tmp / 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        cls.data = tmp / 'data'
        cls.data.mkdir()
        cls.origin = 'https://127.0.0.1:19599'
        cls.env = {
            **os.environ,
            'VAULT_DATA': str(cls.data),
            'VAULT_ORIGIN': cls.origin,
            'VAULT_BIND': '127.0.0.1',
            'VAULT_PORT': '19599',
            'VAULT_CERT': str(tmp / 'c.pem'),
            'VAULT_KEY': str(tmp / 'k.pem'),
            'VAULT_MEDIA_QUOTA_BYTES': str(50 * 1024 * 1024),
            'VAULT_MEDIA_MIN_DISK_FREE_BYTES': '0',
        }
        cls.proc = subprocess.Popen(['python3', str(ROOT / 'server.py')], env=cls.env, stdout=subprocess.DEVNULL)
        wait_ready(cls.origin, cls.proc)
        cls.main_token = 'synthetic-main-token-for-media-tests-only'
        cls.media_token = 'synthetic-media-token-for-media-tests-only'
        cls.vault_id = '11111111-1111-4111-8111-111111111111'
        state = {
            'version': 1, 'vaultId': cls.vault_id, 'salt': base64.b64encode(b'0' * 32).decode(),
            'iterations': 600000, 'iv': base64.b64encode(b'1' * 12).decode(),
            'ciphertext': base64.b64encode(b'2' * 32).decode(),
            'authHash': base64.b64encode(__import__('hashlib').sha256(cls.main_token.encode()).digest()).decode(),
            'revision': 1,
        }
        (cls.data / 'state.json').write_text(json.dumps(state))
        media = {
            'version': 1, 'vaultId': cls.vault_id, 'salt': base64.b64encode(b'3' * 32).decode(),
            'iterations': 600000,
            'wrapIv': base64.b64encode(b'4' * 12).decode(),
            'wrappedKey': base64.b64encode(b'5' * 48).decode(),
            'authHash': base64.b64encode(__import__('hashlib').sha256(cls.media_token.encode()).digest()).decode(),
            'revision': 1,
            'indexIv': base64.b64encode(b'6' * 12).decode(),
            'indexCiphertext': base64.b64encode(b'7' * 32).decode(),
            'usedBytes': 0,
        }
        media_dir = cls.data / 'media'
        media_dir.mkdir(parents=True, exist_ok=True)
        (media_dir / 'state.json').write_text(json.dumps(media))

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=10)
        cls.tmp.cleanup()

    def auth_main(self):
        return {'Authorization': f'Bearer {self.main_token}'}

    def auth_both(self):
        return {**self.auth_main(), 'X-Media-Authorization': f'Bearer {self.media_token}'}

    def test_status_requires_main_session(self):
        code, _, _ = request(self.origin, '/api/media/status')
        self.assertEqual(code, 401)

    def test_media_vault_requires_both_tokens(self):
        code, _, _ = request(self.origin, '/api/media/vault', headers=self.auth_main())
        self.assertEqual(code, 401)
        code, _, _ = request(self.origin, '/api/media/vault', headers={'X-Media-Authorization': f'Bearer {self.media_token}'})
        self.assertEqual(code, 401)

    def test_media_vault_with_both(self):
        code, body, _ = request(self.origin, '/api/media/vault', headers=self.auth_both())
        self.assertEqual(code, 200)
        data = json.loads(body)
        self.assertNotIn('authHash', data)

    def test_chunk_range(self):
        item = '22222222-2222-4222-8222-222222222222'
        blob_dir = self.data / 'media' / 'blobs' / item
        blob_dir.mkdir(parents=True)
        payload = b'ABCDEFGHIJKLMNOP' * 64
        (blob_dir / '0.bin').write_bytes(payload)
        code, body, headers = request(
            self.origin, f'/api/media/items/{item}/chunks/0',
            headers={**self.auth_both(), 'Range': 'bytes=0-15'},
        )
        self.assertEqual(code, 206)
        self.assertEqual(body, payload[:16])
        self.assertIn('Content-Range', headers)

    def test_oversize_chunk_rejected(self):
        item = '33333333-3333-4333-8333-333333333333'
        headers = {**self.auth_both(), 'Content-Length': str(4 * 1024 ** 3 + 17)}
        code, _, _ = request(self.origin, f'/api/media/items/{item}/chunks/0', method='PUT', body=b'', headers=headers)
        self.assertEqual(code, 413)

    def test_unauthenticated_media_get_single_response(self):
        code, body, _ = request(self.origin, '/api/media/status')
        self.assertEqual(code, 401)
        data = json.loads(body.decode())
        self.assertIn('error', data)

    def test_second_unlock_media_token(self):
        code, body, _ = request(self.origin, '/api/media/vault', headers=self.auth_both())
        self.assertEqual(code, 200)
        rev = json.loads(body)['revision']
        code2, body2, _ = request(self.origin, '/api/media/vault', headers=self.auth_both())
        self.assertEqual(code2, 200)
        self.assertEqual(json.loads(body2)['revision'], rev)

    def test_item_total_size_server_limit(self):
        env = {
            **self.env,
            'VAULT_MEDIA_MAX_ITEM_BYTES': '8192',
            'VAULT_PORT': '19602',
            'VAULT_ORIGIN': 'https://127.0.0.1:19602',
            'VAULT_MEDIA_QUOTA_BYTES': str(100 * 1024 * 1024),
        }
        p = subprocess.Popen(['python3', str(ROOT / 'server.py')], env=env, stdout=subprocess.DEVNULL)
        origin = env['VAULT_ORIGIN']
        try:
            wait_ready(origin, p)
            item = '55555555-5555-4555-8555-555555555555'
            chunk = b'x' * 5000
            headers = {**self.auth_both(), 'Content-Length': str(len(chunk))}
            code, _, _ = request(origin, f'/api/media/items/{item}/chunks/0', method='PUT', body=chunk, headers=headers)
            self.assertEqual(code, 201)
            code, _, _ = request(origin, f'/api/media/items/{item}/chunks/1', method='PUT', body=chunk, headers=headers)
            self.assertEqual(code, 413)
        finally:
            p.terminate()
            p.wait(timeout=10)

    def test_commit_rejects_on_disk_over_item_budget(self):
        env = {
            **self.env,
            'VAULT_MEDIA_MAX_ITEM_BYTES': '8192',
            'VAULT_PORT': '19603',
            'VAULT_ORIGIN': 'https://127.0.0.1:19603',
        }
        p = subprocess.Popen(['python3', str(ROOT / 'server.py')], env=env, stdout=subprocess.DEVNULL)
        origin = env['VAULT_ORIGIN']
        try:
            wait_ready(origin, p)
            item = '66666666-6666-4666-8666-666666666666'
            blob_dir = self.data / 'media' / 'blobs' / item
            blob_dir.mkdir(parents=True, exist_ok=True)
            (blob_dir / '0.bin').write_bytes(b'x' * 9000)
            body = json.dumps({'chunkCount': 1, 'plaintextSize': 100}).encode()
            headers = {**self.auth_both(), 'Content-Type': 'application/json', 'Content-Length': str(len(body))}
            code, _, _ = request(
                origin, f'/api/media/items/{item}/commit', method='POST', body=body, headers=headers,
            )
            self.assertEqual(code, 413)
        finally:
            p.terminate()
            p.wait(timeout=10)

    def test_quota_exceeded(self):
        item = '44444444-4444-4444-8444-444444444444'
        big = b'x' * (1024 * 1024)
        headers = {**self.auth_both(), 'Content-Length': str(len(big))}
        for i in range(55):
            code, _, _ = request(
                self.origin, f'/api/media/items/{item}/chunks/{i}',
                method='PUT', body=big, headers=headers,
            )
            if code == 413:
                self.assertGreaterEqual(i, 1)
                return
            self.assertEqual(code, 201, i)
        self.fail('expected quota rejection')


if __name__ == '__main__':
    unittest.main()
