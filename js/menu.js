'use strict';
/* "More" menu: undo/redo, fit, import/export, privacy and clear live here. */
const menuBtn = $('menuBtn'), menuEl = $('menu');
function setMenu(open) {
  menuEl.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
}
menuBtn.onclick = (e) => { e.stopPropagation(); setMenu(menuEl.hidden); };
menuEl.addEventListener('click', () => setMenu(false));
document.addEventListener('click', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
