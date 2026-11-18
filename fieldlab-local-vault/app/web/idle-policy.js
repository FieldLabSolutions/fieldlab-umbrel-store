const IDLE_STORAGE_KEY = 'fieldlab-vault-autolock-minutes';
const DEFAULT_IDLE_MINUTES = 30;

export function idleSelectElement() {
  return document.getElementById('idle');
}

export function idleLimitMs() {
  const el = idleSelectElement();
  if (!el) return DEFAULT_IDLE_MINUTES * 60_000;
  if (el.value === '0') return 0;
  const minutes = Number(el.value);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_IDLE_MINUTES * 60_000;
  return minutes * 60_000;
}

export function idleAutoLockEnabled() {
  return idleLimitMs() > 0;
}

export function loadIdlePreference() {
  try {
    const raw = localStorage.getItem(IDLE_STORAGE_KEY);
    if (raw === null || raw === '') return DEFAULT_IDLE_MINUTES;
    if (raw === 'never' || raw === '0') return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_IDLE_MINUTES;
  } catch {
    return DEFAULT_IDLE_MINUTES;
  }
}

export function saveIdlePreference(minutes) {
  try {
    localStorage.setItem(IDLE_STORAGE_KEY, minutes === 0 ? 'never' : String(minutes));
  } catch {
    /* non-secret preference; ignore quota errors */
  }
}

export function wireIdleSelect() {
  const el = idleSelectElement();
  if (!el) return;
  const pref = loadIdlePreference();
  const value = pref === 0 ? '0' : String(pref);
  if ([...el.options].some(opt => opt.value === value)) el.value = value;
  else el.value = '30';
  el.addEventListener('change', () => {
    const v = el.value === '0' ? 0 : Number(el.value);
    saveIdlePreference(v);
  });
}

export function shouldAutoLock(lastActivityMs) {
  if (!idleAutoLockEnabled()) return false;
  return Date.now() - lastActivityMs >= idleLimitMs();
}

export function idleMinutesForExport() {
  const el = idleSelectElement();
  if (!el) return DEFAULT_IDLE_MINUTES;
  if (el.value === '0') return 0;
  const n = Number(el.value);
  return Number.isFinite(n) ? n : DEFAULT_IDLE_MINUTES;
}