#!/usr/bin/env python3
"""Provision or renew Field Lab Vault LAN TLS: local CA with name constraints and server cert."""
from __future__ import annotations

import ipaddress
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

CA_BASENAME = 'ca'
SERVER_CERT = 'tls.crt'
SERVER_KEY = 'tls.key'
CA_MARKER = 'pki.version'
PKI_VERSION = '2'
DEFAULT_FALLBACK_IP = '192.168.4.99'
RENEW_BEFORE_DAYS = 45
SERVER_CERT_DAYS = 825
CA_CERT_DAYS = 3650
NAME_CONSTRAINT_CIDR = os.environ.get('VAULT_CA_IP_NET', '192.168.4.0/24')


def _openssl_run(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['openssl', *args],
        check=check,
        capture_output=True,
        text=True,
    )


def _chmod_sensitive(path: Path, mode: int = 0o600) -> None:
    path.chmod(mode)


def _backup_existing(path: Path) -> None:
    if not path.is_file() or path.stat().st_size == 0:
        return
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
    dest = path.parent / f'{path.name}.bak.{stamp}'
    shutil.copy2(path, dest)


def detect_private_ips() -> list[str]:
    ips: set[str] = set()
    try:
        text = subprocess.check_output(['hostname', '-I'], stderr=subprocess.DEVNULL, text=True).strip()
        for part in text.split():
            try:
                addr = ipaddress.ip_address(part)
            except ValueError:
                continue
            if addr.is_private and not addr.is_loopback:
                ips.add(str(addr))
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    ips.add(DEFAULT_FALLBACK_IP)
    return sorted(ips, key=ipaddress.ip_address)


def configured_server_ips() -> list[str]:
    raw = os.environ.get('VAULT_CERT_IPS', '').strip()
    if raw:
        parts = [p.strip() for p in raw.split(',') if p.strip()]
    else:
        extra = os.environ.get('VAULT_CERT_SAN_EXTRA', '').strip()
        parts = []
        if extra:
            parts.extend(p.strip() for p in extra.split(',') if p.strip())
        for ip in detect_private_ips():
            parts.append(ip)
    out: list[str] = []
    seen: set[str] = set()
    for part in parts:
        if part.upper().startswith('IP:'):
            part = part[3:].strip()
        try:
            normalized = str(ipaddress.ip_address(part))
        except ValueError:
            print(f'fieldlab-local-vault: ignoring invalid VAULT_CERT_IPS entry: {part!r}', file=sys.stderr)
            continue
        if normalized not in seen:
            seen.add(normalized)
            out.append(normalized)
    if '127.0.0.1' not in seen:
        out.append('127.0.0.1')
    return out


def _name_constraint_ip(cidr: str) -> str:
    net = ipaddress.ip_network(cidr, strict=False)
    if net.version != 4:
        raise ValueError('Only IPv4 name constraints are supported')
    base = int(net.network_address)
    mask = int(net.netmask)
    return f'{ipaddress.IPv4Address(base)}/{ipaddress.IPv4Address(mask)}'


def server_san_extension(ips: list[str]) -> str:
    entries = ['DNS:localhost', 'DNS:umbrel.local']
    entries.extend(f'IP:{ip}' for ip in ips)
    return 'subjectAltName=' + ','.join(entries)


def _cert_days_remaining(cert_path: Path) -> int | None:
    if not cert_path.is_file():
        return None
    try:
        out = _openssl_run(['x509', '-in', str(cert_path), '-noout', '-enddate']).stdout.strip()
    except subprocess.CalledProcessError:
        return None
    m = re.search(r'notAfter=(.+)', out)
    if not m:
        return None
    try:
        end = datetime.strptime(m.group(1), '%b %d %H:%M:%S %Y %Z').replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return (end - datetime.now(timezone.utc)).days


def _cert_issued_by_local_ca(cert_path: Path, ca_cert: Path) -> bool:
    try:
        issuer = _openssl_run(['x509', '-in', str(cert_path), '-noout', '-issuer']).stdout
        subject = _openssl_run(['x509', '-in', str(ca_cert), '-noout', '-subject']).stdout
        issuer_fp = _openssl_run(
            ['x509', '-in', str(cert_path), '-noout', '-issuer', '-fingerprint', '-sha256'],
        ).stdout.strip().split('=', 1)[-1]
        ca_fp = _openssl_run(
            ['x509', '-in', str(ca_cert), '-noout', '-fingerprint', '-sha256'],
        ).stdout.strip().split('=', 1)[-1]
    except subprocess.CalledProcessError:
        return False
    if issuer_fp != ca_fp:
        return False
    return 'Field Lab Vault Local CA' in issuer or 'Field Lab Vault Local CA' in subject


def ensure_ca(cert_dir: Path) -> tuple[Path, Path]:
    ca_key = cert_dir / f'{CA_BASENAME}.key'
    ca_cert = cert_dir / f'{CA_BASENAME}.crt'
    if ca_key.is_file() and ca_cert.is_file():
        return ca_key, ca_cert
    cert_dir.mkdir(parents=True, exist_ok=True)
    _openssl_run(['genrsa', '-out', str(ca_key), '3072'])
    _chmod_sensitive(ca_key)
    nc_ip = _name_constraint_ip(NAME_CONSTRAINT_CIDR)
    nc = (
        'nameConstraints=critical,'
        f'permitted;IP:{nc_ip},'
        'permitted;IP:127.0.0.0/255.0.0.0,'
        'permitted;DNS:.local,'
        'permitted;DNS:localhost'
    )
    _openssl_run([
        'req', '-new', '-x509', '-sha256',
        '-days', str(CA_CERT_DAYS),
        '-key', str(ca_key),
        '-out', str(ca_cert),
        '-subj', '/CN=Field Lab Vault Local CA/O=Field Lab Vault',
        '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
        '-addext', 'subjectKeyIdentifier=hash',
        '-addext', nc,
    ])
    _chmod_sensitive(ca_cert)
    marker = cert_dir / CA_MARKER
    marker.write_text(PKI_VERSION + '\n', encoding='utf-8')
    _chmod_sensitive(marker)
    return ca_key, ca_cert


def issue_server_cert(cert_dir: Path, ca_key: Path, ca_cert: Path, ips: list[str]) -> None:
    cert_path = cert_dir / SERVER_CERT
    key_path = cert_dir / SERVER_KEY
    csr_path = cert_dir / '.tls.csr'
    serial_path = cert_dir / '.ca.srl'
    try:
        if not key_path.is_file():
            _openssl_run(['genrsa', '-out', str(key_path), '3072'])
            _chmod_sensitive(key_path)
        san = server_san_extension(ips)
        _openssl_run([
            'req', '-new', '-sha256',
            '-key', str(key_path),
            '-out', str(csr_path),
            '-subj', '/CN=Field Lab Vault',
            '-addext', san,
        ])
        args = [
            'x509', '-req', '-sha256',
            '-days', str(SERVER_CERT_DAYS),
            '-in', str(csr_path),
            '-CA', str(ca_cert),
            '-CAkey', str(ca_key),
            '-out', str(cert_path),
            '-copy_extensions', 'copyall',
        ]
        if serial_path.is_file():
            args.extend(['-CAserial', str(serial_path)])
        else:
            args.append('-CAcreateserial')
        _openssl_run(args)
        _chmod_sensitive(cert_path)
        _chmod_sensitive(key_path)
        if serial_path.is_file():
            _chmod_sensitive(serial_path)
    finally:
        if csr_path.is_file():
            csr_path.unlink()


def migrate_legacy_self_signed(cert_dir: Path) -> None:
    cert_path = cert_dir / SERVER_CERT
    key_path = cert_dir / SERVER_KEY
    ca_key = cert_dir / f'{CA_BASENAME}.key'
    if ca_key.is_file():
        return
    if not cert_path.is_file():
        return
    _backup_existing(cert_path)
    if key_path.is_file():
        _backup_existing(key_path)


def needs_server_cert(cert_dir: Path, ca_cert: Path) -> bool:
    cert_path = cert_dir / SERVER_CERT
    key_path = cert_dir / SERVER_KEY
    if not cert_path.is_file() or not key_path.is_file():
        return True
    if not _cert_issued_by_local_ca(cert_path, ca_cert):
        return True
    days = _cert_days_remaining(cert_path)
    if days is None or days <= RENEW_BEFORE_DAYS:
        return True
    expected_sans = set(configured_server_ips())
    try:
        text = _openssl_run(['x509', '-in', str(cert_path), '-noout', '-ext', 'subjectAltName']).stdout
    except subprocess.CalledProcessError:
        return True
    for ip in expected_sans:
        if ip != '127.0.0.1' and f'IP Address:{ip}' not in text and f'IP:{ip}' not in text:
            return True
    return False


def ensure_tls_material(cert_dir: Path) -> None:
    os.umask(0o077)
    cert_dir.mkdir(parents=True, exist_ok=True)
    migrate_legacy_self_signed(cert_dir)
    ips = configured_server_ips()
    ca_key, ca_cert = ensure_ca(cert_dir)
    if needs_server_cert(cert_dir, ca_cert):
        cert_path = cert_dir / SERVER_CERT
        if cert_path.is_file():
            _backup_existing(cert_path)
        issue_server_cert(cert_dir, ca_key, ca_cert, ips)
    elif not (cert_dir / CA_MARKER).is_file():
        (cert_dir / CA_MARKER).write_text(PKI_VERSION + '\n', encoding='utf-8')
        _chmod_sensitive(cert_dir / CA_MARKER)


def main() -> int:
    cert_file = Path(os.environ.get('VAULT_CERT', '/cert/tls.crt'))
    cert_dir = cert_file.parent
    try:
        ensure_tls_material(cert_dir)
    except subprocess.CalledProcessError as exc:
        print('fieldlab-local-vault: TLS setup failed:', exc.stderr or exc.stdout, file=sys.stderr)
        return 1
    except OSError as exc:
        print(f'fieldlab-local-vault: TLS setup failed: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
