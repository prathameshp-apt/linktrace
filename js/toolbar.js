'use strict';
/* ---------------------------------------------------------------------
   14. Toolbar: add / search / zoom / undo-redo / import-export
   --------------------------------------------------------------------- */
function downloadFile(content, filename, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
}

$('typeList').innerHTML = Object.values(TYPES).map((v) => v[0]).concat(TYPE_SUGGESTIONS)
  .map((label) => '<option value="' + esc(label) + '">').join('');

$('add').onclick = () => addNode(resolveType('', $('value').value), $('value').value);
$('value').onkeydown = (e) => { if (e.key === 'Enter') $('add').click(); };

/* Board search: dims everything that doesn't match, and rings the
   entities that do -- dim-only left the matches themselves visually
   identical to a fresh unfiltered board, which is easy to miss once a
   board has 30+ cards. Ringing gives an actual "here they are" signal.
   Enter frames every match in view instead of leaving the person to
   scroll and hunt on a large board. */
function boardSearchMatches() {
  const q = $('search').value.trim().toLowerCase();
  if (!q) return null;
  return nodes.filter((n) => {
    const haystack = [n.label, n.notes, ...n.tags, ...n.evidence.map((ev) => ev.title + ev.url)].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

$('search').oninput = () => {
  const matches = boardSearchMatches();
  const matchIds = matches ? new Set(matches.map((n) => n.id)) : null;
  board.querySelectorAll('.node').forEach((el) => {
    const id = +el.dataset.id;
    el.classList.toggle('dim', !!matchIds && !matchIds.has(id));
    el.classList.toggle('search-hit', !!matchIds && matchIds.has(id));
  });
};

$('search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const matches = boardSearchMatches();
  if (!matches || !matches.length) return;
  const xs = matches.map((n) => n.x), ys = matches.map((n) => n.y);
  zoom = Math.max(0.4, Math.min(1.0,
    (view.clientWidth - 100) / (Math.max(...xs) - Math.min(...xs) + 300),
    (view.clientHeight - 100) / (Math.max(...ys) - Math.min(...ys) + 220)));
  render();
  $('search').dispatchEvent(new Event('input')); // re-apply dim/highlight after render() rebuilds the DOM
  view.scrollTo(PAN_PAD + (Math.min(...xs) - 40) * zoom, PAN_PAD + (Math.min(...ys) - 40) * zoom);
});

/* Scroll to zoom, anchored under the cursor so the point you're pointing
   at stays put -- replaces the old +/- buttons. */
view.addEventListener('wheel', (e) => {
  e.preventDefault();
  const prevZoom = zoom;
  const delta = e.deltaY > 0 ? -0.08 : 0.08;
  zoom = Math.max(0.4, Math.min(1.6, +(zoom + delta).toFixed(2)));
  if (zoom === prevZoom) return;
  const rect = view.getBoundingClientRect();
  // board point under the cursor stays put: PAN_PAD is a constant margin, so only the board part scales
  const bx = (e.clientX - rect.left + view.scrollLeft - PAN_PAD) / prevZoom;
  const by = (e.clientY - rect.top + view.scrollTop - PAN_PAD) / prevZoom;
  render();
  view.scrollLeft = PAN_PAD + bx * zoom - (e.clientX - rect.left);
  view.scrollTop = PAN_PAD + by * zoom - (e.clientY - rect.top);
}, { passive: false });

$('fit').onclick = () => {
  if (!nodes.length) return;
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  zoom = Math.max(0.4, Math.min(1.0,
    (view.clientWidth - 100) / (Math.max(...xs) - Math.min(...xs) + 300),
    (view.clientHeight - 100) / (Math.max(...ys) - Math.min(...ys) + 220)));
  render();
  view.scrollTo(PAN_PAD + (Math.min(...xs) - 40) * zoom, PAN_PAD + (Math.min(...ys) - 40) * zoom);
};

$('undo').onclick = undo;
$('redo').onclick = redo;

$('clear').onclick = () => {
  showConfirm('Clear the board', 'This removes every entity, relationship and piece of evidence from the board.', () => {
    mark();
    nodes = []; links = []; selected = null;
    saveBoard();
    render();
  }, 'Clear board', true);
};

$('json').onclick = () => downloadFile(JSON.stringify({ version: 4, nodes, links }, null, 2), 'linktrace-board.json', 'application/json');
$('csv').onclick = () => {
  const q = (x) => '"' + String(x ?? '').replaceAll('"', '""') + '"';
  const rows = ['id,type,label,confidence,tags,notes,evidence_urls,parent_id'];
  nodes.forEach((n) => {
    rows.push([n.id, n.type, n.label, n.confidence, n.tags.join(';'), n.notes,
      n.evidence.map((e) => e.url).filter(Boolean).join(';'), n.parentId].map(q).join(','));
  });
  downloadFile(rows.join('\n'), 'linktrace-entities.csv', 'text/csv');
};

$('load').onclick = () => $('file').click();
$('file').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      mark();
      loadBoard(JSON.parse(reader.result));
      saveBoard();
      render();
    } catch {
      showAlert('Import failed', 'This is not a valid LinkTrace export.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
};

