#!/usr/bin/env python3
"""Repeatable browser integration tests; synthetic content only, isolated temp data."""
import base64
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import time
import urllib.request
import urllib.error
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]  # fieldlab-local-vault/app
PASSWORD = 'synthetic test passphrase only 2026'
MARKER = 'synthetic-note-content-934af16b'
passed = []
def ok(name):
    passed.append(name)
    print('PASS:', name, flush=True)

def request(origin, path, method='GET', body=None, headers=None):
    req = urllib.request.Request(origin + path, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, context=ssl._create_unverified_context()) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def wait_ready(origin, proc):
    for _ in range(100):
        if proc.poll() is not None:
            raise RuntimeError('Server exited during startup')
        try:
            if request(origin, '/api/status')[0] == 200:
                return
        except OSError:
            pass
        time.sleep(.05)
    raise RuntimeError('Server did not start')

def create(page, origin):
    page.goto(origin)
    expect(page.locator('#gate-title')).to_have_text('Create your private vault')
    page.locator('#password').fill(PASSWORD)
    page.locator('#confirm-password').fill(PASSWORD)
    page.locator('#unlock-submit').click()
    expect(page.locator('#workspace')).to_be_visible(timeout=30000)

def unlock(page, password=PASSWORD):
    page.locator('#password').fill(password)
    page.locator('#unlock-submit').click()
    if password == PASSWORD:
        expect(page.locator('#workspace')).to_be_visible(timeout=30000)

def main():
    with tempfile.TemporaryDirectory(prefix='local-vault-test-') as tmp:
        tmp = Path(tmp)
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(tmp/'test.key'),'-out',str(tmp/'test.crt'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        procs = []
        try:
            for port in (18449,18450):
                origin = f'https://127.0.0.1:{port}'
                env = {**os.environ, 'VAULT_DATA':str(tmp/f'data{port}'), 'VAULT_ORIGIN':origin, 'VAULT_BIND':'127.0.0.1', 'VAULT_PORT':str(port), 'VAULT_CERT':str(tmp/'test.crt'), 'VAULT_KEY':str(tmp/'test.key')}
                p = subprocess.Popen(['python3',str(ROOT/'server.py')], env=env, stdout=subprocess.DEVNULL)
                procs.append(p); wait_ready(origin,p)
            origin = 'https://127.0.0.1:18449'
            assert request(origin,'/api/vault')[0] == 401
            assert request(origin,'/api/setup','POST',b'{}',{'Origin':'https://evil.invalid','Content-Type':'application/json'})[0] == 403
            assert request(origin,'/api/status',headers={'Host':'evil.invalid'})[0] == 403
            ok('Unauthenticated access, hostile Origin and hostile Host rejected')
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                context = browser.new_context(ignore_https_errors=True, accept_downloads=True)
                context.add_init_script('delete window.showSaveFilePicker;')
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                create(page,origin)
                ok('First-run password setup and browser WebCrypto in HTTPS')
                page.locator('#new-note').click()
                page.locator('#note-title').fill('Node recovery test note')
                page.locator('#note-body').fill(MARKER)
                page.get_by_role('button',name='Save note',exact=True).click()
                expect(page.locator('#message')).to_have_text('Note saved.')
                page.locator('#search').fill('934af16b')
                expect(page.locator('#notes button')).to_have_count(1)
                page.locator('#search').fill('does-not-exist')
                expect(page.locator('#notes button')).to_have_count(0)
                page.locator('#search').fill('')
                page.locator('#notes button').click()
                page.locator('#note-body').fill(MARKER+' updated')
                page.get_by_role('button',name='Save note',exact=True).click()
                expect(page.locator('#message')).to_have_text('Note saved.')
                ok('Create, edit and full-text search notes')
                payload = b'\x00\xff\x80Synthetic channel backup test only\x00' * 25000
                page.locator('#upload').set_input_files({'name':'test.channel.backup','mimeType':'application/octet-stream','buffer':payload})
                expect(page.locator('#message')).to_have_text('1 file(s) encrypted and saved.',timeout=30000)
                with page.expect_download() as info:
                    page.locator('#files').get_by_role('button',name='Download',exact=True).click()
                downloaded = info.value
                assert Path(downloaded.path()).read_bytes() == payload
                ok('Arbitrary binary attachment encrypt/upload/download/decrypt byte-for-byte')
                # Larger than the requested 100MB threshold.
                large = tmp/'large.bin'
                with large.open('wb') as f:
                    f.truncate(101*1024*1024)
                page.evaluate('''() => {const input=document.getElementById('upload'); const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(101*1024*1024)],'large.bin',{type:'application/octet-stream'}));input.files=dt.files;input.dispatchEvent(new Event('change'));}''')
                expect(page.locator('#message')).to_have_text('1 file(s) encrypted and saved.',timeout=90000)
                expect(page.locator('#files .file')).to_have_count(2)
                with page.expect_download(timeout=90000) as info:
                    page.locator('#files .file').filter(has_text='large.bin').get_by_role('button',name='Download',exact=True).click()
                assert Path(info.value.path()).stat().st_size == large.stat().st_size
                assert Path(info.value.path()).read_bytes() == large.read_bytes()
                ok('101 MiB attachment roundtrip (128 MiB limit)')
                page.locator('#lock').click()
                expect(page.locator('#workspace')).to_be_hidden()
                assert MARKER not in page.content()
                unlock(page,'wrong synthetic password')
                expect(page.locator('#message')).to_have_text('Wrong password or locked vault',timeout=30000)
                expect(page.locator('#workspace')).to_be_hidden()
                unlock(page)
                ok('Lock wipes DOM; wrong password rejected; correct unlock restores content')
                # GCM integrity and independently-derived wrong key rejection in actual browser module.
                integrity = page.evaluate('''async () => {
                  const c = await import('/crypto.js');
                  const salt = c.b64(c.random(32));
                  const a = await c.derive('synthetic A',salt), b = await c.derive('synthetic B',salt);
                  const box = await c.encrypt(a.key,new TextEncoder().encode('roundtrip'),'test-aad');
                  const plain = await c.decrypt(a.key,box.ciphertext,box.iv,'test-aad');
                  let wrong=false,tamper=false;
                  try {await c.decrypt(b.key,box.ciphertext,box.iv,'test-aad')}catch{wrong=true}
                  const changed=new Uint8Array(box.ciphertext);changed[0]^=1;
                  try {await c.decrypt(a.key,changed,box.iv,'test-aad')}catch{tamper=true}
                  return new TextDecoder().decode(plain)==='roundtrip'&&wrong&&tamper;
                }''')
                assert integrity
                ok('AES-GCM roundtrip, wrong-key rejection and tamper rejection')
                # Optimistic concurrency checked using same derived test credential, never logged.
                concurrency = page.evaluate('''async password => {
                  const c=await import('/crypto.js');const cfg=await (await fetch('/api/status')).json();
                  const d=await c.derive(password,cfg.salt);const headers={Authorization:`Bearer ${d.token}`,'Content-Type':'application/json'};
                  const current=await(await fetch('/api/vault',{headers})).json();
                  const r=await fetch('/api/vault',{method:'PUT',headers,body:JSON.stringify(current)});return r.status;
                }''',PASSWORD)
                assert concurrency == 409
                ok('Stale revision cannot overwrite newer vault')
                import hashlib
                cfg = json.loads(request(origin,'/api/status')[1])
                bits = hashlib.pbkdf2_hmac('sha256',PASSWORD.encode(),base64.b64decode(cfg['salt']),600000,64)
                token = base64.b64encode(bits[32:]).decode()
                assert request(origin,'/api/files/11111111-1111-4111-8111-111111111111','PUT',b'',{'Authorization':'Bearer '+token,'Content-Length':str(128*1024*1024+17)})[0] == 413
                assert request(origin,'/api/setup','POST',b'{}',{'Content-Type':'application/json'})[0] == 400
                ok('Oversize encrypted upload rejected without reading its body')
                with page.expect_download(timeout=90000) as info:
                    page.locator('#export').click()
                backup = tmp/'backup.lvbak'; info.value.save_as(backup)
                assert backup.read_bytes().startswith(b'LVBAK001')
                assert MARKER.encode() not in backup.read_bytes()
                ok('Whole-vault encrypted export contains no test-note plaintext')
                page.locator('#import').set_input_files(str(backup))
                page.locator('#backup-password').fill('incorrect backup password')
                page.get_by_role('button',name='Import copies',exact=True).click()
                expect(page.locator('#message')).to_have_text('Wrong backup password or corrupted backup. Nothing was imported.',timeout=30000)
                expect(page.locator('#notes button')).to_have_count(1)
                ok('Wrong backup password imports nothing')
                other = context.new_page(); other.on('pageerror',lambda e: errors.append(str(e)))
                create(other,'https://127.0.0.1:18450')
                other.locator('#import').set_input_files(str(backup))
                other.locator('#backup-password').fill(PASSWORD)
                other.get_by_role('button',name='Import copies',exact=True).click()
                expect(other.locator('#message')).to_have_text('Imported 1 note(s) and 2 file(s) as copies.',timeout=90000)
                other.locator('#notes button').click()
                expect(other.locator('#note-body')).to_have_value(MARKER+' updated')
                with other.expect_download() as info:
                    other.locator('#files .file').filter(has_text='test.channel.backup').get_by_role('button',name='Download',exact=True).click()
                assert Path(info.value.path()).read_bytes() == payload
                ok('Export imported into separately keyed fresh vault; notes and attachment preserved')
                other.once('dialog',lambda d:d.dismiss())
                other.get_by_role('button',name='Delete note',exact=True).click()
                expect(other.locator('#notes button')).to_have_count(1)
                other.once('dialog',lambda d:d.accept())
                other.get_by_role('button',name='Delete note',exact=True).click()
                expect(other.locator('#message')).to_have_text('Note deleted.')
                expect(other.locator('#notes button')).to_have_count(0)
                other.once('dialog',lambda d:d.accept())
                other.locator('#files .file').filter(has_text='test.channel.backup').get_by_role('button',name='Delete',exact=True).click()
                expect(other.locator('#message')).to_have_text('File deleted.')
                expect(other.locator('#files .file')).to_have_count(1)
                ok('Note deletion cancel/confirm and attachment deletion')
                # Advance browser clock rather than weakening production idle policy.
                other.locator('#idle').select_option('1')
                other.clock.install()
                other.clock.fast_forward(61000)
                expect(other.locator('#workspace')).to_be_hidden()
                ok('Idle auto-lock at selected one-minute interval')
                # Restart only our temporary test server, never a real Umbrel app.
                procs[0].terminate(); procs[0].wait(timeout=10)
                restarted_env={**os.environ,'VAULT_DATA':str(tmp/'data18449'),'VAULT_ORIGIN':origin,'VAULT_BIND':'127.0.0.1','VAULT_PORT':'18449','VAULT_CERT':str(tmp/'test.crt'),'VAULT_KEY':str(tmp/'test.key')}
                procs[0]=subprocess.Popen(['python3',str(ROOT/'server.py')],env=restarted_env,stdout=subprocess.DEVNULL)
                wait_ready(origin,procs[0])
                page.reload(); expect(page.locator('#gate-title')).to_have_text('Unlock your vault')
                unlock(page); page.locator('#notes button').click()
                expect(page.locator('#note-body')).to_have_value(MARKER+' updated')
                ok('Vault survives server restart and correct password decrypts persistent state')
                page.screenshot(path=str(ROOT/'tests'/'tested-ui.png'),full_page=True)
                assert not errors, errors
                ok('No browser runtime errors')
                browser.close()
            for data in (tmp/'data18449',tmp/'data18450'):
                for path in data.rglob('*'):
                    if path.is_file():
                        raw=path.read_bytes()
                        assert MARKER.encode() not in raw
                        assert PASSWORD.encode() not in raw
                        assert b'Node recovery test note' not in raw
                        assert b'test.channel.backup' not in raw
            ok('Server disk contains no plaintext notes, original filenames or master password')
        finally:
            for proc in procs:
                proc.terminate()
            for proc in procs:
                proc.wait(timeout=10)
    print(f'ALL {len(passed)} CHECKS PASSED',flush=True)
    (ROOT/'tests'/'results.json').write_text(json.dumps({'passed':passed},indent=2)+'\n')

if __name__=='__main__':
    main()
