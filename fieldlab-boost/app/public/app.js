'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n).toLocaleString();
async function api(path, body) {
  const r = await fetch('api/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Error'); return j;
}
function toast(msg) { const t = $('toast'); t.style.background = /^Saved/.test(msg) ? 'var(--ok)' : ''; t.textContent = msg; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 5000); }
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('main section').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'history') loadHistory();
  if (b.dataset.tab === 'wallet') guard(loadWallet)();
});
const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" fill="#2a2f38"/><text x="36" y="46" font-size="30" text-anchor="middle" fill="#8a93a0">🎙</text></svg>');
let feedUrl = null, plan = null, payDec = null, loaded = null, savedList = [];
async function init() {
  const s = await api('status');
  $('dry').classList.toggle('hidden', !s.dryRun); $('searchBox').classList.toggle('hidden', !s.search); $('sender').value = s.senderName;
  try {
    const m = await api('summary');
    if (!m.ready) { $('summary').innerHTML = m.state === 'NON_EXISTING' ? 'Boost wallet not set up yet · <b>open the Wallet tab</b>' : `Boost wallet is starting (${esc(m.state)})…`; if (m.state === 'NON_EXISTING') $('navWallet').click(); return; }
    $('summary').innerHTML = `<b>${esc(m.alias)}</b> · ${m.activeChannels} active ch · ${m.synced ? '<span class="ok">synced</span>' : '<span class="bad">not synced</span>'}<br>Can send <b>${fmt(m.localSats)}</b> sats · can receive <b>${fmt(m.remoteSats)}</b> sats`;
  } catch (e) { $('summary').innerHTML = `<span class="bad">Can't reach LND: ${esc(e.message)}</span>`; }
}
$('btnSearch').onclick = guard(async () => {
  const r = await api('search?q=' + encodeURIComponent($('q').value));
  $('results').innerHTML = r.results.map((f, i) => `<div class="res" data-i="${i}"><b>${esc(f.title)}</b><div class="muted">${esc(f.author)}</div></div>`).join('') || '<div class="muted">No results</div>';
  $('results').querySelectorAll('.res').forEach(el => el.onclick = () => { $('feedUrl').value = r.results[el.dataset.i].url; $('btnFeed').click(); });
});
async function loadFeed() {
  feedUrl = $('feedUrl').value.trim();
  const f = await api('feed', { url: feedUrl });
  $('showTitle').textContent = f.title; $('showAuthor').textContent = (f.author || '') + (f.hasValue ? '' : ' · ⚠ no value block');
  $('art').onerror = () => { $('art').onerror = null; $('art').src = PLACEHOLDER; }; $('art').src = f.image || PLACEHOLDER; $('episode').innerHTML = f.episodes.map(e => `<option value="${e.idx}">${esc(e.title)}</option>`).join('');
  $('show').classList.remove('hidden'); $('preview').classList.add('hidden');
  loaded = { name: f.title, feedUrl, artwork: f.image || '' };
  const i = savedList.findIndex(s => s.feedUrl === feedUrl); $('saved').value = i >= 0 ? String(i) : ''; syncSaved();
}
$('btnFeed').onclick = guard(loadFeed);
document.querySelectorAll('[data-amt]').forEach(b => b.onclick = () => { $('boostSats').value = b.dataset.amt; });
$('btnPreview').onclick = guard(async () => {
  plan = await api('boost/preview', { feedUrl, episode: Number($('episode').value), sats: Number($('boostSats').value), message: $('message').value, senderName: $('sender').value });
  const rows = plan.payees.map(p => `<tr><td>${esc(p.name)}<div class="muted">${p.type === 'node' ? 'keysend ' + esc(p.address.slice(0, 10)) + '…' : esc(p.address)}${p.fee ? ' · fee' : ''}${p.supported ? '' : ' · <span class="bad">unsupported</span>'}</div></td><td class="r">${p.split}${p.fee ? '%' : ''}</td><td class="r"><b>${fmt(p.sats)}</b></td></tr>`).join('');
  $('preview').innerHTML = `<h2>Confirm boost</h2><p>Show: <b>${esc(plan.show)}</b><br>Episode: ${esc(plan.episode || '—')}<br>Total: <b>${fmt(plan.sats)} sats</b><br>Message: ${esc(plan.message || '—')}</p>
    <table><tr><td class="muted">Payee</td><td class="r muted">Split</td><td class="r muted">Sats</td></tr>${rows}</table>
    <button id="btnSend" class="primary">${plan.dryRun ? 'Send (dry run)' : 'Send ' + fmt(plan.sats) + ' sats'}</button><button id="btnCancel">Cancel</button>`;
  $('preview').classList.remove('hidden');
  $('btnCancel').onclick = () => $('preview').classList.add('hidden');
  $('btnSend').onclick = guard(async () => {
    $('btnSend').disabled = true;
    const r = await api('boost/send', { planId: plan.id, confirm: true });
    $('preview').innerHTML = `<h2>${r.dryRun ? 'Dry run done' : 'Boost sent'}</h2>` + r.results.map(x => `<div>${esc(x.name)}: ${fmt(x.sats)} sats – <span class="${x.status === 'failed' ? 'bad' : 'ok'}">${esc(x.status)}</span> ${esc(x.error || '')}</div>`).join('');
    init();
  });
});
$('btnDecode').onclick = guard(async () => {
  payDec = await api('decode', { invoice: $('bolt11').value });
  $('payPreview').innerHTML = `<h2>Pay ${fmt(payDec.sats)} sats?</h2><p>${esc(payDec.description || '(no description)')}</p><div class="muted mono">To ${esc(payDec.destination)}</div>
    ${payDec.expired ? '<p class="bad">This invoice has expired.</p>' : `<button id="btnPay" class="primary">Pay${''}</button>`}<button id="btnPayCancel">Cancel</button>`;
  $('payPreview').classList.remove('hidden');
  $('btnPayCancel').onclick = () => $('payPreview').classList.add('hidden');
  if (!payDec.expired) $('btnPay').onclick = guard(async () => {
    $('btnPay').disabled = true;
    const r = await api('pay', { invoice: payDec.invoice, expectSats: payDec.sats, confirm: true });
    $('payPreview').innerHTML = `<h2 class="${r.status === 'failed' ? 'bad' : 'ok'}">${esc(r.status)}</h2>${esc(r.error || '')}`; init();
  });
});
$('btnInvoice').onclick = guard(async () => {
  const r = await api('invoice', { sats: Number($('invSats').value), memo: $('invMemo').value });
  const qr = qrcode(0, 'L'); qr.addData(r.invoice.toUpperCase(), 'Alphanumeric'); qr.make();
  $('invOut').innerHTML = `<div id="qr">${qr.createImgTag(6, 8)}</div><p class="mono">${esc(r.invoice)}</p><button id="btnCopy">Copy</button><div id="invState" class="muted">Waiting for payment…</div>`;
  $('invOut').classList.remove('hidden');
  $('btnCopy').onclick = () => navigator.clipboard?.writeText(r.invoice);
  const poll = setInterval(guard(async () => { if ($('invOut').classList.contains('hidden')) return clearInterval(poll); const s = await api('invoice?hash=' + r.paymentHash); if (s.settled) { $('invState').innerHTML = '<span class="ok">Paid ✓</span>'; clearInterval(poll); init(); } }), 3000);
});
async function loadHistory() {
  const h = await api('history');
  $('history').innerHTML = h.items.map(i => `<div class="card small"><b>${esc(i.kind)}</b>${i.sats != null ? ' · ' + fmt(i.sats) + ' sats' : ''} ${i.dryRun ? '· dry run' : ''}<br>${esc(i.show || i.description || '')} ${esc(i.episode ? '– ' + i.episode : '')}
    <br>${i.results ? i.results.map(r => esc(r.name) + ': ' + esc(r.status)).join(', ') : esc(i.status)}<br><span class="muted">${new Date(i.ts).toLocaleString()}</span></div>`).join('') || '<div class="card muted">Nothing yet</div>';
}
async function loadSaved(select) {
  savedList = (await api('shows')).shows;
  $('saved').innerHTML = '<option value="">— Pick a saved show —</option>' + savedList.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join('') + '<option value="new">+ Add new podcast…</option>';
  const i = select ? savedList.findIndex(s => s.feedUrl === select) : -1; $('saved').value = i >= 0 ? String(i) : '';
  syncSaved();
}
function syncSaved() {
  const isSaved = loaded && savedList.some(s => s.feedUrl === loaded.feedUrl);
  $('btnSaveShow').classList.toggle('hidden', !loaded || isSaved);
  $('btnRemoveSaved').classList.toggle('hidden', !/^\d+$/.test($('saved').value));
}
$('saved').onchange = guard(async () => {
  const v = $('saved').value; syncSaved();
  if (v === 'new') { $('feedUrl').value = ''; $('show').classList.add('hidden'); $('preview').classList.add('hidden'); ($('searchBox').classList.contains('hidden') ? $('feedUrl') : $('q')).focus(); return; }
  if (v === '') return;
  $('feedUrl').value = savedList[v].feedUrl; await loadFeed();
});
$('btnSaveShow').onclick = guard(async () => { await api('shows', loaded); await loadSaved(loaded.feedUrl); toast('Saved to my podcasts'); });
$('btnRemoveSaved').onclick = guard(async () => {
  const s = savedList[$('saved').value]; if (!s || !confirm(`Remove ${s.name} from my podcasts?`)) return;
  await api('shows/remove', { feedUrl: s.feedUrl }); await loadSaved();
});
let setup = null, peers = [], chanPlan = null;
async function loadWallet() {
  const w = await api('wallet');
  ['wSetup', 'wSeed', 'wReady', 'wRestore', 'wRestart', 'wDanger'].forEach(id => $(id).classList.add('hidden'));
  if (w.resetPending) { $('wState').innerHTML = '<span class="bad">Reset pending: restart the app in Umbrel now.</span>'; $('wRestart').classList.remove('hidden'); return; }
  if (w.state !== 'NON_EXISTING' && w.state !== 'UNREACHABLE') $('wDanger').classList.remove('hidden');
  if (w.state === 'NON_EXISTING') { $('wState').innerHTML = 'No boost wallet yet.'; if (setup) $('wSeed').classList.remove('hidden'); else $('wSetup').classList.remove('hidden'); return; }
  if (!w.ready) { $('wState').innerHTML = w.state === 'UNREACHABLE' ? 'Wallet node is starting… try again in a minute.' : `Wallet is ${esc(w.state.toLowerCase())}…` + (w.unlockFile ? '' : ' <span class="bad">(no unlock file)</span>'); return; }
  const sy = w.sync ? (w.sync.synced ? ` · <span class="ok">synced</span> at block ${fmt(w.sync.height)}` : ` · <span class="bad">syncing</span> (block ${fmt(w.sync.height)})`) : '';
  const rec = w.recovery && w.recovery.active && !w.recovery.finished ? ` · rescanning for your coins ${Math.round(w.recovery.progress * 100)}%` : '';
  if (rec || (w.sync && !w.sync.synced)) setTimeout(() => { if (!$('tab-wallet').classList.contains('hidden')) guard(loadWallet)(); }, 15000);
  const b = w.backup || {};
  $('scbInfo').textContent = b.exists ? `LND's channel.backup last changed ${new Date(b.modified).toLocaleString()}${b.copy ? ' (copy kept in data/lnd/channel-backup/)' : ''}.` : 'No channel.backup file yet (appears after the first channel).';
  $('scbBanner').classList.toggle('hidden', !((w.channels || w.pendingAny) && !sessionStorage.getItem('scbDownloaded')));
  $('wState').innerHTML = `<span class="ok">Boost wallet ready</span>${sy}${rec} · ${w.channels} channel${w.channels === 1 ? '' : 's'}${w.pendingOpen ? ` · ${w.pendingOpen} opening` : ''}`;
  $('wBal').innerHTML = `<h2>Balances</h2><table><tr><td>On-chain confirmed</td><td class="r"><b>${fmt(w.onchain.confirmed)}</b></td></tr><tr><td>On-chain unconfirmed</td><td class="r">${fmt(w.onchain.unconfirmed)}</td></tr><tr><td>Ready for a channel (3+ conf)</td><td class="r">${fmt(w.onchain.spendable3)}</td></tr><tr><td>Lightning can send</td><td class="r"><b>${fmt(w.lightning.local)}</b></td></tr><tr><td>Lightning can receive</td><td class="r">${fmt(w.lightning.remote)}</td></tr></table>`;
  $('wReady').classList.remove('hidden');
  if (!peers.length) { const p = await api('channel/peers'); peers = p.peers; $('chanSats').value = p.defaultSats;
    $('peerSel').innerHTML = peers.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join('') + '<option value="custom">Custom pubkey@host…</option>'; syncPeer(); }
}
function syncPeer() {
  const v = $('peerSel').value, p = peers[v]; $('peerCustom').classList.toggle('hidden', v !== 'custom');
  $('peerNote').innerHTML = p ? esc(p.note) + (p.minSats ? `<div class="warn">${esc(p.name)} needs at least ${fmt(p.minSats)} sats.</div>` : '') : 'Paste the full node URI.';
}
$('peerSel').onchange = syncPeer;
$('btnGenSeed').onclick = guard(async () => {
  setup = await api('wallet/seed', {});
  $('seedWords').innerHTML = setup.words.map(w => `<li>${esc(w)}</li>`).join(''); $('checkIdx').textContent = setup.checkIndex;
  $('seedOk').checked = false; $('checkWord').value = '';
  $('wSetup').classList.add('hidden'); $('wSeed').classList.remove('hidden');
});
$('btnInit').onclick = guard(async () => {
  if (!$('seedOk').checked) throw new Error('Tick "I wrote them down" first');
  await api('wallet/init', { setupId: setup.setupId, confirm: true, checkWord: $('checkWord').value });
  setup = null; $('seedWords').innerHTML = ''; $('checkWord').value = '';
  toast('Saved: wallet created'); setTimeout(guard(async () => { await loadWallet(); await init(); }), 1500);
});
$('btnAddr').onclick = guard(async () => {
  const r = await api('wallet/address', {});
  const qr = qrcode(0, 'M'); qr.addData(r.uri); qr.make();
  $('addrOut').innerHTML = `<div id="qr">${qr.createImgTag(6, 8)}</div><p class="mono">${esc(r.address)}</p><button id="btnCopyAddr">Copy address</button>`;
  $('btnCopyAddr').onclick = () => navigator.clipboard.writeText(r.address).then(() => toast('Saved to clipboard'));
});
$('btnChanPreview').onclick = guard(async () => {
  const v = $('peerSel').value;
  chanPlan = await api('channel/preview', { peer: v === 'custom' ? $('peerCustom').value : peers[v].uri, sats: Number($('chanSats').value), private: $('chanPrivate').checked });
  $('chanPreview').innerHTML = `<h2>Confirm channel</h2>${chanPlan.warnings.map(w => `<div class="warn">${esc(w)}</div>`).join('')}<p>Peer: <b>${esc(chanPlan.peerName)}</b><br><span class="mono">${esc(chanPlan.pubkey.slice(0, 16))}…@${esc(chanPlan.host)}</span><br>Amount: <b>${fmt(chanPlan.sats)} sats</b> + on-chain fee<br>${chanPlan.isPrivate ? 'Private (unannounced)' : '<span class="bad">Public</span>'}</p>
    <button id="btnChanOpen" class="primary">${chanPlan.dryRun ? 'Open (dry run)' : 'Open channel for ' + fmt(chanPlan.sats) + ' sats'}</button><button id="btnChanCancel">Cancel</button>`;
  $('btnChanCancel').onclick = () => { $('chanPreview').innerHTML = ''; };
  $('btnChanOpen').onclick = guard(async () => {
    if (!confirm(`Open a ${fmt(chanPlan.sats)} sat channel to ${chanPlan.peerName}? This spends on-chain funds.`)) return;
    const r = await api('channel/open', { planId: chanPlan.id, confirm: true });
    $('chanPreview').innerHTML = `<p>${r.status === 'dry-run' ? 'Dry run: nothing was sent.' : 'Channel opening. Funding tx: <span class="mono">' + esc(r.txid || '') + '</span>'}</p>`;
    loadWallet();
  });
});
const countWords = () => { const n = $('restoreWords').value.trim().split(/\s+/).filter(Boolean).length; $('restoreCount').textContent = `${n} / 24 words`; return n; };
const clearRestore = () => { $('restoreWords').value = ''; $('restorePass').value = ''; countWords(); };
$('restoreWords').oninput = countWords;
$('btnShowRestore').onclick = () => { $('wSetup').classList.add('hidden'); $('wRestore').classList.remove('hidden'); };
$('btnRestoreCancel').onclick = () => { clearRestore(); $('wRestore').classList.add('hidden'); $('wSetup').classList.remove('hidden'); };
$('btnRestore').onclick = guard(async () => {
  const words = $('restoreWords').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 24) throw new Error(`Enter exactly 24 words (got ${words.length})`);
  if (words.some(w => !/^[a-z]{3,8}$/.test(w))) throw new Error('Words must be letters only');
  try { await api('wallet/restore', { words, passphrase: $('restorePass').value }); }
  finally { words.fill(''); clearRestore(); }
  toast('Saved: wallet restored, rescanning for your coins…'); setTimeout(guard(async () => { await loadWallet(); await init(); }), 2000);
});
$('btnReset').onclick = guard(async () => {
  if ($('resetPhrase').value !== 'RESET WALLET') throw new Error('Type RESET WALLET exactly');
  if (!confirm('Reset this wallet? Only your 24 words can recover its funds.')) return;
  await api('wallet/reset', { phrase: $('resetPhrase').value, override: $('resetOverride').checked });
  $('resetPhrase').value = ''; $('resetOverride').checked = false; await loadWallet();
});
$('btnScbDownload').onclick = guard(async () => {
  const r = await fetch('api/backup/download'); if (!r.ok) throw new Error((await r.json()).error || 'Error');
  const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'dirty-boost-channels.backup';
  const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click(); URL.revokeObjectURL(a.href);
  sessionStorage.setItem('scbDownloaded', '1'); $('scbBanner').classList.add('hidden'); toast('Saved: ' + name + ' – store it off this box');
});
$('btnScbRestore').onclick = guard(async () => {
  const f = $('scbFile').files[0]; if (!f) throw new Error('Choose the .backup file first');
  if (!confirm('Restore channels from this backup? Your peers will be asked to force-close and pay you on-chain.')) return;
  const bytes = new Uint8Array(await f.arrayBuffer()); let bin = ''; bytes.forEach(x => { bin += String.fromCharCode(x); });
  await api('backup/restore', { backup: btoa(bin), confirm: true }); $('scbFile').value = ''; toast('Saved: channel backup submitted to LND');
});
guard(init)(); guard(loadSaved)();
