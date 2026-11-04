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
});
const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" fill="#2a2f38"/><text x="36" y="46" font-size="30" text-anchor="middle" fill="#8a93a0">🎙</text></svg>');
let feedUrl = null, plan = null, payDec = null, loaded = null, savedList = [];
async function init() {
  const s = await api('status');
  $('dry').classList.toggle('hidden', !s.dryRun); $('searchBox').classList.toggle('hidden', !s.search); $('sender').value = s.senderName;
  try {
    const m = await api('summary');
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
  $('history').innerHTML = h.items.map(i => `<div class="card small"><b>${esc(i.kind)}</b> · ${fmt(i.sats)} sats ${i.dryRun ? '· dry run' : ''}<br>${esc(i.show || i.description || '')} ${esc(i.episode ? '– ' + i.episode : '')}
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
guard(init)(); guard(loadSaved)();
