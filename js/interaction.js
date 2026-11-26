'use strict';
/* ---------------------------------------------------------------------
   12. Node interaction: click / drag / right-click context menu
   --------------------------------------------------------------------- */

function showNodeContextMenu(x, y, n) {
  closeOverlays();
  const menu = document.createElement('div');
  menu.className = 'context';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.innerHTML =
    '<button id="ctxNewConnected">New connected entity\u2026</button>' +
    '<button id="ctxConnect">Connect to existing\u2026</button>' +
    '<button id="ctxRename">Rename</button>' +
    '<button id="ctxMerge">Merge into\u2026</button>' +
    (n.parentId && find(n.parentId) ? '<button id="ctxDetach">Remove from parent entity</button>' : '') +
    '<button id="ctxDelete" class="danger-text">Delete</button>';
  document.body.append(menu);
  menu.querySelector('#ctxNewConnected').onclick = () => { closeOverlays(); showNewConnectedEntity(n); };
  menu.querySelector('#ctxConnect').onclick = () => { closeOverlays(); linkFrom = n.id; $('banner').classList.add('on'); };
  menu.querySelector('#ctxMerge').onclick = () => { closeOverlays(); showMergeModal(n); };
  menu.querySelector('#ctxRename').onclick = () => {
    closeOverlays();
    showPrompt('Rename entity', 'New value', n.label, (value) => { mark(); n.label = value; saveBoard(); render(); });
  };
  const detachBtn = menu.querySelector('#ctxDetach');
  if (detachBtn) detachBtn.onclick = () => { closeOverlays(); detachNode(n.id); };
  menu.querySelector('#ctxDelete').onclick = () => { closeOverlays(); removeNode(n.id); };
}

/* Right-click on empty board canvas: a lighter-weight menu of
   board-level actions -- creating a new entity right where the click
   landed, fitting the view, and the two export formats -- so someone
   doesn't have to reach for the toolbar for the most common actions. */
function showBoardContextMenu(clientX, clientY, boardX, boardY) {
  closeOverlays();
  const menu = document.createElement('div');
  menu.className = 'context';
  menu.style.left = clientX + 'px';
  menu.style.top = clientY + 'px';
  menu.innerHTML =
    '<button id="ctxNewEntity">New entity here\u2026</button>' +
    '<button id="ctxFit">Fit to view</button>' +
    '<button id="ctxExportJson">Export JSON</button>' +
    '<button id="ctxExportCsv">Export CSV</button>';
  document.body.append(menu);

  menu.querySelector('#ctxNewEntity').onclick = () => {
    closeOverlays();
    showPrompt('New entity', 'Value', '', (value) => {
      addNode('', value, null, { x: Math.max(10, Math.round(boardX - 95)), y: Math.max(10, Math.round(boardY - 40)) });
    });
  };
  menu.querySelector('#ctxFit').onclick = () => { closeOverlays(); $('fit').click(); };
  menu.querySelector('#ctxExportJson').onclick = () => { closeOverlays(); $('json').click(); };
  menu.querySelector('#ctxExportCsv').onclick = () => { closeOverlays(); $('csv').click(); };
}

view.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.node')) return; // node's own handler already took this
  e.preventDefault();
  const pt = clientToBoard(e.clientX, e.clientY);
  showBoardContextMenu(e.clientX, e.clientY, pt.x, pt.y);
});

function bindNodeEvents(el, n) {
  el.onmousedown = (e) => {
    if (e.button || e.target.closest('.resize-handle')) return;
    if (linkFrom) return; // let the click handler below finish the connect-mode pick
    if (e.shiftKey || e.ctrlKey || e.metaKey) { e.preventDefault(); toggleInSelection(n.id); return; }   // add / remove from the selection
    const group = multi.has(n.id) && multi.size > 1
      ? [...multi].map(find).filter(Boolean).map((m) => ({ id: m.id, ox: m.x, oy: m.y })) : null;
    drag = {
      group,
      id: n.id, x: e.clientX, y: e.clientY, ox: n.x, oy: n.y, moved: false,
      vx: 0, vy: 0, lastX: e.clientX, lastY: e.clientY, lastT: performance.now(),
      pre: snapshotBoard(), // state BEFORE the move, so Undo really puts things back
    };
    (group ? group.map((g) => board.querySelector('.node[data-id="' + g.id + '"]')) : [el]).forEach((x) => x && x.classList.add('dragging'));
    document.body.classList.add('grabbing-active'); // pins the grabbing cursor everywhere, not just over the node
    e.preventDefault();
  };

  el.onclick = (e) => {
    if (e.target.closest('.resize-handle')) return;
    if (linkFrom) {
      if (linkFrom !== n.id) connectNodes(linkFrom, n.id);
      linkFrom = null;
      $('banner').classList.remove('on');
      return;
    }
    if (!drag || !drag.moved) { multi.clear(); selected = n.id; render(); }
  };

  el.oncontextmenu = (e) => { e.preventDefault(); showNodeContextMenu(e.clientX, e.clientY, n); };

  el.querySelectorAll('.resize-handle').forEach((handle) => {
    handle.onmousedown = (e) => {
      e.stopPropagation();
      e.preventDefault();
      resizeDrag = {
        id: n.id, edge: handle.dataset.edge, x: e.clientX, y: e.clientY,
        ow: n.w || el.offsetWidth, oh: n.h || el.offsetHeight, ox: n.x, oy: n.y,
        pre: snapshotBoard(),
      };
    };
  });

  // Dedicated connect gesture: grabbing this handle can only ever start
  // a connection, never a move -- it's a separate element with its own
  // mousedown, so there's no shared state with node-drag that could
  // misfire into an accidental move or an accidental connect.
  el.querySelector('.connect-handle').onmousedown = (e) => {
    e.stopPropagation();
    e.preventDefault();
    connectDrag = { fromId: n.id };
    el.classList.add('connect-source');
    ensureConnectWireEl();
  };

  el.addEventListener('mouseenter', () => {
    if (connectDrag && connectDrag.fromId !== n.id) el.classList.add('connect-target');
  });
  el.addEventListener('mouseleave', () => el.classList.remove('connect-target'));

  el.addEventListener('mouseup', () => {
    if (!connectDrag) return;
    if (connectDrag.fromId !== n.id) connectNodes(connectDrag.fromId, n.id);
    endConnectDrag();
  });

  // Drop a link (dragged from anywhere the browser allows -- another
  // tab, a text selection, an image) straight onto this node's evidence
  // palette, no need to select it first. A dragged entity chip from the
  // live-search panel (phone/email/social) instead becomes a real,
  // auto-linked child node -- that's the "automanage" path.
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-over');
    const chipPayload = e.dataTransfer.getData('application/x-linktrace-entity');
    if (chipPayload) {
      try {
        const { type, value } = JSON.parse(chipPayload);
        addNode(type, value, n.id);
      } catch {}
      return;
    }
    const imgFile = [...(e.dataTransfer.files || [])].find((f) => /^image\//.test(f.type));
    if (imgFile) { fileToPhotoData(imgFile).then((d) => setNodePhoto(n, d)).catch(() => {}); return; }
    const url = extractDroppedUrl(e.dataTransfer);
    if (!url) return;
    const plain = e.dataTransfer.getData('text/plain');
    // A dropped link is ambiguous (is it a new entity or a source for
    // this one?), so ask instead of silently attaching it as evidence.
    const back = openModal('Add this link', url, '',
      '<button id="dropCancel">Cancel</button>' +
      '<button id="dropNode">Add as linked node</button>' +
      '<button class="primary" id="dropEv">Add as evidence</button>');
    back.querySelector('#dropCancel').onclick = closeOverlays;
    back.querySelector('#dropNode').onclick = () => { closeOverlays(); addNode(resolveType('', url), url, n.id, null, url); };
    back.querySelector('#dropEv').onclick = () => {
      closeOverlays();
      mark();
      n.evidence.push({
        id: Date.now(), type: 'Web page / URL', title: (plain && plain !== url) ? plain : url, url, notes: '',
        confidence: 'unverified', date: new Date().toISOString().slice(0, 10),
      });
      saveBoard(); render();
    };
  });
}

/* ---------------------------------------------------------------------
   Connect-handle drag: a live rubber-band line from the source node to
   wherever the cursor is, snapping visual "armed" state onto whatever
   node it's currently over. Fully separate code path from move/resize
   -- it never touches n.x/n.y, so it cannot cause the old snap-back bug.
   --------------------------------------------------------------------- */
function ensureConnectWireEl() {
  let wire = svg.querySelector('#connect-wire');
  if (!wire) {
    wire = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    wire.id = 'connect-wire';
    wire.classList.add('wire-live');
    svg.append(wire);
  }
  return wire;
}

function endConnectDrag() {
  document.querySelectorAll('.node.connect-source').forEach((el) => el.classList.remove('connect-source'));
  document.querySelectorAll('.node.connect-target').forEach((el) => el.classList.remove('connect-target'));
  svg.querySelector('#connect-wire')?.remove();
  connectDrag = null;
}

document.addEventListener('mousemove', (e) => {
  if (connectDrag) {
    const from = find(connectDrag.fromId);
    const el = from && board.querySelector('.node[data-id="' + from.id + '"]');
    if (!from || !el) { endConnectDrag(); return; }
    const rect = view.getBoundingClientRect();
    const { x: cx, y: cy } = clientToBoard(e.clientX, e.clientY);
    const wire = ensureConnectWireEl();
    const ax = from.x + (nodeDims(from).w) / 2, ay = from.y + (nodeDims(from).h) / 2;
    wire.setAttribute('d', 'M ' + ax + ' ' + ay + ' L ' + cx + ' ' + cy);
    return;
  }
  if (drag) {
    const n = find(drag.id);
    if (!n) return;
    const dx = (e.clientX - drag.x) / zoom, dy = (e.clientY - drag.y) / zoom;
    drag.moved = drag.moved || Math.abs(dx) > 3 || Math.abs(dy) > 3;
    if (drag.group) {                       // several selected: they all move together, keeping their layout
      const cdx = Math.max(dx, 10 - Math.min(...drag.group.map((g) => g.ox)));
      const cdy = Math.max(dy, 10 - Math.min(...drag.group.map((g) => g.oy)));
      drag.group.forEach((g) => { const m = find(g.id); if (m) { m.x = g.ox + cdx; m.y = g.oy + cdy; updateNodeAndPaths(m); } });
      wakePhysics();
      return;
    }
    n.x = Math.max(10, drag.ox + dx);
    n.y = Math.max(10, drag.oy + dy);

    // Pointer velocity (px/ms, blended so one jittery sample can't launch
    // a throw) -- carried into a short glide on release.
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastT);
    drag.vx = drag.vx * 0.7 + ((e.clientX - drag.lastX) / dt) * 0.3;
    drag.vy = drag.vy * 0.7 + ((e.clientY - drag.lastY) / dt) * 0.3;
    drag.lastX = e.clientX; drag.lastY = e.clientY; drag.lastT = now;

    updateNodeAndPaths(n);          // cheap: only this node + its paths move
    wakePhysics();                  // linked entities follow on their leash
  } else if (resizeDrag) {
    const n = find(resizeDrag.id);
    if (!n) return;
    const dx = (e.clientX - resizeDrag.x) / zoom, dy = (e.clientY - resizeDrag.y) / zoom;
    const edge = resizeDrag.edge; // combination of 'n','s','e','w', e.g. 'se', 'n', 'w'
    const MIN_W = 150, MIN_H = 70;

    // Right/bottom edges just grow the box. Left/top edges grow it while
    // also sliding x/y the other way, so the OPPOSITE edge stays put --
    // that's what makes dragging the top-left corner feel like resizing
    // from that corner instead of the whole box sliding around.
    if (edge.includes('e')) n.w = Math.max(MIN_W, Math.round(resizeDrag.ow + dx));
    if (edge.includes('s')) n.h = Math.max(MIN_H, Math.round(resizeDrag.oh + dy));
    if (edge.includes('w')) {
      const w = Math.max(MIN_W, Math.round(resizeDrag.ow - dx));
      n.x = Math.max(10, resizeDrag.ox + (resizeDrag.ow - w));
      n.w = w;
    }
    if (edge.includes('n')) {
      const h = Math.max(MIN_H, Math.round(resizeDrag.oh - dy));
      n.y = Math.max(10, resizeDrag.oy + (resizeDrag.oh - h));
      n.h = h;
    }

    const el = board.querySelector('.node[data-id="' + n.id + '"]');
    if (el) {
      el.style.width = n.w + 'px';
      el.style.minHeight = n.h + 'px';
      nodeSizes.set(n.id, { w: el.offsetWidth, h: el.offsetHeight });
    }
    updateNodeAndPaths(n);
  }
});

document.addEventListener('mouseup', () => {
  if (connectDrag) endConnectDrag(); // if a node's own mouseup didn't already consume it -- e.g. dropped on empty space
  const pushUndo = (pre) => { hist.push(pre); if (hist.length > 50) hist.shift(); future = []; };
  if (drag) {
    document.body.classList.remove('grabbing-active');
    const n = find(drag.id);
    const el = n && board.querySelector('.node[data-id="' + n.id + '"]');
    board.querySelectorAll('.node.dragging').forEach((x) => { x.classList.remove('dragging'); x.style.transform = ''; });
    if (drag.moved && n) {
      pushUndo(drag.pre);
      saveBoard(); resizeBoard();
      if (!drag.group) releaseWithThrow(n.id, drag.vx, drag.vy);
    }
  }
  if (resizeDrag) { pushUndo(resizeDrag.pre); saveBoard(); resizeBoard(); wakePhysics(); }
  drag = null;
  resizeDrag = null;
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.context')) document.querySelector('.context')?.remove();
});

