'use strict';
/* ---------------------------------------------------------------------
   6. Modal system (replaces native alert / confirm / prompt everywhere,
      so every dialog in the app looks and behaves the same way)
   --------------------------------------------------------------------- */
function closeOverlays() {
  document.querySelectorAll('.modal-backdrop,.context').forEach((x) => x.remove());
}

function openModal(title, subtitle, bodyHtml, actionsHtml) {
  closeOverlays();
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML =
    '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">' +
      '<h2 id="modalTitle">' + esc(title) + '</h2>' +
      (subtitle ? '<p>' + esc(subtitle) + '</p>' : '') +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="actions">' + actionsHtml + '</div>' +
    '</div>';
  document.body.append(back);
  back.addEventListener('click', (e) => { if (e.target === back) closeOverlays(); });
  back.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeOverlays(); }
    if (e.key === 'Tab') {
      const focusable = back.querySelectorAll('button, input, select, textarea, [tabindex]');
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  const firstField = back.querySelector('input, textarea, select');
  (firstField || back.querySelector('button')).focus();
  return back;
}

function showAlert(title, message) {
  const back = openModal(title, message, '', '<button class="primary" id="alertOk">OK</button>');
  back.querySelector('#alertOk').onclick = closeOverlays;
}

function showConfirm(title, message, onConfirm, confirmLabel, danger) {
  const back = openModal(title, message, '',
    '<button id="confirmCancel">Cancel</button>' +
    '<button class="' + (danger ? 'danger' : 'primary') + '" id="confirmOk">' + esc(confirmLabel || 'Confirm') + '</button>');
  back.querySelector('#confirmCancel').onclick = closeOverlays;
  back.querySelector('#confirmOk').onclick = () => { closeOverlays(); onConfirm(); };
}

function showPrompt(title, label, defaultValue, onSubmit) {
  const back = openModal(title, '', '<label>' + esc(label) + '</label><input id="promptInput" value="' + esc(defaultValue || '') + '" autocomplete="off">',
    '<button id="promptCancel">Cancel</button><button class="primary" id="promptOk">Save</button>');
  const input = back.querySelector('#promptInput');
  input.select();
  const submit = () => { const v = input.value.trim(); closeOverlays(); if (v) onSubmit(v); };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  back.querySelector('#promptCancel').onclick = closeOverlays;
  back.querySelector('#promptOk').onclick = submit;
}

