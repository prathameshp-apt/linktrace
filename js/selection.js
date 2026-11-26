'use strict';
/* ---------------------------------------------------------------------
   Selection like a desktop: drag a rectangle on empty board to select
   everything it touches, Shift/Ctrl-click to add or remove, drag any
   selected card to move them all, Delete removes, Esc clears, Ctrl+A all.
   A single selected card keeps using `selected`; two or more use `multi`.
   --------------------------------------------------------------------- */
const isSelected = (id) => selected === id || multi.has(id);
function selectedIds() { return selected != null && find(selected) ? [selected] : [...multi].filter((i) => find(i)); }

function setSelection(ids) {
  ids = [...new Set(ids)].filter((i) => find(i));
  multi.clear();
  if (ids.length === 1) selected = ids[0];
  else { selected = null; ids.forEach((i) => multi.add(i)); }
  render();
}
function toggleInSelection(id) {
  const ids = selectedIds();
  setSelection(ids.includes(id) ? ids.filter((i) => i !== id) : ids.concat(id));
}

/* ---------- drag a rectangle on empty board ---------- */
let marq = null, marqEl = null;
view.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || handOn || spaceDown || linkFrom || connectDrag) return;
  if (e.target.closest('.node, .resize-handle, .connect-handle, button, input, a, select, textarea')) return;
  const r = view.getBoundingClientRect();
  if (e.clientX - r.left > view.clientWidth || e.clientY - r.top > view.clientHeight) return;   // the scrollbars
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  marq = { x: e.clientX, y: e.clientY, moved: false, additive, base: additive ? selectedIds() : [], hit: [] };
  e.preventDefault();                                   // no text selection while dragging
});

document.addEventListener('mousemove', (e) => {
  if (!marq) return;
  if (!marq.moved && Math.hypot(e.clientX - marq.x, e.clientY - marq.y) < 4) return;
  marq.moved = true;
  if (!marqEl) { marqEl = document.createElement('div'); marqEl.className = 'marquee'; document.body.appendChild(marqEl); }
  const l = Math.min(marq.x, e.clientX), t = Math.min(marq.y, e.clientY), rr = Math.max(marq.x, e.clientX), b = Math.max(marq.y, e.clientY);
  Object.assign(marqEl.style, { left: l + 'px', top: t + 'px', width: (rr - l) + 'px', height: (b - t) + 'px' });
  const hit = [];
  board.querySelectorAll('.node').forEach((el) => {
    const q = el.getBoundingClientRect();
    if (q.left < rr && q.right > l && q.top < b && q.bottom > t) hit.push(+el.dataset.id);
  });
  marq.hit = hit;
  board.querySelectorAll('.node').forEach((el) => el.classList.toggle('sel', hit.includes(+el.dataset.id) || marq.base.includes(+el.dataset.id)));
});

document.addEventListener('mouseup', () => {
  if (!marq) return;
  const m = marq;
  marq = null;
  if (marqEl) { marqEl.remove(); marqEl = null; }
  if (m.moved) setSelection(m.base.concat(m.hit));
  else if (!m.additive && selectedIds().length) setSelection([]);   // plain click on empty board: deselect
});

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target) || document.querySelector('.modal-backdrop')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection(nodes.map((n) => n.id)); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && selectedIds().length) { e.preventDefault(); deleteSelection(); return; }
  if (e.key === 'Escape' && selectedIds().length && $('lsPanel').hasAttribute('hidden') && !document.querySelector('.context')) setSelection([]);
});

function deleteSelection() {
  const ids = selectedIds();
  if (!ids.length) return;
  if (ids.length === 1) return removeNode(ids[0]);
  showConfirm('Delete ' + ids.length + ' entities',
    'Delete the ' + ids.length + ' selected entities? Anything linked under them stays on the board. You can bring it all back with Undo.',
    () => { mark(); ids.forEach(deleteNodeOnly); selected = null; multi.clear(); saveBoard(); render(); }, 'Delete ' + ids.length, true);
}

/* ---------- right panel while several are selected ---------- */
function renderMultiInspector() {
  const ns = [...multi].map(find).filter(Boolean);
  side.innerHTML =
    '<div class="sidebar-title"><div><div class="kind">Selection</div><h2>' + ns.length + ' entities selected</h2></div>' +
    '<button id="closeInspector" aria-label="Clear selection">&times;</button></div>' +
    '<div class="multi-list">' + ns.map((n) =>
      '<div class="multi-row"><img class="icon" src="' + esc(typeIconSrc(n.type, n.label)) + '" alt="" onerror="this.onerror=null;this.src=\'icons/generic.svg\'"> <span>' + esc(n.label) + '</span></div>').join('') + '</div>' +
    '<div class="row"><button id="multiClear">Clear selection</button><button class="danger" id="multiDelete">Delete selected</button></div>' +
    '<small>Drag any selected card to move them all. Shift or Ctrl + click adds or removes one.</small>';
  $('closeInspector').onclick = $('multiClear').onclick = () => setSelection([]);
  $('multiDelete').onclick = deleteSelection;
}
