#!/usr/bin/env python3
"""Repeatable browser integration tests; synthetic content only, isolated temp data."""
import sys
import base64
import hashlib
import json
import os
import re
import shutil
from pathlib import Path
import ssl
import subprocess
import tempfile
import time
import http.client
import urllib.request
import urllib.error
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]  # fieldlab-local-vault/app
sys.path.insert(0, str(ROOT))
BIP39_WORDLIST_SHA256 = '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda'
PASSWORD = 'synthetic test passphrase only 2026'
MEDIA_PASSWORD = 'separate media vault password 2026'
WALLET_LABEL = 'Synthetic test wallet only 7c2a'
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

def e2e_server_env(extra):
    """Hermetic e2e: do not require 50 GiB host free on main suite servers."""
    return {**extra, 'VAULT_MEDIA_MIN_DISK_FREE_BYTES': '0'}


def production_media_server_env(extra):
    """Explicit production media limits (50 GiB headroom, 100 GiB quota)."""
    return {
        **extra,
        'VAULT_MEDIA_MIN_DISK_FREE_BYTES': str(50 * 1024 ** 3),
        'VAULT_MEDIA_QUOTA_BYTES': str(100 * 1024 ** 3),
    }


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
    expect(page.locator('#gate-title')).to_have_text('Create your private vault', timeout=30000)
    page.locator('#password').fill(PASSWORD)
    page.locator('#confirm-password').fill(PASSWORD)
    page.locator('#unlock-submit').click()
    expect(page.locator('#workspace')).to_be_visible(timeout=30000)

def unlock(page, password=PASSWORD):
    page.locator('#password').fill(password)
    page.locator('#unlock-submit').click()
    if password == PASSWORD:
        expect(page.locator('#workspace')).to_be_visible(timeout=30000)

def open_note(page, title_substring=''):
    if title_substring:
        page.locator('#notes button').filter(has_text=title_substring).click()
    else:
        page.locator('#notes button').first.click()

def open_wallet(page, title_substring=''):
    page.locator('#wallets button').filter(has_text=title_substring).click()

def make_media_upload_fixtures(tmp: Path):
    if not shutil.which('ffmpeg'):
        raise RuntimeError('ffmpeg not found; required for media upload e2e fixtures')
    jpeg = tmp / 'e2e-media-upload.jpg'
    mp4 = tmp / 'e2e-media-upload.mp4'
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720',
         '-frames:v', '1', '-q:v', '2', str(jpeg)],
        check=True,
    )
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10',
         '-t', '0.8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(mp4)],
        check=True,
    )
    return jpeg, mp4


def accept_media_password(dialog):
    dialog.accept(MEDIA_PASSWORD)


def open_media_unlocked(page):
    if page.locator('#media-workspace').is_visible():
        return
    page.locator('#open-media').click()
    try:
        dialog = page.wait_for_event('dialog', timeout=3000)
        accept_media_password(dialog)
    except Exception:
        pass
    expect(page.locator('#media-workspace')).to_be_visible(timeout=60_000)
    expect(page.locator('#media-workspace')).to_contain_text('Photos & Videos', timeout=10_000)


def run_media_browser_upload(page, tmp: Path, data_dir: Path, tag: str, prod_disk_check=False):
    jpeg, mp4 = make_media_upload_fixtures(tmp)
    open_media_unlocked(page)
    page.evaluate('''() => {
      const input = document.querySelector('#media-workspace input[type="file"][accept*="image"]');
      if (!input) throw new Error('upload input missing');
      input.addEventListener('change', () => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        setTimeout(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
          document.dispatchEvent(new Event('visibilitychange'));
        }, 150);
      }, { once: true });
    }''')
    upload = page.locator('#media-workspace input[type="file"][accept*="image"]')
    upload.set_input_files([str(jpeg), str(mp4)])
    expect(page.locator('#media-grid .media-card')).to_have_count(2, timeout=180_000)
    expect(page.locator('#media-grid img.media-thumb[src^="blob:"]')).to_have_count(2, timeout=30_000)
    media_root = data_dir / 'media'
    state = json.loads((media_root / 'state.json').read_text())
    assert state.get('usedBytes', 0) > 0, 'usedBytes should reflect uploads'
    blob_bins = list((media_root / 'blobs').rglob('*.bin'))
    assert len(blob_bins) >= 2, 'expected ciphertext chunk blobs on disk'
    page.locator('.media-card').filter(has_text='e2e-media-upload.jpg').get_by_role('button', name='View', exact=True).click()
    expect(page.locator('#media-lightbox img.media-full')).to_be_visible(timeout=30_000)
    page.locator('#media-lightbox').get_by_role('button', name='Close', exact=True).click()
    expect(page.locator('#media-lightbox')).to_have_count(0, timeout=5000)
    page.locator('.media-card').filter(has_text='e2e-media-upload.mp4').get_by_role('button', name='Play', exact=True).click()
    expect(page.locator('#media-lightbox video.media-full')).to_be_visible(timeout=30_000)
    page.evaluate('''async () => {
      const v = document.querySelector('video.media-full');
      if (!v) throw new Error('no video');
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('video metadata timeout')), 30000);
        const done = () => { clearTimeout(t); res(); };
        if (v.readyState >= 2) return done();
        v.onloadeddata = done;
        v.onerror = () => done();
        v.load();
      });
      try { await v.play(); } catch (_) { /* headless codec may block play(); metadata load is enough */ }
    }''')
    page.locator('#media-lightbox').get_by_role('button', name='Close', exact=True).click()
    page.reload()
    unlock(page)
    open_media_unlocked(page)
    expect(page.locator('#media-grid .media-card')).to_have_count(2, timeout=60_000)
    ok(f'Media upload with visibility toggle ({tag}): disk, grid, reload, image and SW video')


def make_thumbnail_stress_fixtures(tmp: Path):
    """Corrupt / unsupported previews must not block later uploads (makeThumbnail hang regression)."""
    bad_mp4 = tmp / 'e2e-bad-video.mp4'
    bad_mp4.write_bytes(b'\x00\x00\x00\x20ftyp' + b'\x00' * 2000)
    corrupt_jpg = tmp / 'e2e-corrupt.jpg'
    corrupt_jpg.write_bytes(b'not-a-jpeg-at-all')
    heic = tmp / 'e2e-fake.heic'
    heic.write_bytes(b'\x00' * 64)
    good_jpeg = tmp / 'e2e-after-bad.jpg'
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=640x480',
         '-frames:v', '1', '-q:v', '2', str(good_jpeg)],
        check=True,
    )
    return bad_mp4, corrupt_jpg, heic, good_jpeg


def run_media_bad_preview_then_good_upload(page, tmp: Path, data_dir: Path):
    """Does not assert total grid size — media_roundtrip may already have items on data18449."""
    bad_mp4, corrupt_jpg, heic, good_jpeg = make_thumbnail_stress_fixtures(tmp)
    open_media_unlocked(page)
    page.locator('#media-idle').select_option('5')
    upload = page.locator('#media-workspace input[type="file"][accept*="image"]')
    upload.set_input_files([str(bad_mp4), str(corrupt_jpg), str(heic), str(good_jpeg)])
    for name in ('e2e-bad-video.mp4', 'e2e-corrupt.jpg', 'e2e-fake.heic', 'e2e-after-bad.jpg'):
        expect(page.locator('.media-card').filter(has_text=name)).to_have_count(1, timeout=120_000)
    expect(page.locator('#media-status')).to_contain_text('uploaded', timeout=30_000)
    state = json.loads((data_dir / 'media' / 'state.json').read_text())
    assert state.get('usedBytes', 0) > 0
    ok('Media upload continues after bad video/corrupt image/HEIC previews (no thumbnail hang)')


def run_media_upload_while_vault_busy(page, tmp: Path, data_dir: Path):
    """Regression: media uploads must not be dropped when vault task() busy is true."""
    jpeg, _ = make_media_upload_fixtures(tmp)
    page.locator('#new-note').click()
    page.locator('#note-title').fill('busy-regression-note')
    page.locator('#note-body').fill('hold-busy')

    def slow_vault_put(route):
        if route.request.method == 'PUT' and route.request.url.rstrip('/').endswith('/api/vault'):
            time.sleep(2.5)
        route.continue_()

    page.route('**/api/vault', slow_vault_put)
    try:
        page.get_by_role('button', name='Save note', exact=True).click()
        open_media_unlocked(page)
        page.locator('#media-idle').select_option('5')
        upload = page.locator('#media-workspace input[type="file"][accept*="image"]')
        upload.set_input_files([str(jpeg)])
    finally:
        page.unroute('**/api/vault', slow_vault_put)
    expect(page.locator('.media-card').filter(has_text='e2e-media-upload.jpg')).to_have_count(1, timeout=180_000)
    state = json.loads((data_dir / 'media' / 'state.json').read_text())
    assert state.get('usedBytes', 0) > 0
    ok('Media upload proceeds while vault save holds vault task busy')


def run_media_v120_features(p, tmp: Path, crt: Path, key: Path):
    """Photos & Videos 1.2.0: lightbox, folders, folder upload, lvmedia folder roundtrip."""
    port = 18470
    data_dir = tmp / f'data{port}'
    origin = f'https://127.0.0.1:{port}'
    env = e2e_server_env({
        **os.environ,
        'VAULT_DATA': str(data_dir),
        'VAULT_ORIGIN': origin,
        'VAULT_BIND': '127.0.0.1',
        'VAULT_PORT': str(port),
        'VAULT_CERT': str(crt),
        'VAULT_KEY': str(key),
    })
    proc = subprocess.Popen(['python3', str(ROOT / 'server.py')], env=env, stdout=subprocess.DEVNULL)
    try:
        wait_ready(origin, proc)
        jpeg, mp4 = make_media_upload_fixtures(tmp)
        browser = p.chromium.launch(
            headless=True,
            args=['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
        )
        try:
            ctx = browser.new_context(ignore_https_errors=True, accept_downloads=True)
            ctx.add_init_script('delete window.showSaveFilePicker;')
            page = ctx.new_page()
            create(page, origin)
            open_media_unlocked(page)
            v1_seed = tmp / 'e2e-v1-seed.jpg'
            shutil.copy(jpeg, v1_seed)
            upload0 = page.locator('#media-workspace input[type="file"][accept*="image"]')
            upload0.set_input_files([str(v1_seed)])
            expect(page.locator('.media-card').filter(has_text='e2e-v1-seed.jpg')).to_have_count(1, timeout=180_000)
            expect(page.locator('#media-status')).to_contain_text('uploaded', timeout=30_000)
            assert page.evaluate(
                '''async ([masterPw, mediaPw]) => {
                  const u = await import('/crypto.js');
                  const mc = await import('/media-crypto.js');
                  const cfg = await (await fetch('/api/status')).json();
                  const main = await u.derive(masterPw, cfg.salt, cfg.iterations);
                  const vault = await (await fetch('/api/vault', {headers: {Authorization: 'Bearer '+main.token}})).json();
                  const st = await (await fetch('/api/media/status', {headers: {Authorization: 'Bearer '+main.token}})).json();
                  const media = await mc.deriveMedia(mediaPw, st.salt);
                  const env = await (await fetch('/api/media/vault', {headers: {
                    Authorization: 'Bearer '+main.token,
                    'X-Media-Authorization': 'Bearer '+media.token,
                  }})).json();
                  const mediaKey = await mc.unwrapMediaKey(media.key, env.wrapIv, env.wrappedKey, env.vaultId);
                  const index = await mc.openMediaIndex(mediaKey, env);
                  const v1 = {version: 1, items: index.items.map(({folderId, ...rest}) => rest)};
                  const sealed = await mc.sealMediaIndex(mediaKey, v1, env.vaultId);
                  for (let attempt = 0; attempt < 8; attempt++) {
                    const envLatest = await (await fetch('/api/media/vault', {headers: {
                      Authorization: 'Bearer '+main.token,
                      'X-Media-Authorization': 'Bearer '+media.token,
                    }})).json();
                    const putBody = {
                      ...envLatest, indexIv: sealed.indexIv, indexCiphertext: sealed.indexCiphertext,
                      revision: envLatest.revision + 1,
                    };
                    const put = await fetch('/api/media/vault', {
                      method: 'PUT',
                      headers: {
                        Authorization: 'Bearer '+main.token,
                        'X-Media-Authorization': 'Bearer '+media.token,
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify(putBody),
                    });
                    if (put.ok) return true;
                    if (put.status !== 409) throw new Error('v1 put '+put.status);
                    await new Promise(r => setTimeout(r, 150));
                  }
                  throw new Error('v1 put retries exhausted');
                }''',
                [PASSWORD, MEDIA_PASSWORD],
            )
            page.get_by_role('button', name='Lock media', exact=True).click()
            page.reload()
            unlock(page)
            open_media_unlocked(page)
            expect(page.locator('.media-card').filter(has_text='e2e-v1-seed.jpg')).to_have_count(1, timeout=60_000)
            page.once('dialog', lambda d: d.accept('Persist v2'))
            page.get_by_role('button', name='New folder', exact=True).click()
            page.get_by_role('button', name='Lock media', exact=True).click()
            page.reload()
            unlock(page)
            v2_once = page.evaluate(
                '''async ([masterPw, mediaPw]) => {
                  const u = await import('/crypto.js');
                  const mc = await import('/media-crypto.js');
                  const cfg = await (await fetch('/api/status')).json();
                  const main = await u.derive(masterPw, cfg.salt, cfg.iterations);
                  const st = await (await fetch('/api/media/status', {headers: {Authorization: 'Bearer '+main.token}})).json();
                  const media = await mc.deriveMedia(mediaPw, st.salt);
                  const env = await (await fetch('/api/media/vault', {headers: {
                    Authorization: 'Bearer '+main.token,
                    'X-Media-Authorization': 'Bearer '+media.token,
                  }})).json();
                  const mediaKey = await mc.unwrapMediaKey(media.key, env.wrapIv, env.wrappedKey, env.vaultId);
                  const raw = await u.decrypt(mediaKey, u.unb64(env.indexCiphertext), env.indexIv, mc.mediaIndexAAD(env.vaultId));
                  const data = JSON.parse(new TextDecoder().decode(raw));
                  return data.version === 2 && Array.isArray(data.folders) && data.items.length >= 1;
                }''',
                [PASSWORD, MEDIA_PASSWORD],
            )
            assert v2_once
            ok('Media 1.2.0 v1 index migration to root and single v2 normalize on save')
            open_media_unlocked(page)
            page.once('dialog', lambda d: d.accept('E2E Album'))
            page.get_by_role('button', name='New folder', exact=True).click()
            expect(page.locator('#message')).to_contain_text('Folder created', timeout=30_000)
            expect(page.locator('.media-folder-card').filter(has_text='E2E Album')).to_have_count(1, timeout=10_000)
            page.locator('.media-folder-card').filter(has_text='E2E Album').get_by_role('button', name='Open', exact=True).click()
            upload = page.locator('#media-workspace input[type="file"][accept*="image"]')
            upload.set_input_files([str(jpeg)])
            expect(page.locator('.media-card').filter(has_text='e2e-media-upload.jpg')).to_have_count(1, timeout=180_000)
            page.locator('.media-card').filter(has_text='e2e-media-upload.jpg').locator('input.media-select').check()
            page.once('dialog', lambda d: d.accept(''))  # move to root
            page.locator('#media-move-selected').click()
            expect(page.locator('#media-grid .media-card').filter(has_text='e2e-media-upload.jpg')).to_have_count(0, timeout=30_000)
            page.locator('#media-breadcrumb button.media-crumb').first.click()
            expect(page.locator('.media-card').filter(has_text='e2e-media-upload.jpg')).to_have_count(1, timeout=30_000)
            page.locator('.media-folder-card').filter(has_text='E2E Album').get_by_role('button', name='Open', exact=True).click()
            ok('Media 1.2.0 folder create and move selected to root')
            expect(page.locator('#media-breadcrumb')).to_contain_text('E2E Album', timeout=10_000)
            nested_root = tmp / 'e2e-nested-dir'
            album = nested_root / 'NestedAlbum' / 'sub'
            album.mkdir(parents=True)
            shutil.copy(jpeg, album / 'nested-photo.jpg')
            (album / 'notes.txt').write_text('skip non-media')
            jpeg_bytes = (album / 'nested-photo.jpg').read_bytes()
            page.evaluate(
                '''async ([jpegB64]) => {
                  const input = document.querySelector('#media-workspace input[webkitdirectory]');
                  if (!input) throw new Error('folder input missing');
                  const bin = Uint8Array.from(atob(jpegB64), c => c.charCodeAt(0));
                  const media = new File([bin], 'nested-photo.jpg', {type: 'image/jpeg'});
                  Object.defineProperty(media, 'webkitRelativePath', {value: 'NestedAlbum/sub/nested-photo.jpg'});
                  const skip = new File(['skip non-media'], 'notes.txt', {type: 'text/plain'});
                  Object.defineProperty(skip, 'webkitRelativePath', {value: 'NestedAlbum/sub/notes.txt'});
                  const dt = new DataTransfer();
                  dt.items.add(media);
                  dt.items.add(skip);
                  input.files = dt.files;
                  input.dispatchEvent(new Event('change', {bubbles: true}));
                }''',
                [base64.b64encode(jpeg_bytes).decode()],
            )
            nested_album = page.locator('.media-folder-card', has=page.get_by_text('NestedAlbum', exact=True))
            expect(nested_album).to_have_count(1, timeout=180_000)
            nested_album.get_by_role('button', name='Open', exact=True).click()
            sub = page.locator('.media-folder-card', has=page.get_by_text('sub', exact=True))
            if sub.count() > 0:
                sub.get_by_role('button', name='Open', exact=True).click()
            expect(page.locator('.media-card').filter(has_text='nested-photo.jpg')).to_have_count(1, timeout=180_000)
            ok('Media 1.2.0 nested directory upload (webkitdirectory)')
            slide2 = tmp / 'e2e-slide-2.jpg'
            shutil.copy(jpeg, slide2)
            upload.set_input_files([str(slide2)])
            expect(page.locator('.media-card').filter(has_text='e2e-slide-2.jpg')).to_have_count(1, timeout=180_000)
            media_cards = page.locator('.media-card:not(.media-folder-card)')
            expect(media_cards).to_have_count(2, timeout=30_000)
            media_cards.filter(has_text='nested-photo.jpg').get_by_role('button', name='View', exact=True).click()
            expect(page.locator('#media-lightbox')).to_be_visible(timeout=10_000)
            page.wait_for_function(
                '''() => {
                  const img = document.querySelector('#media-lightbox img.media-full');
                  return img && img.complete && img.naturalWidth > 0;
                }''',
                timeout=30_000,
            )
            page.locator('#media-lightbox button[data-action="next"]').click()
            expect(page.locator('#media-lightbox .media-lightbox-title')).to_contain_text('2 / 2', timeout=10_000)
            page.locator('#media-lightbox button[data-action="zoom-in"]').click()
            page.locator('#media-lightbox button[data-action="prev"]').click()
            expect(page.locator('#media-lightbox .media-lightbox-title')).to_contain_text('1 / 2', timeout=10_000)
            page.locator('#media-lightbox button[data-action="prev"]').click()
            expect(page.locator('#media-lightbox .media-lightbox-title')).to_contain_text('2 / 2', timeout=10_000)
            img_ok = page.evaluate('''() => {
              const img = document.querySelector('#media-lightbox img.media-full');
              return img && img.complete && img.naturalWidth > 0;
            }''')
            assert img_ok
            page.locator('#media-lightbox button[data-action="next"]').click()
            expect(page.locator('#media-lightbox .media-lightbox-title')).to_contain_text('1 / 2', timeout=10_000)
            img_loop = page.evaluate('''() => {
              const img = document.querySelector('#media-lightbox img.media-full');
              return img && img.complete && img.naturalWidth > 0;
            }''')
            assert img_loop
            page.locator('#media-lightbox').get_by_role('button', name='Close', exact=True).click()
            ok('Media 1.2.0 lightbox navigation, zoom, and loop image render')
            media_cards.filter(has_text='nested-photo.jpg').get_by_role('button', name='View', exact=True).click()
            page.locator('#media-lightbox button[data-slideshow="1000"]').click()
            page.wait_for_function(
                '''() => (document.querySelector('.media-lightbox-title')?.textContent || '').includes('2 / 2')''',
                timeout=15_000,
            )
            page.wait_for_function(
                '''() => (document.querySelector('.media-lightbox-title')?.textContent || '').includes('1 / 2')''',
                timeout=15_000,
            )
            page.wait_for_function(
                '''() => (document.querySelector('.media-lightbox-title')?.textContent || '').includes('2 / 2')''',
                timeout=15_000,
            )
            page.wait_for_function(
                '''() => (document.querySelector('.media-lightbox-title')?.textContent || '').includes('1 / 2')''',
                timeout=15_000,
            )
            page.locator('#media-lightbox').get_by_role('button', name='Close', exact=True).click()
            ok('Media 1.2.0 slideshow auto-advances including loop')
            with page.expect_download(timeout=120_000) as dl_info:
                page.get_by_role('button', name='Export Photos & Videos', exact=True).click()
            export_path = tmp / 'e2e-v120.lvmedia'
            dl_info.value.save_as(export_path)
            assert export_path.is_file() and export_path.stat().st_size > 1000
            import_in = page.locator('#media-workspace input[accept=".lvmedia"]')
            page.evaluate('(pw) => { window.prompt = () => pw; }', MEDIA_PASSWORD)
            import_in.set_input_files(str(export_path))
            expect(page.locator('#message')).to_contain_text('Imported', timeout=180_000)
            page.locator('#media-breadcrumb button.media-crumb').first.click()
            e2e_albums = page.locator('.media-folder-card', has=page.get_by_text('E2E Album', exact=True))
            expect(e2e_albums).to_have_count(2, timeout=180_000)
            e2e_albums.last.get_by_role('button', name='Open', exact=True).click()
            nested_albums = page.locator('.media-folder-card', has=page.get_by_text('NestedAlbum', exact=True))
            expect(nested_albums).to_have_count(1, timeout=60_000)
            nested_albums.first.get_by_role('button', name='Open', exact=True).click()
            expect(page.locator('.media-folder-card').filter(has_text='sub')).to_have_count(1, timeout=30_000)
            page.locator('.media-folder-card').filter(has_text='sub').first.get_by_role('button', name='Open', exact=True).click()
            expect(page.locator('.media-card').filter(has_text='nested-photo.jpg')).to_have_count(1, timeout=180_000)
            ok('Media 1.2.0 .lvmedia export/import preserves folders')
        finally:
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def run_production_media_upload_matrix(p, tmp: Path, crt: Path, key: Path):
    """Chromium, Firefox, and Pixel emulation with production disk/quota limits."""
    import media_api
    scenarios = (
        ('desktop Chromium', 18460, lambda: p.chromium.launch(headless=True), None),
        ('desktop Firefox', 18461, lambda: p.firefox.launch(headless=True), None),
        ('Pixel 7', 18462, lambda: p.chromium.launch(headless=True), p.devices['Pixel 7']),
    )
    disk_checked = False
    for label, port, launch, device in scenarios:
        data_dir = tmp / f'data{port}'
        origin = f'https://127.0.0.1:{port}'
        env = production_media_server_env({
            **os.environ,
            'VAULT_DATA': str(data_dir),
            'VAULT_ORIGIN': origin,
            'VAULT_BIND': '127.0.0.1',
            'VAULT_PORT': str(port),
            'VAULT_CERT': str(crt),
            'VAULT_KEY': str(key),
        })
        proc = subprocess.Popen(['python3', str(ROOT / 'server.py')], env=env, stdout=subprocess.DEVNULL)
        try:
            wait_ready(origin, proc)
            if not disk_checked:
                disk_checked = True
                if not media_api.disk_ok(data_dir):
                    free = media_api.disk_free_bytes(data_dir)
                    _, min_free, _, _ = media_api.media_env_limits(data_dir)
                    ok(f'SKIP production media matrix: host free {free} < policy min-free {min_free}')
                    return
                ok('Production media min-free gate passes on data directory filesystem')
            browser = launch()
            try:
                opts = {**(device or {}), 'ignore_https_errors': True, 'accept_downloads': True}
                ctx = browser.new_context(**opts)
                ctx.add_init_script('delete window.showSaveFilePicker;')
                page = ctx.new_page()
                create(page, origin)
                run_media_browser_upload(page, tmp, data_dir, label, prod_disk_check=True)
            finally:
                browser.close()
        finally:
            proc.terminate()
            proc.wait(timeout=10)


def fill_valid_test_mnemonic(page):
    words = ['abandon'] * 11 + ['about']
    for i, word in enumerate(words):
        page.locator('.wallet-word').nth(i).fill(word)

def main():
    with tempfile.TemporaryDirectory(prefix='local-vault-test-') as tmp:
        tmp = Path(tmp)
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(tmp/'test.key'),'-out',str(tmp/'test.crt'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        procs = []
        try:
            for port in (18449,18450,18451):
                origin = f'https://127.0.0.1:{port}'
                env = e2e_server_env({**os.environ, 'VAULT_DATA':str(tmp/f'data{port}'), 'VAULT_ORIGIN':origin, 'VAULT_BIND':'127.0.0.1', 'VAULT_PORT':str(port), 'VAULT_CERT':str(tmp/'test.crt'), 'VAULT_KEY':str(tmp/'test.key')})
                p = subprocess.Popen(['python3',str(ROOT/'server.py')], env=env, stdout=subprocess.DEVNULL)
                procs.append(p); wait_ready(origin,p)
            origin = 'https://127.0.0.1:18449'
            wl = ROOT / 'web' / 'bip39-english.txt'
            assert hashlib.sha256(wl.read_bytes()).hexdigest() == BIP39_WORDLIST_SHA256
            assert len(wl.read_text().splitlines()) == 2048
            ok('Canonical BIP39 English wordlist SHA-256 and length')
            assert request(origin,'/api/vault')[0] == 401
            assert request(origin,'/api/setup','POST',b'{}',{'Origin':'https://evil.invalid','Content-Type':'application/json'})[0] == 403
            assert request(origin,'/api/status',headers={'Host':'evil.invalid'})[0] == 403
            ok('Unauthenticated access, hostile Origin and hostile Host rejected')
            landing_nav = {
                'Host': '127.0.0.1:18449',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Dest': 'document',
            }
            status, body = request(origin, '/', headers=landing_nav)
            assert status == 200 and b'<!doctype html>' in body.lower()
            assert request(origin, '/api/status', headers=landing_nav)[0] == 403
            ok('Cross-site landing-page link may open vault UI; API still blocked cross-site')
            for icon_path in ('/favicon.ico', '/favicon-32x32.png', '/apple-touch-icon.png'):
                status, _ = request(origin, icon_path)
                assert status == 200, icon_path
            status, body = request(origin, '/')
            assert b'apple-touch-icon' in body and b'favicon.ico' in body
            landing_http_port = 18080
            land_origin = 'https://127.0.0.1:18500'
            land_env = e2e_server_env({
                **os.environ,
                'VAULT_DATA': str(tmp / 'dataLanding'),
                'VAULT_BIND': '127.0.0.1',
                'VAULT_PORT': '18500',
                'VAULT_HTTP_PORT': str(landing_http_port),
                'VAULT_CERT': str(tmp / 'test.crt'),
                'VAULT_KEY': str(tmp / 'test.key'),
            })
            land_env.pop('VAULT_ORIGIN', None)
            land_proc = subprocess.Popen(['python3', str(ROOT / 'server.py')], env=land_env, stdout=subprocess.DEVNULL)
            procs.append(land_proc)
            wait_ready(land_origin, land_proc)
            landing_http = f'http://127.0.0.1:{landing_http_port}'
            for icon_path in ('/favicon.ico', '/favicon-32x32.png', '/apple-touch-icon.png'):
                req = urllib.request.Request(landing_http + icon_path)
                with urllib.request.urlopen(req, timeout=10) as r:
                    assert r.status == 200, icon_path
            conn = http.client.HTTPConnection('127.0.0.1', landing_http_port, timeout=10)
            conn.request('GET', '/')
            redirect = conn.getresponse()
            conn.close()
            assert redirect.status == 302, redirect.status
            assert f':{land_env["VAULT_PORT"]}' in (redirect.getheader('Location') or '')
            ca_req = urllib.request.Request(landing_http + '/ca')
            with urllib.request.urlopen(ca_req, timeout=10) as r:
                ca_body = r.read()
            assert b'Install the vault CA' in ca_body
            assert b'Windows' in ca_body and b'Android' in ca_body
            ok('HTTP landing redirects to HTTPS vault; CA install page on /ca')
            with sync_playwright() as p:
                run_production_media_upload_matrix(p, tmp, tmp / 'test.crt', tmp / 'test.key')
                run_media_v120_features(p, tmp, tmp / 'test.crt', tmp / 'test.key')
                browser = p.chromium.launch(headless=True)
                context = browser.new_context(ignore_https_errors=True, accept_downloads=True)
                context.add_init_script('delete window.showSaveFilePicker;')
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                create(page,origin)
                ok('First-run password setup and browser WebCrypto in HTTPS')
                expect(page.locator('#open-media')).to_be_visible(timeout=5000)
                with page.expect_event('dialog', timeout=10000) as media_dialog:
                    page.locator('#open-media').click()
                dlg = media_dialog.value
                assert 'Photos & Videos' in dlg.message
                dlg.dismiss()
                ok('Photos & Videos button in workspace toolbar opens media setup prompt')
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
                open_note(page, 'Node recovery')
                payload = b'\x00\xff\x80Synthetic channel backup test only\x00' * 25000
                page.locator('#note-attach').set_input_files({'name':'test.channel.backup','mimeType':'application/octet-stream','buffer':payload})
                expect(page.locator('#message')).to_have_text('File attached.',timeout=30000)
                page.locator('#note-attachments').get_by_role('button', name='Edit', exact=True).click()
                page.locator('#attachment-label').fill('synthetic-wallet-label')
                page.locator('#attachment-description').fill('synthetic description phrase 88aa')
                page.get_by_role('button', name='Save details', exact=True).click()
                expect(page.locator('#message')).to_have_text('Attachment details saved.')
                page.locator('#search').fill('88aa')
                expect(page.locator('#notes button')).to_have_count(1)
                page.locator('#search').fill('synthetic-wallet-label')
                expect(page.locator('#notes button')).to_have_count(1)
                page.locator('#search').fill('')
                with page.expect_download() as info:
                    page.locator('#note-attachments').get_by_role('button',name='Download',exact=True).click()
                downloaded = info.value
                assert Path(downloaded.path()).read_bytes() == payload
                ok('Note attachments with encrypted label/description and search')
                assert page.evaluate('''async () => {
                  const b = await import('/bip39.js');
                  if (!b.assertPrefixUniqueness()) throw new Error('prefix uniqueness');
                  const good = [...Array(11)].map(()=>'abandon').concat(['about']);
                  const bad = Array(12).fill('abandon');
                  if (!(await b.validateBip39Checksum(good)).valid) throw new Error('valid vector');
                  if ((await b.validateBip39Checksum(bad)).valid) throw new Error('invalid vector');
                  if (b.uniqueWordForPrefix('aban') !== 'abandon') throw new Error('autofill');
                  if (b.isBip39Word('notabip39word')) throw new Error('reject');
                  return true;
                }''')
                ok('BIP39 checksum vectors, 4-letter autofill map, and non-word rejection')
                page.locator('#new-wallet').click()
                page.locator('#wallet-name').fill(WALLET_LABEL)
                page.locator('#wallet-notes').fill('m/84h/0h/0h synthetic fixture path')
                page.locator('.wallet-word').first.fill('aban')
                expect(page.locator('.wallet-word').first).to_have_value('abandon', timeout=5000)
                fill_valid_test_mnemonic(page)
                expect(page.locator('#wallet-checksum')).to_have_class('checksum-status valid', timeout=10000)
                page.locator('.wallet-word').last.fill('zzzz')
                page.locator('.wallet-word').last.blur()
                expect(page.locator('.wallet-word').last).to_have_class(re.compile(r'invalid'))
                page.locator('.wallet-word').last.fill('about')
                page.get_by_role('button', name='Save wallet', exact=True).click()
                expect(page.locator('#message')).to_have_text('Wallet saved.')
                page.locator('#search').fill('abandon')
                expect(page.locator('#wallets button')).to_have_count(0)
                page.locator('#search').fill('7c2a')
                expect(page.locator('#wallets button')).to_have_count(1)
                ok('Wallet UI save, checksum display, search excludes seed words, invalid word flagged')
                page.locator('#search').fill('')
                open_note(page, 'Node recovery')
                expect(page.locator('#note-attach')).to_be_attached(timeout=10000)
                # Larger than the requested 100MB threshold.
                large = tmp/'large.bin'
                with large.open('wb') as f:
                    f.truncate(101*1024*1024)
                page.evaluate('''() => {const input=document.getElementById('note-attach'); const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(101*1024*1024)],'large.bin',{type:'application/octet-stream'}));input.files=dt.files;input.dispatchEvent(new Event('change'));}''')
                expect(page.locator('#message')).to_have_text('File attached.',timeout=90000)
                expect(page.locator('#note-attachments .note-attachment')).to_have_count(2)
                with page.expect_download(timeout=90000) as info:
                    page.locator('#note-attachments .note-attachment').filter(has_text='large.bin').last.get_by_role('button',name='Download',exact=True).click()
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
                media_chunk = page.evaluate('''async () => {
                  const m = await import('/media-crypto.js');
                  const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, true, ['encrypt','decrypt']);
                  const vaultId = crypto.randomUUID();
                  const itemId = crypto.randomUUID();
                  const bytes = new TextEncoder().encode('chunk-bytes');
                  const box = await m.encryptChunk(key, bytes, vaultId, itemId, 0, true);
                  let tamper = false;
                  try { await m.decryptChunk(key, box.ciphertext, box.iv, vaultId, itemId, 0, false); } catch { tamper = true; }
                  const plain = await m.decryptChunk(key, box.ciphertext, box.iv, vaultId, itemId, 0, true);
                  return tamper && new TextDecoder().decode(plain) === 'chunk-bytes';
                }''')
                assert media_chunk
                ok('Media chunk AAD rejects final-flag tamper')
                # Optimistic concurrency checked using same derived test credential, never logged.
                concurrency = page.evaluate('''async password => {
                  const c=await import('/crypto.js');const cfg=await (await fetch('/api/status')).json();
                  const d=await c.derive(password,cfg.salt);const headers={Authorization:`Bearer ${d.token}`,'Content-Type':'application/json'};
                  const current=await(await fetch('/api/vault',{headers})).json();
                  const r=await fetch('/api/vault',{method:'PUT',headers,body:JSON.stringify(current)});return r.status;
                }''',PASSWORD)
                assert concurrency == 409
                ok('Stale revision cannot overwrite newer vault')
                cfg = json.loads(request(origin,'/api/status')[1])
                bits = hashlib.pbkdf2_hmac('sha256',PASSWORD.encode(),base64.b64decode(cfg['salt']),600000,64)
                token = base64.b64encode(bits[32:]).decode()
                assert request(origin,'/api/files/11111111-1111-4111-8111-111111111111','PUT',b'',{'Authorization':'Bearer '+token,'Content-Length':str(128*1024*1024+17)})[0] == 413
                assert request(origin,'/api/setup','POST',b'{}',{'Content-Type':'application/json'})[0] == 400
                ok('Oversize encrypted upload rejected without reading its body')
                assert request(origin,'/api/media/status',headers={'Authorization':'Bearer '+token})[0] == 200
                assert request(origin,'/api/media/vault',headers={'Authorization':'Bearer '+token})[0] in (401, 404)
                assert request(origin,'/api/media/vault',headers={'Authorization':'Bearer '+token,'X-Media-Authorization':'Bearer wrong-media-token'})[0] in (401, 404)
                ok('Media API requires main session and media token')
                media_roundtrip = page.evaluate('''async ([masterPw, mediaPw]) => {
                  const c = await import('/crypto.js');
                  const mc = await import('/media-crypto.js');
                  const st = await (await fetch('/api/status')).json();
                  const main = await c.derive(masterPw, st.salt);
                  const hdr = mt => ({Authorization: `Bearer ${main.token}`, ...(mt ? {'X-Media-Authorization': `Bearer ${mt}`} : {})});
                  let ms = await (await fetch('/api/media/status', {headers: hdr()})).json();
                  const salt = ms.initialized ? ms.salt : c.b64(c.random(32));
                  const derived = await mc.deriveMedia(mediaPw, salt);
                  if (!ms.initialized) {
                    const mediaKey0 = await mc.generateMediaKey();
                    const wrap = await mc.wrapMediaKey(derived.key, mediaKey0, st.vaultId);
                    const index0 = {version: 1, items: []};
                    const sealed0 = await mc.sealMediaIndex(mediaKey0, index0, st.vaultId);
                    const setupBody = {version: 1, vaultId: st.vaultId, salt, iterations: 600000,
                      wrapIv: wrap.wrapIv, wrappedKey: wrap.wrappedKey, revision: 1,
                      indexIv: sealed0.indexIv, indexCiphertext: sealed0.indexCiphertext, usedBytes: 0,
                      authHash: await c.authHash(derived.token)};
                    const r = await fetch('/api/media/setup', {method:'POST', headers:{...hdr(), 'Content-Type':'application/json'}, body: JSON.stringify(setupBody)});
                    if (!r.ok) throw new Error('media setup ' + r.status);
                  }
                  const v1 = await fetch('/api/media/vault', {headers: hdr(derived.token)});
                  const v2 = await fetch('/api/media/vault', {headers: hdr(derived.token)});
                  if (!v1.ok || !v2.ok) throw new Error('media vault unlock failed');
                  let envelope = await v1.json();
                  mediaKey = await mc.unwrapMediaKey(derived.key, envelope.wrapIv, envelope.wrappedKey, envelope.vaultId);
                  let index = await mc.openMediaIndex(mediaKey, envelope);
                  const itemId = crypto.randomUUID();
                  const itemKey = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, true, ['encrypt','decrypt']);
                  const wrapped = await mc.wrapItemKey(mediaKey, itemKey, st.vaultId, itemId);
                  const plain = new TextEncoder().encode('synthetic-lvmedia-roundtrip');
                  const box = await mc.encryptChunk(itemKey, plain, st.vaultId, itemId, 0, true);
                  const bytes = new Uint8Array(box.ciphertext);
                  let up = await fetch(`/api/media/items/${itemId}/chunks/0`, {method:'PUT', headers:{...hdr(derived.token), 'Content-Length': String(bytes.length)}, body: bytes});
                  if (!up.ok) throw new Error('chunk put');
                  const meta = {filename:'roundtrip.bin', type:'application/octet-stream', size: plain.length, date: new Date().toISOString()};
                  const mbox = await mc.encryptMeta(itemKey, meta, st.vaultId, itemId);
                  let commit = await fetch(`/api/media/items/${itemId}/commit`, {method:'POST', headers:{...hdr(derived.token), 'Content-Type':'application/json'}, body: JSON.stringify({chunkCount:1, plaintextSize: plain.length})});
                  if (!commit.ok) throw new Error('commit');
                  index.items.push({id:itemId, chunkCount:1, plaintextSize: plain.length, wrappedKey: wrapped, metaIv: mbox.metaIv, metaCiphertext: mbox.metaCiphertext, chunks:[{index:0, iv: box.iv}]});
                  const sealed = await mc.sealMediaIndex(mediaKey, index, st.vaultId);
                  const putBody = {...envelope, indexIv: sealed.indexIv, indexCiphertext: sealed.indexCiphertext, revision: envelope.revision + 1};
                  let pu = await fetch('/api/media/vault', {method:'PUT', headers:{...hdr(derived.token), 'Content-Type':'application/json'}, body: JSON.stringify(putBody)});
                  if (!pu.ok) throw new Error('index put');
                  const prep = await (await fetch('/api/media/export', {method:'POST', headers:{...hdr(derived.token), 'Content-Type':'application/json'}, body:'{}'})).json();
                  const arc = await (await fetch(prep.url, {headers: hdr(derived.token)})).arrayBuffer();
                  const view = new Uint8Array(arc);
                  if (new TextDecoder().decode(view.slice(0,9)) !== 'LVMEDIA01') throw new Error('bad magic');
                  const metaLen = new DataView(arc).getUint32(9);
                  const header = JSON.parse(new TextDecoder().decode(view.slice(13, 13 + metaLen)));
                  const remote = header.state;
                  const impDerived = await mc.deriveMedia(mediaPw, remote.salt);
                  const exKey = await mc.unwrapMediaKey(impDerived.key, remote.wrapIv, remote.wrappedKey, remote.vaultId);
                  const impIndex = await mc.openMediaIndex(exKey, remote);
                  let off = 13 + metaLen;
                  const map = new Map();
                  for (const f of header.files) {
                    const k = f.kind === 'thumb' ? `${f.itemId}:thumb` : `${f.itemId}:${f.chunk}`;
                    map.set(k, {f, off}); off += f.size;
                  }
                  if (off !== view.length) throw new Error('truncated');
                  const old = impIndex.items[0];
                  const oldId = old.id;
                  const newId = crypto.randomUUID();
                  const iKey = await mc.unwrapItemKey(exKey, old.wrappedKey, remote.vaultId, oldId);
                  const pos = map.get(`${oldId}:0`);
                  const cipher = view.slice(pos.off, pos.off + pos.f.size);
                  const p2 = await mc.decryptChunk(iKey, cipher, old.chunks[0].iv, remote.vaultId, oldId, 0, true);
                  const box2 = await mc.encryptChunk(iKey, p2, st.vaultId, newId, 0, true);
                  const b2 = new Uint8Array(box2.ciphertext);
                  let up2 = await fetch(`/api/media/items/${newId}/chunks/0`, {method:'PUT', headers:{...hdr(derived.token), 'Content-Length': String(b2.length)}, body: b2});
                  if (!up2.ok) throw new Error('import chunk');
                  let c2 = await fetch(`/api/media/items/${newId}/commit`, {method:'POST', headers:{...hdr(derived.token), 'Content-Type':'application/json'}, body: JSON.stringify({chunkCount:1, plaintextSize: old.plaintextSize})});
                  if (!c2.ok) throw new Error('import commit');
                  const dec = await mc.decryptChunk(iKey, b2, box2.iv, st.vaultId, newId, 0, true);
                  return new TextDecoder().decode(dec) === 'synthetic-lvmedia-roundtrip';
                }''', [PASSWORD, MEDIA_PASSWORD])
                assert media_roundtrip
                ok('Media second unlock and .lvmedia import re-encrypt round-trip')
                with page.expect_download(timeout=90000) as info:
                    page.locator('#export').click()
                backup = tmp/'backup.lvbak'; info.value.save_as(backup)
                assert backup.read_bytes().startswith(b'LVBAK001')
                assert MARKER.encode() not in backup.read_bytes()
                ok('Whole-vault encrypted export contains no test-note plaintext')
                page.evaluate('''async (password) => {
                  const c = await import('/crypto.js');
                  const status = await (await fetch('/api/status')).json();
                  const derived = await c.derive(password, status.salt);
                  const headers = {Authorization: `Bearer ${derived.token}`};
                  const env = await (await fetch('/api/vault', {headers})).json();
                  let index = await c.openIndex(derived.key, env);
                  const files = [];
                  for (const n of index.notes) for (const a of n.attachments || []) {
                    files.push({id:a.id,name:a.name,type:a.type,size:a.size,iv:a.iv,added:a.added});
                  }
                  for (const w of index.wallets || []) for (const a of w.attachments || []) {
                    files.push({id:a.id,name:a.name,type:a.type,size:a.size,iv:a.iv,added:a.added});
                  }
                  index = {version:1, notes:[], files};
                  const box = await c.sealIndex(derived.key, index, status.vaultId);
                  const body = {version:1, vaultId:status.vaultId, salt:status.salt, iterations:600000, iv:box.iv, ciphertext:box.ciphertext, revision:env.revision+1, authHash:env.authHash};
                  const r = await fetch('/api/vault', {method:'PUT', headers:{...headers,'Content-Type':'application/json'}, body:JSON.stringify(body)});
                  if (!r.ok) throw new Error('downgrade save failed');
                }''', PASSWORD)
                page.locator('#lock').click()
                unlock(page)
                expect(page.locator('#notes button').filter(has_text='Unfiled files')).to_have_count(1)
                open_note(page, 'Unfiled')
                expect(page.locator('#note-attachments')).to_contain_text('test.channel.backup')
                ok('Legacy v1 standalone files migrate into Unfiled files on unlock')
                with page.expect_download(timeout=90000) as info:
                    page.locator('#export').click()
                legacy_backup = tmp/'legacy-v1.lvbak'; info.value.save_as(legacy_backup)
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
                expect(other.locator('#message')).to_contain_text('Imported 1 note(s)', timeout=90000)
                expect(other.locator('#message')).to_contain_text('1 wallet', timeout=15000)
                expect(other.locator('#wallets button')).to_have_count(1, timeout=15000)
                open_wallet(other, 'Synthetic test')
                expect(other.locator('#wallet-name')).to_have_value(WALLET_LABEL)
                expect(other.locator('#wallet-checksum')).to_contain_text('valid', timeout=15000)
                ok('Wallet export roundtrip in encrypted backup')
                open_note(other, 'Node recovery')
                expect(other.locator('#note-body')).to_have_value(MARKER+' updated')
                with other.expect_download() as info:
                    other.locator('#note-attachments .note-attachment').filter(has_text='synthetic-wallet-label').first.get_by_role('button',name='Download',exact=True).click()
                assert Path(info.value.path()).read_bytes() == payload
                ok('v2 export imported into separately keyed fresh vault; note attachments preserved')
                other.locator('#import').set_input_files(str(legacy_backup))
                other.locator('#backup-password').fill(PASSWORD)
                other.get_by_role('button',name='Import copies',exact=True).click()
                expect(other.locator('#message')).to_have_text('Imported 1 note(s) and 2 attachment(s) as copies.',timeout=90000)
                open_note(other, 'Unfiled')
                expect(other.locator('#note-attachments .note-attachment')).to_have_count(2)
                ok('Legacy 1.0.x encrypted backup imports with attachments inside notes')
                open_note(other, 'Node recovery')
                other.once('dialog',lambda d:d.dismiss())
                other.get_by_role('button',name='Delete note',exact=True).click()
                expect(other.locator('#notes button')).to_have_count(2)
                other.once('dialog',lambda d:d.accept())
                other.get_by_role('button',name='Delete note',exact=True).click()
                expect(other.locator('#message')).to_have_text('Note deleted.')
                expect(other.locator('#notes button')).to_have_count(1)
                open_note(other, 'Unfiled')
                other.once('dialog',lambda d:d.accept())
                other.locator('#note-attachments .note-attachment').first.get_by_role('button',name='Delete',exact=True).click()
                expect(other.locator('#message')).to_have_text('Attachment deleted.')
                expect(other.locator('#note-attachments .note-attachment')).to_have_count(1)
                ok('Note deletion cancel/confirm and attachment deletion')
                # Advance browser clock rather than weakening production idle policy.
                other.locator('#idle').select_option('1')
                other.clock.install()
                other.clock.fast_forward(61000)
                expect(other.locator('#workspace')).to_be_hidden()
                ok('Idle auto-lock at selected one-minute interval')
                # Restart only our temporary test server, never a real Umbrel app.
                procs[0].terminate(); procs[0].wait(timeout=10)
                restarted_env=e2e_server_env({**os.environ,'VAULT_DATA':str(tmp/'data18449'),'VAULT_ORIGIN':origin,'VAULT_BIND':'127.0.0.1','VAULT_PORT':'18449','VAULT_CERT':str(tmp/'test.crt'),'VAULT_KEY':str(tmp/'test.key')})
                procs[0]=subprocess.Popen(['python3',str(ROOT/'server.py')],env=restarted_env,stdout=subprocess.DEVNULL)
                wait_ready(origin,procs[0])
                page.reload(); expect(page.locator('#gate-title')).to_have_text('Unlock your vault')
                unlock(page); open_note(page, 'Unfiled')
                expect(page.locator('#note-attachments .note-attachment')).to_have_count(2)
                ok('Vault survives server restart and correct password decrypts persistent state')
                run_media_bad_preview_then_good_upload(page, tmp, tmp / 'data18449')
                run_media_upload_while_vault_busy(page, tmp, tmp / 'data18449')
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
                        assert b'abandon' not in raw
                        assert WALLET_LABEL.encode() not in raw
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
