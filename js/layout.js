'use strict';
/* ---------------------------------------------------------------------
   Auto layout
   Parent on top, its findings in a tidy row underneath (a grid when there
   are many plain results), arrows running down the tree. Runs on the
   connected tree that was just added to, using the REAL card sizes
   (photo + property table make cards different heights). Separate trees
   never overlap: a tree that would land on another is moved aside.
   --------------------------------------------------------------------- */
const LAYOUT = { hGap: 36, vGap: 96, rowGap: 28 };
let autoLayoutOn = true;
try { autoLayoutOn = localStorage.getItem('linktrace.autoLayout') !== '0'; } catch {}

function rootOf(id) {
  const seen = new Set();
  let n = find(id);
  while (n && n.parentId && find(n.parentId) && !seen.has(n.id)) { seen.add(n.id); n = find(n.parentId); }
  return n ? n.id : id;
}

function buildBlock(n, seen) {
  seen.add(n.id);
  const d = nodeDims(n);
  const kids = childrenOf(n.id).filter((k) => !seen.has(k.id)).map((k) => buildBlock(k, seen));
  const b = { n, nw: d.w, nh: d.h, kids: [], kidsW: 0, kidsH: 0, w: d.w, h: d.h };
  if (!kids.length) return b;

  if (kids.length > 5 && kids.every((k) => !k.kids.length)) {
    // many plain results: grid, so the tree stays readable instead of one 5000px row
    const cols = Math.min(5, Math.max(3, Math.ceil(Math.sqrt(kids.length * 1.3))));
    const colW = Math.max(...kids.map((k) => k.w));
    let y = 0;
    for (let i = 0; i < kids.length; i += cols) {
      const row = kids.slice(i, i + cols);
      const rowH = Math.max(...row.map((k) => k.h));
      row.forEach((k, c) => b.kids.push({ b: k, dx: c * (colW + LAYOUT.hGap) + (colW - k.w) / 2, dy: y }));
      y += rowH + LAYOUT.rowGap;
    }
    b.kidsW = Math.min(cols, kids.length) * colW + (Math.min(cols, kids.length) - 1) * LAYOUT.hGap;
    b.kidsH = y - LAYOUT.rowGap;
  } else {
    let x = 0;
    kids.forEach((k) => { b.kids.push({ b: k, dx: x, dy: 0 }); x += k.w + LAYOUT.hGap; });
    b.kidsW = x - LAYOUT.hGap;
    b.kidsH = Math.max(...kids.map((k) => k.h));
  }
  b.w = Math.max(b.nw, b.kidsW);
  b.h = b.nh + LAYOUT.vGap + b.kidsH;
  return b;
}

function placeBlock(b, x, y, moved) {
  b.n.x = Math.max(10, Math.round(x + (b.w - b.nw) / 2));
  b.n.y = Math.max(10, Math.round(y));
  moved.push(b.n);
  const ox = x + (b.w - b.kidsW) / 2, oy = y + b.nh + LAYOUT.vGap;
  b.kids.forEach((k) => placeBlock(k.b, ox + k.dx, oy + k.dy, moved));
}

/* Lay out one tree, keeping its root where it is (centred over the tree). */
function layoutComponent(rootId) {
  const root = find(rootId);
  if (!root) return;
  const block = buildBlock(root, new Set());
  const rd = nodeDims(root);
  let x0 = Math.max(40, root.x + rd.w / 2 - block.w / 2), y0 = Math.max(10, root.y);
  const moved = [];
  placeBlock(block, x0, y0, moved);

  // keep clear of every other tree
  const mine = new Set(moved.map((n) => n.id));
  const others = nodes.filter((n) => !mine.has(n.id));
  const margin = 30;
  for (let i = 0; i < 60; i++) {
    const hit = others.filter((o) => {
      const od = nodeDims(o);
      return o.x < x0 + block.w + margin && o.x + od.w + margin > x0 && o.y < y0 + block.h + margin && o.y + od.h + margin > y0;
    });
    if (!hit.length) break;
    const right = Math.max(...hit.map((o) => o.x + nodeDims(o).w));
    const shift = right + 60 - x0;
    x0 += shift;
    moved.forEach((n) => { n.x += shift; });
  }
}

/* Arrange the whole board: every tree left to right, wrapping into rows. */
function layoutAll() {
  const roots = nodes.filter((n) => rootOf(n.id) === n.id).sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const seen = new Set();
  let x = 60, y = 60, rowH = 0;
  roots.forEach((r) => {
    const b = buildBlock(r, seen);
    if (x > 60 && x + b.w > 2600) { x = 60; y += rowH + 110; rowH = 0; }
    placeBlock(b, x, y, []);
    x += b.w + 90;
    rowH = Math.max(rowH, b.h);
  });
}

/* After nodes were created: measure, tidy their tree(s), bring them into
   view, offer Undo, and fetch their photo / details in the background. */
function afterNodesAdded(list, message) {
  render();
  if (autoLayoutOn) {
    new Set(list.map((n) => rootOf(n.id))).forEach(layoutComponent);
    saveBoard();
    render();
  }
  revealNodes(list);
  const tag = hist.length;
  showToast(message, 'Undo', () => {
    if (hist.length === tag) undo();
    else showToast('The board changed since \u2014 use Undo in the menu', null);
  });
  list.forEach((n) => attachPageInfo(n.id));
}

/* Re-tidy one tree after a card changed height (photo arrived, etc). */
function relayoutFor(id) {
  if (!autoLayoutOn) return;
  layoutComponent(rootOf(id));
}

function revealNodes(list) {
  const ns = list.map((n) => find(n.id)).filter(Boolean);
  if (!ns.length) return;
  const minX = Math.min(...ns.map((n) => n.x)), minY = Math.min(...ns.map((n) => n.y));
  const maxX = Math.max(...ns.map((n) => n.x + nodeDims(n).w)), maxY = Math.max(...ns.map((n) => n.y + nodeDims(n).h));
  const panel = $('lsPanel');
  const inset = panel && !panel.hasAttribute('hidden') ? panel.getBoundingClientRect().width : 0;
  const bl = PAN_PAD + minX * zoom, br = PAN_PAD + maxX * zoom, bt = PAN_PAD + minY * zoom, bb = PAN_PAD + maxY * zoom;
  let left = view.scrollLeft, top = view.scrollTop;
  const availW = view.clientWidth - inset, availH = view.clientHeight - 90;
  if (bl < left + inset + 20 || br > left + view.clientWidth - 20) left = (br - bl > availW) ? bl - inset - 40 : bl - inset - (availW - (br - bl)) / 2;
  if (bt < top + 20 || bb > top + availH) top = (bb - bt > availH) ? bt - 40 : bt - (availH - (bb - bt)) / 2;
  if (Math.abs(left - view.scrollLeft) > 2 || Math.abs(top - view.scrollTop) > 2) view.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: 'smooth' });
}

/* ---- photo + details pulled from the entity's link (via the local helper) ---- */
function pageInfoProps(info, url) {
  const out = [];
  if (info.siteName || hostOf(url)) out.push({ k: 'Site', v: info.siteName || hostOf(url) });
  if (info.title) out.push({ k: 'Title', v: info.title });
  if (info.description) out.push({ k: 'About', v: info.description.slice(0, 160) });
  return out;
}
async function attachPageInfo(id, force) {
  let n = find(id);
  if (!n) return;
  const url = entityPreviewUrl(n);
  if (!isValidUrl(url)) return;
  if (!force && n.image && (n.props || []).length) return;
  if (!lsAutoThumbsOn() && !force) return;           // same privacy switch as the result thumbnails
  if (!(await probeHelper())) return;
  let info;
  try { info = await fetchPageInfo(url); } catch { return; }
  n = find(id);
  if (!n) return;
  let changed = false;
  if (!n.image || force) {
    const img = info.ogImage || (info.images && info.images[0] && info.images[0].url) || '';
    if (img && img !== n.image) { n.image = sanitizePhoto(img); changed = changed || !!n.image; }
  }
  if (!(n.props || []).length) {
    const p = pageInfoProps(info, url);
    if (p.length) { n.props = p; changed = true; }
  }
  if (!changed) return;
  saveBoard();
  render();
  if (autoLayoutOn) { relayoutFor(n.id); saveBoard(); render(); }
}

function setNodePhoto(n, src) {
  mark();
  n.image = sanitizePhoto(src);
  saveBoard(); render();
  if (autoLayoutOn) { relayoutFor(n.id); saveBoard(); render(); }
}

/* Uploaded / pasted pictures are shrunk before they are stored on the board. */
function fileToPhotoData(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('Not an image'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 520, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

/* Ctrl+V an image while an entity is selected -> becomes its card photo. */
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return;
  const n = find(selected);
  const file = n && [...(e.clipboardData ? e.clipboardData.files : [])].find((f) => /^image\//.test(f.type));
  if (!file) return;
  e.preventDefault();
  fileToPhotoData(file).then((d) => setNodePhoto(n, d)).catch(() => {});
});

/* Menu: arrange + toggle */
function syncAutoLayoutLabel() { $('autoLayoutToggle').textContent = 'Auto-layout on add: ' + (autoLayoutOn ? 'On' : 'Off'); }
$('arrange').onclick = () => { mark(); layoutAll(); saveBoard(); render(); $('fit').click(); showToast('Board arranged', 'Undo', undo); };
$('autoLayoutToggle').onclick = () => {
  autoLayoutOn = !autoLayoutOn;
  try { localStorage.setItem('linktrace.autoLayout', autoLayoutOn ? '1' : '0'); } catch {}
  syncAutoLayoutLabel();
};
syncAutoLayoutLabel();
