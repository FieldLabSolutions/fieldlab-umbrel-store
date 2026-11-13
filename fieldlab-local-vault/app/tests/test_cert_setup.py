#!/usr/bin/env python3
"""Unit tests for local CA and server certificate provisioning."""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import cert_setup  # noqa: E402


def openssl_text(path: Path, *args: str) -> str:
    return subprocess.check_output(['openssl', 'x509', '-in', str(path), '-noout', *args], text=True)


class CertSetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='vault-cert-test-')
        self.cert_dir = Path(self.tmp.name) / 'cert'
        self.cert_dir.mkdir()
        self.env = os.environ.copy()
        self.env['VAULT_CERT'] = str(self.cert_dir / 'tls.crt')
        self.env['VAULT_CERT_IPS'] = '127.0.0.1,192.168.4.99,192.168.4.50'
        self.env['VAULT_CA_IP_NET'] = '192.168.4.0/24'

    def tearDown(self):
        self.tmp.cleanup()
        for key in ('VAULT_CERT', 'VAULT_CERT_IPS', 'VAULT_CA_IP_NET'):
            os.environ.pop(key, None)

    def test_generates_ca_with_name_constraints_and_server_sans(self):
        with _env(self.env):
            cert_setup.ensure_tls_material(self.cert_dir)
        ca = self.cert_dir / 'ca.crt'
        tls = self.cert_dir / 'tls.crt'
        self.assertTrue(ca.is_file() and tls.is_file())
        ca_text = subprocess.check_output(['openssl', 'x509', '-in', str(ca), '-text'], text=True)
        self.assertIn('Field Lab Vault Local CA', ca_text)
        self.assertIn('192.168.4.0/255.255.255.0', ca_text)
        self.assertIn('DNS:.local', ca_text)
        san = openssl_text(tls, '-ext', 'subjectAltName')
        self.assertIn('DNS:umbrel.local', san)
        self.assertIn('IP Address:127.0.0.1', san.replace('IP:', 'IP Address:'))
        self.assertIn('192.168.4.99', san)
        self.assertIn('192.168.4.50', san)
        mode = (self.cert_dir / 'ca.key').stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_reuses_ca_on_second_run(self):
        with _env(self.env):
            cert_setup.ensure_tls_material(self.cert_dir)
            ca_fp_1 = openssl_text(self.cert_dir / 'ca.crt', '-fingerprint', '-sha256')
            cert_setup.ensure_tls_material(self.cert_dir)
            ca_fp_2 = openssl_text(self.cert_dir / 'ca.crt', '-fingerprint', '-sha256')
        self.assertEqual(ca_fp_1, ca_fp_2)

    def test_migrates_legacy_self_signed(self):
        legacy_key = self.cert_dir / 'tls.key'
        legacy_crt = self.cert_dir / 'tls.crt'
        subprocess.run(
            [
                'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
                '-keyout', str(legacy_key), '-out', str(legacy_crt), '-days', '30',
                '-subj', '/CN=Field Lab Vault',
                '-addext', 'subjectAltName=IP:127.0.0.1',
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        with _env(self.env):
            cert_setup.ensure_tls_material(self.cert_dir)
        backups = list(self.cert_dir.glob('tls.crt.bak.*'))
        self.assertTrue(backups, 'expected legacy tls.crt backup')
        self.assertTrue((self.cert_dir / 'ca.crt').is_file())
        issuer = openssl_text(self.cert_dir / 'tls.crt', '-issuer')
        self.assertIn('Field Lab Vault Local CA', issuer)


class _env:
    def __init__(self, values: dict[str, str]):
        self.values = values
        self.previous: dict[str, str | None] = {}

    def __enter__(self):
        for key, value in self.values.items():
            self.previous[key] = os.environ.get(key)
            os.environ[key] = value
        return self

    def __exit__(self, *args):
        for key, prior in self.previous.items():
            if prior is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = prior


if __name__ == '__main__':
    unittest.main(verbosity=2)
