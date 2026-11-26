'use strict';
/* ---------------------------------------------------------------------
   7. Rendering
   --------------------------------------------------------------------- */
/* All 8 resize grab zones: 4 edges (n/s/e/w) plus 4 corners, so a node
   can be resized from whichever side is convenient instead of only the
   bottom-right corner. */
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function pathId(kind, id) { return kind + '-' + id; }

/* Curved connector between two node centers. Bows the line perpendicular
   to the a->b direction so parallel/overlapping links fan apart instead
   of stacking, and everything reads as a soft curve rather than a ruler
   line. Curvature is deterministic (seeded by the endpoint ids) so a
   given pair always bows the same way across re-renders. */
/* Real on-screen size of every card (they now vary: photo banner and
   property table make them taller). Filled by measureNodes() after each
   render; layout, physics, minimap and connectors all read it. */
const nodeSizes = new Map();
function nodeDims(n) {
  const m = nodeSizes.get(n.id);
  return { w: (m && m.w) || n.w || 200, h: (m && m.h) || n.h || 72 };
}
function measureNodes() {
  nodeSizes.clear();
  board.querySelectorAll('.node').forEach((el) => {
    nodeSizes.set(+el.dataset.id, { w: el.offsetWidth, h: el.offsetHeight });
  });
}

/* Connector runs border-to-border (bottom of the upper card to the top
   of the lower one, or side to side when they sit level). */
function anchorPoints(a, b) {
  const da = nodeDims(a), db = nodeDims(b);
  const acx = a.x + da.w / 2, acy = a.y + da.h / 2, bcx = b.x + db.w / 2, bcy = b.y + db.h / 2;
  if (b.y > a.y + da.h + 8) return [acx, a.y + da.h, bcx, b.y];
  if (a.y > b.y + db.h + 8) return [acx, a.y, bcx, b.y + db.h];
  if (bcx >= acx) return [a.x + da.w, acy, b.x, bcy];
  return [a.x, acy, b.x + db.w, bcy];
}
function pathD(a, b) {
  const [ax, ay, bx, by] = anchorPoints(a, b);
  return 'M ' + ax + ' ' + ay + ' L ' + bx + ' ' + by;
}

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

function makePath(id, a, b, label, confidence, arrow) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.id = id;
  p.setAttribute('d', pathD(a, b, id));
  p.setAttribute('fill', 'none');
  if (arrow) p.setAttribute('marker-end', 'url(#lt-arrow)');
  // Relationship confidence gets its own thread style -- a disproved
  // link and a corroborated one used to look identical, which hides
  // exactly the distinction confidence tracking exists to surface. The
  // 'finding' (parent/child) thread type keeps its own neutral style
  // regardless, since parentId isn't a confidence-rated relationship.
  if (confidence) p.classList.add('conf-' + confidence);
  if (label) {
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = label;
    p.append(title);
  }
  return p;
}

/* Empty, scrollable margin on every side of the board. It is what lets
   the hand tool drag the board anywhere -- including when there are few
   or no nodes -- instead of stopping the moment the content fits on
   screen. Board point (bx,by) sits at stage pixel (PAN_PAD + bx*zoom, ...). */
const PAN_PAD = 1200;
let panInit = false;
function clientToBoard(clientX, clientY) {
  const rect = view.getBoundingClientRect();
  return {
    x: (clientX - rect.left + view.scrollLeft - PAN_PAD) / zoom,
    y: (clientY - rect.top + view.scrollTop - PAN_PAD) / zoom,
  };
}

function resizeBoard() {
  board.style.setProperty('--inv', String(1 / zoom));   // keeps the selection corners a readable size when zoomed out
  const w = Math.max(900, ...nodes.map((n) => n.x + nodeDims(n).w + 90));
  const h = Math.max(500, ...nodes.map((n) => n.y + nodeDims(n).h + 100));
  board.style.width = w + 'px';
  board.style.height = h + 'px';
  board.style.transform = 'scale(' + zoom + ')';
  board.style.left = PAN_PAD + 'px';
  board.style.top = PAN_PAD + 'px';
  stage.style.width = (w * zoom + 2 * PAN_PAD) + 'px';
  stage.style.height = (h * zoom + 2 * PAN_PAD) + 'px';
  if (!panInit && view.clientWidth) { view.scrollLeft = PAN_PAD; view.scrollTop = PAN_PAD; panInit = true; }
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
}

/* Full rebuild: structural changes (add/remove/connect/import/undo).
   render() tears down and recreates every node element on every call
   (including trivial ones like a rename or a tag edit), so a plain
   CSS entrance animation on .node would replay for the whole board
   constantly -- seenNodeIds remembers which node ids have already
   played their entrance so it only fires once per node, on the render
   where it's actually new to the board. */
const seenNodeIds = new Set();

const isImageUrl = (v) => /^data:image\//.test(v) || /^https?:\/\/\S+\.(jpe?g|png|gif|webp|avif)(\?\S*)?$/i.test(v);

function photoImgHtml(src, cls) {
  if (/^data:/.test(src)) return '<img class="' + cls + '" src="' + esc(src) + '" alt="">';
  return thumbHtml(src, cls);
}

/* One card: [photo banner] / icon + kind + value / property table. */
function nodeInnerHtml(n) {
  const props = (n.props || []).slice(0, 6);
  const rows = props.map((p) =>
    '<div class="prop"><span class="pk" title="' + esc(p.k) + '">' + esc(p.k) + '</span>' +
    '<span class="pv">' + (isImageUrl(p.v) ? photoImgHtml(p.v, 'prop-img') : esc(p.v)) + '</span></div>'
  ).join('');
  return (n.image ? '<div class="node-photo">' + photoImgHtml(n.image, 'node-photo-img') + '</div>' : '') +
    '<div class="node-head">' +
      '<span class="node-icon"><img class="icon" src="' + typeIconSrc(n.type, n.label) + '" alt="" ' +
        'onerror="this.onerror=null;this.src=\'icons/generic.svg\'"></span>' +
      '<div class="txt"><div class="kind">' + esc(typeLabel(n.type)) + '</div>' +
      '<div class="label">' + esc(n.label) + '</div></div>' +
    '</div>' +
    (rows ? '<div class="node-props">' + rows + '</div>' : '') +
    '<div class="meta" title="' + esc(n.confidence) + ' \u00b7 ' + n.evidence.length + ' evidence"><span class="dot"></span></div>' +
    RESIZE_EDGES.map((edge) =>
      '<div class="resize-handle rh-' + edge + '" data-edge="' + edge + '" title="Drag to resize"></div>'
    ).join('') +
    '<div class="connect-handle" title="Drag to another entity to connect them">' +
      '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.2"/></svg>' +
    '</div>';
}


function render() {
  resizeBoard();
  board.querySelectorAll('.node').forEach((e) => e.remove());
  svg.querySelectorAll('path').forEach((e) => e.remove());

  const currentIds = new Set(nodes.map((n) => n.id));
  for (const id of seenNodeIds) if (!currentIds.has(id)) seenNodeIds.delete(id);

  nodes.forEach((n) => {
    const el = document.createElement('div');
    const isNew = !seenNodeIds.has(n.id);
    seenNodeIds.add(n.id);
    el.className = 'node' + ((n.image || (n.props && n.props.length)) ? ' rich' : '') + (isSelected(n.id) ? ' sel' : '') + (isNew ? ' node-enter' : '');
    el.tabIndex = 0;
    el.dataset.id = n.id;
    el.style.cssText = 'left:' + n.x + 'px;top:' + n.y + 'px;--s:' + STATUS[n.confidence] +
      (n.w ? ';width:' + n.w + 'px' : '') + (n.h ? ';min-height:' + n.h + 'px' : '');
    el.innerHTML = nodeInnerHtml(n);
    bindNodeEvents(el, n);
    board.append(el);
  });

  // cards are in the DOM now: measure them, then draw connectors from real sizes
  measureNodes();
  resizeBoard();
  nodes.forEach((n) => {
    if (n.parentId && find(n.parentId)) {
      svg.append(makePath(pathId('parent', n.id), find(n.parentId), n, 'finding', null, true));
    }
  });

  links.forEach((l) => {
    const a = find(l.a), b = find(l.b);
    if (a && b) svg.append(makePath(pathId('link', l.id), a, b, l.label, l.confidence));
  });

  $('empty').style.display = nodes.length ? 'none' : 'block';
  [...multi].forEach((i) => { if (!find(i)) multi.delete(i); });
  side.classList.toggle('open', !!find(selected) || multi.size > 1);
  if (find(selected)) renderInspector(find(selected));
  else if (multi.size > 1) renderMultiInspector();
  $('undo').disabled = !hist.length;
  $('redo').disabled = !future.length;
  if (!$('lsPanel').hasAttribute('hidden')) renderLsTarget();
}

/* Cheap update while dragging: move one node + the paths attached to it,
   without touching the rest of the DOM. Keeps large boards smooth. */
function updateNodeAndPaths(n) {
  const el = board.querySelector('.node[data-id="' + n.id + '"]');
  if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }

  const parentPath = svg.querySelector('#' + pathId('parent', n.id));
  if (parentPath && find(n.parentId)) parentPath.setAttribute('d', pathD(find(n.parentId), n, parentPath.id));

  nodes.forEach((child) => {
    if (child.parentId === n.id) {
      const p = svg.querySelector('#' + pathId('parent', child.id));
      if (p) p.setAttribute('d', pathD(n, child, p.id));
    }
  });

  rels(n.id).forEach((l) => {
    const p = svg.querySelector('#' + pathId('link', l.id));
    const other = find(l.a === n.id ? l.b : l.a);
    if (p && other) p.setAttribute('d', pathD(n.id === l.a ? n : other, n.id === l.a ? other : n, p.id));
  });
}

