'use strict';
/* ---------------------------------------------------------------------
   Navigation: hand (pan) tool + overview minimap
   - Select tool (toolbar "Select" or V) and Pan tool (toolbar "Pan" or H).
     In Pan, dragging empty board moves the view like the hand tool in
     Photoshop / CorelDraw; entities still select, drag, resize and
     connect, so nothing you can do with the pointer is lost.
   - Hold Space for a temporary pan from any tool, or use the middle
     mouse button at any time.
   - Overview minimap (bottom-right): every entity drawn in miniature,
     coloured by confidence, with the visible area outlined. Click or
     drag in it to jump anywhere; +/- zoom about the centre of the view.
   --------------------------------------------------------------------- */
let handOn = false;      // toolbar toggle
let spaceDown = false;   // temporary pan while Space is held
let panState = null;     // {x, y, sl, st, moved}
let justPanned = false;  // swallow the click that follows a real pan

const isTypingTarget = (t) =>
  t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);

function syncPanClass() {
  view.classList.toggle('pan-mode', handOn || spaceDown);
  view.classList.toggle('pan-hold', spaceDown);   // Space held = pure pan, even over entities
  $('handTool').classList.toggle('active', handOn);
  $('handTool').setAttribute('aria-pressed', String(handOn));
  $('selectTool').classList.toggle('active', !handOn);
  $('selectTool').setAttribute('aria-pressed', String(!handOn));
}
function setHand(on) { handOn = on; syncPanClass(); }

$('handTool').onclick = () => setHand(true);
$('selectTool').onclick = () => setHand(false);

document.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('.modal-backdrop')) return;
  if (e.key === 'h' || e.key === 'H') setHand(true);
  if (e.key === 'v' || e.key === 'V') setHand(false);
  if (e.code === 'Space' && !spaceDown) {
    spaceDown = true; syncPanClass();
    e.preventDefault(); // stop the page scrolling
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spaceDown) { spaceDown = false; syncPanClass(); }
});
window.addEventListener('blur', () => { spaceDown = false; syncPanClass(); });

/* Capture phase on the view, so it runs before a card's own mousedown.
   - Middle button, or Space held: pans from anywhere, even over a card.
   - Pan tool (H): a drag that starts on EMPTY board pans. A drag that
     starts on an entity is left alone, so cards still select, move,
     resize and connect exactly as they do with the Select tool.
   - Select tool: left-drag never pans (use Space / middle button). */
view.addEventListener('mousedown', (e) => {
  const onEntity = !!e.target.closest('.node, .resize-handle, .connect-handle');
  const middle = e.button === 1;
  const forced = spaceDown && e.button === 0;
  const handEmpty = handOn && e.button === 0 && !onEntity;
  if (!(middle || forced || handEmpty)) return;
  e.preventDefault();
  e.stopPropagation();
  panState = { x: e.clientX, y: e.clientY, sl: view.scrollLeft, st: view.scrollTop, moved: false };
  view.classList.add('panning');
}, true);

document.addEventListener('mousemove', (e) => {
  if (!panState) return;
  const dx = e.clientX - panState.x, dy = e.clientY - panState.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panState.moved = true;
  view.scrollLeft = panState.sl - dx;
  view.scrollTop = panState.st - dy;
});
document.addEventListener('mouseup', () => {
  if (!panState) return;
  justPanned = panState.moved;
  panState = null;
  view.classList.remove('panning');
  setTimeout(() => { justPanned = false; }, 0);
});
view.addEventListener('click', (e) => {
  if (justPanned || (spaceDown && e.target.closest('.node'))) {
    e.stopPropagation(); e.preventDefault(); // panning must never select/connect a card
  }
}, true);
view.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

/* ------------------------------ minimap ------------------------------ */
const mm = $('minimapCanvas');
const mmCtx = mm.getContext('2d');
const MM_W = 226, MM_H = 140;
{
  const dpr = window.devicePixelRatio || 1;
  mm.width = MM_W * dpr; mm.height = MM_H * dpr;
  mmCtx.scale(dpr, dpr);
}
let mmGeom = null;     // {s, ox, oy} -- board -> minimap mapping
let mmDragging = false;
let mmRaf = null;

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function drawMinimap() {
  mmRaf = null;
  if ($('minimap').classList.contains('collapsed')) return;
  // World shown = everything on the board plus the visible area, so
  // the outline stays on the map even after panning into empty space.
  // (Frozen while dragging inside the minimap so the map can't shift
  // under the pointer.)
  const vwB = view.clientWidth / zoom, vhB = view.clientHeight / zoom;
  const vxB = (view.scrollLeft - PAN_PAD) / zoom, vyB = (view.scrollTop - PAN_PAD) / zoom;
  if (!(mmDragging && mmGeom)) {
    let x1 = 0, y1 = 0, x2 = 900, y2 = 500;
    if (nodes.length) {
      x1 = Math.min(...nodes.map((n) => n.x)) - 120; y1 = Math.min(...nodes.map((n) => n.y)) - 120;
      x2 = Math.max(...nodes.map((n) => n.x + nodeDims(n).w)) + 120; y2 = Math.max(...nodes.map((n) => n.y + nodeDims(n).h)) + 120;
    }
    x1 = Math.min(x1, vxB); y1 = Math.min(y1, vyB);
    x2 = Math.max(x2, vxB + vwB); y2 = Math.max(y2, vyB + vhB);
    const bw = x2 - x1, bh = y2 - y1;
    const s = Math.min(MM_W / bw, MM_H / bh);
    mmGeom = { s, ox: (MM_W - bw * s) / 2 - x1 * s, oy: (MM_H - bh * s) / 2 - y1 * s };
  }
  const { s, ox, oy } = mmGeom;
  mmCtx.clearRect(0, 0, MM_W, MM_H);

  // connections
  mmCtx.lineWidth = 1;
  mmCtx.strokeStyle = 'rgba(143,163,181,.35)';
  const centre = (n) => [ox + (n.x + nodeDims(n).w / 2) * s, oy + (n.y + nodeDims(n).h / 2) * s];
  mmCtx.beginPath();
  nodes.forEach((n) => {
    const p = find(n.parentId);
    if (p) { const [ax, ay] = centre(p), [bx, by] = centre(n); mmCtx.moveTo(ax, ay); mmCtx.lineTo(bx, by); }
  });
  links.forEach((l) => {
    const a = find(l.a), b = find(l.b);
    if (a && b) { const [ax, ay] = centre(a), [bx, by] = centre(b); mmCtx.moveTo(ax, ay); mmCtx.lineTo(bx, by); }
  });
  mmCtx.stroke();

  // entities
  nodes.forEach((n) => {
    const w = Math.max(4, nodeDims(n).w * s), h = Math.max(3, nodeDims(n).h * s);
    mmCtx.fillStyle = STATUS[n.confidence] || '#8fa3b5';
    mmCtx.globalAlpha = n.id === selected ? 1 : 0.8;
    mmCtx.fillRect(ox + n.x * s, oy + n.y * s, w, h);
    if (n.id === selected) {
      mmCtx.globalAlpha = 1;
      mmCtx.strokeStyle = cssVar('--accent') || '#22c7d6';
      mmCtx.strokeRect(ox + n.x * s - 1, oy + n.y * s - 1, w + 2, h + 2);
    }
  });
  mmCtx.globalAlpha = 1;

  // visible area
  const vx = ox + vxB * s, vy = oy + vyB * s;
  const vw = vwB * s, vh = vhB * s;
  const accent = cssVar('--accent') || '#22c7d6';
  mmCtx.fillStyle = 'rgba(34,199,214,.12)';
  mmCtx.fillRect(vx, vy, vw, vh);
  mmCtx.strokeStyle = accent;
  mmCtx.lineWidth = 1.5;
  mmCtx.strokeRect(vx + .75, vy + .75, Math.max(2, vw - 1.5), Math.max(2, vh - 1.5));

  $('minimapTitle').textContent = 'Overview \u00b7 ' + nodes.length + ' \u00b7 ' + Math.round(zoom * 100) + '%';
}
function scheduleMinimap() { if (!mmRaf) mmRaf = requestAnimationFrame(drawMinimap); }

/* Keep the minimap in step with everything that changes the board,
   without touching the code that does the changing. */
{
  const baseRender = render;
  render = function () { baseRender.apply(this, arguments); scheduleMinimap(); };
  const baseUpdate = updateNodeAndPaths;
  updateNodeAndPaths = function () { baseUpdate.apply(this, arguments); scheduleMinimap(); };
}
view.addEventListener('scroll', scheduleMinimap, { passive: true });
window.addEventListener('resize', scheduleMinimap);

function mmToBoard(e) {
  const r = mm.getBoundingClientRect();
  const px = (e.clientX - r.left) * (MM_W / r.width), py = (e.clientY - r.top) * (MM_H / r.height);
  return { x: (px - mmGeom.ox) / mmGeom.s, y: (py - mmGeom.oy) / mmGeom.s };
}
function centreViewOn(bx, by) {
  view.scrollLeft = PAN_PAD + bx * zoom - view.clientWidth / 2;
  view.scrollTop = PAN_PAD + by * zoom - view.clientHeight / 2;
}
mm.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !mmGeom) return;
  mmDragging = true; e.preventDefault();
  const p = mmToBoard(e); centreViewOn(p.x, p.y);
});
document.addEventListener('mousemove', (e) => {
  if (!mmDragging || !mmGeom) return;
  const p = mmToBoard(e); centreViewOn(p.x, p.y);
});
document.addEventListener('mouseup', () => { mmDragging = false; });

function zoomAboutCentre(next) {
  const prev = zoom;
  next = Math.max(0.4, Math.min(1.6, +next.toFixed(2)));
  if (next === prev) return;
  const cx = (view.scrollLeft + view.clientWidth / 2 - PAN_PAD) / prev;
  const cy = (view.scrollTop + view.clientHeight / 2 - PAN_PAD) / prev;
  zoom = next;
  render();
  centreViewOn(cx, cy);
}
$('mmZoomIn').onclick = () => zoomAboutCentre(zoom + 0.1);
$('mmZoomOut').onclick = () => zoomAboutCentre(zoom - 0.1);
$('mmToggle').onclick = () => {
  const box = $('minimap');
  const collapsed = box.classList.toggle('collapsed');
  $('mmToggle').innerHTML = collapsed ? '&#9652;' : '&#9662;';
  $('mmToggle').title = collapsed ? 'Expand overview' : 'Collapse overview';
  if (!collapsed) scheduleMinimap();
};
