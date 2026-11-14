const ZOOM_MIN = 1;
const ZOOM_MAX = 5;

export function openMediaLightbox(ctx) {
  const {
    entries,
    startIndex = 0,
    onClose,
    touchActivity,
    loadEntry,
    preloadEntry,
  } = ctx;
  if (!entries?.length) return;

  let index = Math.max(0, Math.min(startIndex, entries.length - 1));
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let slideshowTimer = null;
  let slideshowMs = 0;
  let slideshowPaused = false;
  let loopFolder = true;
  const objectUrls = new Set();

  const root = document.createElement('div');
  root.id = 'media-lightbox';
  root.className = 'media-lightbox';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');

  const backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.className = 'media-lightbox-backdrop';
  backdrop.setAttribute('aria-label', 'Close viewer');

  const stage = document.createElement('div');
  stage.className = 'media-lightbox-stage';

  const viewport = document.createElement('div');
  viewport.className = 'media-lightbox-viewport';

  const mediaSlot = document.createElement('div');
  mediaSlot.className = 'media-lightbox-media';

  const toolbar = document.createElement('div');
  toolbar.className = 'media-lightbox-toolbar';

  const title = document.createElement('p');
  title.className = 'media-lightbox-title';

  const btn = (label, extra = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    for (const [key, value] of Object.entries(extra)) {
      if (key.startsWith('data-')) b.setAttribute(key, String(value));
      else if (key === 'className') b.className = value;
      else if (key === 'hidden') b.hidden = Boolean(value);
      else b[key] = value;
    }
    return b;
  };

  const prevBtn = btn('‹', {className: 'media-lightbox-nav prev'});
  const nextBtn = btn('›', {className: 'media-lightbox-nav next'});
  const closeBtn = btn('Close', {'data-action': 'close'});
  const zoomOut = btn('−', {'data-action': 'zoom-out'});
  const zoomIn = btn('+', {'data-action': 'zoom-in'});
  const zoomReset = btn('Reset zoom', {'data-action': 'zoom-reset'});
  const ss3 = btn('Slideshow 3s', {'data-slideshow': '3000'});
  const ss5 = btn('Slideshow 5s', {'data-slideshow': '5000'});
  const ss10 = btn('Slideshow 10s', {'data-slideshow': '10000'});
  const ssPause = btn('Pause', {'data-action': 'slideshow-pause'});
  const ssResume = btn('Resume', {'data-action': 'slideshow-resume', hidden: true});

  viewport.append(prevBtn, mediaSlot, nextBtn);
  toolbar.append(title, zoomOut, zoomIn, zoomReset, ss3, ss5, ss10, ssPause, ssResume, closeBtn);
  stage.append(viewport, toolbar);
  root.append(backdrop, stage);
  document.body.append(root);

  const bumpActivity = () => { if (touchActivity) touchActivity(); };

  function clearSlideshow() {
    if (slideshowTimer) {
      clearInterval(slideshowTimer);
      slideshowTimer = null;
    }
  }

  function applyTransform(el) {
    if (!el || el.tagName === 'VIDEO') return;
    el.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }

  function resetZoom() {
    zoom = 1;
    panX = 0;
    panY = 0;
    const img = mediaSlot.querySelector('img.media-full');
    if (img) applyTransform(img);
  }

  function setZoom(next) {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    const img = mediaSlot.querySelector('img.media-full');
    if (img) applyTransform(img);
  }

  function showAt(newIndex) {
    index = (newIndex + entries.length) % entries.length;
    renderCurrent().catch(() => {});
    bumpActivity();
  }

  function goNext() {
    if (entries.length <= 1) return;
    showAt(index + 1);
  }

  function goPrev() {
    if (entries.length <= 1) return;
    showAt(index - 1);
  }

  function revokeSlot() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
    mediaSlot.replaceChildren();
  }

  async function renderCurrent() {
    revokeSlot();
    clearSlideshow();
    resetZoom();
    const {item, meta} = entries[index];
    title.textContent = `${meta.filename} (${index + 1} / ${entries.length})`;
    prevBtn.hidden = entries.length <= 1;
    nextBtn.hidden = entries.length <= 1;
    bumpActivity();
    const loaded = await loadEntry(item, meta);
    if (loaded.kind === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.className = 'media-full';
      video.playsInline = true;
      video.src = loaded.src;
      video.addEventListener('timeupdate', bumpActivity);
      video.addEventListener('ended', () => {
        if (loopFolder || slideshowMs > 0) goNext();
      });
      mediaSlot.append(video);
      video.play().catch(() => {});
    } else {
      const img = document.createElement('img');
      img.className = 'media-full';
      img.alt = meta.filename;
      img.draggable = false;
      img.src = loaded.url;
      if (loaded.revoke !== false) objectUrls.add(loaded.url);
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      img.addEventListener('wheel', ev => {
        ev.preventDefault();
        const delta = ev.deltaY < 0 ? 0.15 : -0.15;
        setZoom(zoom + delta);
      }, {passive: false});
      img.addEventListener('dblclick', () => setZoom(zoom >= 2 ? 1 : 2));
      img.addEventListener('pointerdown', ev => {
        if (zoom <= 1) return;
        dragging = true;
        lastX = ev.clientX;
        lastY = ev.clientY;
        img.setPointerCapture(ev.pointerId);
      });
      img.addEventListener('pointermove', ev => {
        if (!dragging) return;
        panX += ev.clientX - lastX;
        panY += ev.clientY - lastY;
        lastX = ev.clientX;
        lastY = ev.clientY;
        applyTransform(img);
      });
      img.addEventListener('pointerup', () => { dragging = false; });
      mediaSlot.append(img);
      applyTransform(img);
    }
    const neighbors = [index - 1, index + 1].filter(i => i >= 0 && i < entries.length);
    for (const ni of neighbors) {
      if (preloadEntry) preloadEntry(entries[ni].item, entries[ni].meta).catch(() => {});
    }
  }

  function startSlideshow(ms) {
    slideshowMs = ms;
    slideshowPaused = false;
    ssPause.hidden = false;
    ssResume.hidden = true;
    clearSlideshow();
    slideshowTimer = setInterval(() => {
      if (slideshowPaused) return;
      goNext();
    }, ms);
  }

  function close() {
    clearSlideshow();
    revokeSlot();
    root.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  }

  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); goNext(); return; }
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); goPrev(); return; }
    if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); setZoom(zoom + 0.25); return; }
    if (ev.key === '-') { ev.preventDefault(); setZoom(zoom - 0.25); }
  }

  let touchStartX = 0;
  let touchStartY = 0;
  viewport.addEventListener('touchstart', ev => {
    if (ev.touches.length === 1) {
      touchStartX = ev.touches[0].clientX;
      touchStartY = ev.touches[0].clientY;
    }
  }, {passive: true});
  viewport.addEventListener('touchend', ev => {
    if (!ev.changedTouches.length) return;
    const dx = ev.changedTouches[0].clientX - touchStartX;
    const dy = ev.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) goNext();
      else goPrev();
    }
  }, {passive: true});

  document.addEventListener('keydown', onKey);
  backdrop.onclick = close;
  closeBtn.onclick = close;
  prevBtn.onclick = goPrev;
  nextBtn.onclick = goNext;
  zoomIn.onclick = () => setZoom(zoom + 0.25);
  zoomOut.onclick = () => setZoom(zoom - 0.25);
  zoomReset.onclick = resetZoom;
  ss3.onclick = () => startSlideshow(3000);
  ss5.onclick = () => startSlideshow(5000);
  ss10.onclick = () => startSlideshow(10000);
  ssPause.onclick = () => {
    slideshowPaused = true;
    ssPause.hidden = true;
    ssResume.hidden = false;
  };
  ssResume.onclick = () => {
    slideshowPaused = false;
    ssPause.hidden = false;
    ssResume.hidden = true;
  };

  renderCurrent().catch(err => {
    title.textContent = err.message || 'Unable to open media';
  });

  return {close, next: goNext, prev: goPrev, getIndex: () => index};
}