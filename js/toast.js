'use strict';
/* Small bottom-centre toast with an optional action ("Result added  Undo"). */
let toastTimer = null;
function showToast(message, actionLabel, onAction, ms) {
  const el = $('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.innerHTML = '<span class="toast-msg"></span>' + (actionLabel ? '<button type="button" class="toast-act"></button>' : '');
  el.querySelector('.toast-msg').textContent = message;
  if (actionLabel) {
    const b = el.querySelector('.toast-act');
    b.textContent = actionLabel;
    b.onclick = () => { hideToast(); if (onAction) onAction(); };
  }
  el.hidden = false;
  toastTimer = setTimeout(hideToast, ms || 6000);
}
function hideToast() { clearTimeout(toastTimer); const el = $('toast'); if (el) el.hidden = true; }
