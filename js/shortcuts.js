'use strict';
/* ---------------------------------------------------------------------
   13. Keyboard shortcuts (never fire while typing in a field)
   --------------------------------------------------------------------- */
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if (e.key === 'Escape') { linkFrom = null; $('banner').classList.remove('on'); }
  if (e.key === 'Delete' && selected) removeNode(selected);
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') undo();
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') redo();
});

