const $ = id => document.getElementById(id);

function wireDialogEscape(dlg, onDismiss) {
  const onCancel = event => {
    event.preventDefault();
    onDismiss();
  };
  dlg.addEventListener('cancel', onCancel, {once: true});
  return () => dlg.removeEventListener('cancel', onCancel);
}

export function confirmDialog(message, options = {}) {
  const {
    title = 'Confirm',
    confirmLabel = 'OK',
    cancelLabel = 'Cancel',
    danger = false,
  } = options;
  const dlg = $('vault-confirm-dialog');
  if (!dlg) return Promise.resolve(globalThis.confirm?.(message) ?? false);

  return new Promise(resolve => {
    $('vault-confirm-title').textContent = title;
    $('vault-confirm-message').textContent = message;
    const ok = $('vault-confirm-ok');
    const cancel = $('vault-confirm-cancel');
    ok.textContent = confirmLabel;
    cancel.textContent = cancelLabel;
    ok.classList.toggle('danger', danger);

    const finish = (value) => {
      dlg.close();
      ok.onclick = null;
      cancel.onclick = null;
      resolve(value);
    };

    const dropCancel = wireDialogEscape(dlg, () => finish(false));
    ok.onclick = () => { dropCancel(); finish(true); };
    cancel.onclick = () => { dropCancel(); finish(false); };
    dlg.showModal();
    cancel.focus();
  });
}

export function promptDialog(options) {
  const {
    title,
    help = '',
    label = '',
    defaultValue = '',
    placeholder = '',
    submitLabel = 'OK',
    password = false,
    required = true,
    validate = null,
  } = options;
  const dlg = $('vault-prompt-dialog');
  if (!dlg) {
    const fallback = globalThis.prompt?.(title, defaultValue);
    return Promise.resolve(fallback === null || fallback === '' ? null : fallback);
  }

  return new Promise(resolve => {
    const form = $('vault-prompt-form');
    const input = $('vault-prompt-input');
    const errorEl = $('vault-prompt-error');
    const cancel = $('vault-prompt-cancel');
    $('vault-prompt-title').textContent = title;
    $('vault-prompt-help').textContent = help;
    $('vault-prompt-help').hidden = !help;
    $('vault-prompt-label').textContent = label || title;
    $('vault-prompt-submit').textContent = submitLabel;
    input.type = password ? 'password' : 'text';
    input.value = defaultValue;
    input.placeholder = placeholder;
    input.required = required;
    input.autocomplete = password ? 'current-password' : 'off';
    errorEl.textContent = '';
    errorEl.hidden = true;

    const finish = (value) => {
      dlg.close();
      form.onsubmit = null;
      cancel.onclick = null;
      input.value = '';
      resolve(value);
    };

    const dropCancel = wireDialogEscape(dlg, () => finish(null));
    cancel.onclick = () => { dropCancel(); finish(null); };
    form.onsubmit = async event => {
      event.preventDefault();
      const value = input.value;
      if (required && !value.trim()) {
        errorEl.textContent = 'This field is required.';
        errorEl.hidden = false;
        input.focus();
        return;
      }
      if (validate) {
        const err = await validate(value);
        if (err) {
          errorEl.textContent = err;
          errorEl.hidden = false;
          input.focus();
          return;
        }
      }
      dropCancel();
      finish(value);
    };
    dlg.showModal();
    input.focus();
    if (defaultValue) input.select();
  });
}

export function promptPasswordDialog(options) {
  return promptDialog({...options, password: true});
}