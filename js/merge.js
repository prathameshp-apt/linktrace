'use strict';
/* Merge two cards that turned out to be the same person/account/page. */
function mergeNodes(srcId, dstId) {
  const s = find(srcId), d = find(dstId);
  if (!s || !d || s === d) return;
  mark();
  const evKey = (e) => (e.url || '') + '|' + e.title;
  const have = new Set(d.evidence.map(evKey));
  s.evidence.forEach((e) => { if (!have.has(evKey(e))) d.evidence.push(e); });
  d.tags = [...new Set([...(d.tags || []), ...(s.tags || [])])].slice(0, 15);
  if (s.notes && !d.notes.includes(s.notes)) d.notes = (d.notes ? d.notes + '\n\n' : '') + s.notes;
  const keys = new Set((d.props || []).map((p) => p.k.toLowerCase()));
  d.props = sanitizeProps([...(d.props || []), ...(s.props || []).filter((p) => !keys.has(p.k.toLowerCase()))]);
  if (!d.image && s.image) d.image = s.image;
  if (!d.sourceUrl && s.sourceUrl) d.sourceUrl = s.sourceUrl;
  nodes.forEach((n) => { if (n.parentId === s.id) n.parentId = d.id; });
  if (d.parentId === s.id) d.parentId = s.parentId && s.parentId !== d.id ? s.parentId : null;
  links.forEach((l) => { if (l.a === s.id) l.a = d.id; if (l.b === s.id) l.b = d.id; });
  const seen = new Set();
  links = links.filter((l) => {
    if (l.a === l.b) return false;
    const k = Math.min(l.a, l.b) + ':' + Math.max(l.a, l.b);
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  nodes = nodes.filter((n) => n.id !== s.id);
  selected = d.id;
  logEvent('Merged entities', s.label + ' \u2192 ' + d.label);
  saveBoard(); render();
  if (autoLayoutOn) { relayoutFor(d.id); saveBoard(); render(); }
  const tag = hist.length;
  showToast('Merged into \u201c' + d.label + '\u201d', 'Undo', () => { if (hist.length === tag) undo(); });
}

function showMergeModal(n) {
  const others = nodes.filter((x) => x.id !== n.id);
  if (!others.length) return showAlert('Nothing to merge with', 'Add another entity first.');
  const back = openModal('Merge into\u2026', '\u201c' + n.label + '\u201d will be folded into the entity you pick: its evidence, tags, notes, details and connections move over, then this card is removed.',
    '<input id="mFilter" placeholder="Search entities" autocomplete="off"><div class="type-list">' +
    others.map((o) => '<button type="button" class="type-row" data-mid="' + o.id + '"><img class="icon" src="' + esc(typeIconSrc(o.type, o.label)) + '" alt="" onerror="this.onerror=null;this.src=\'icons/generic.svg\'"><span>' + esc(o.label) + ' <small>' + esc(typeLabel(o.type)) + '</small></span></button>').join('') + '</div>',
    '<button id="mCancel">Cancel</button>');
  back.querySelector('#mCancel').onclick = closeOverlays;
  back.querySelector('#mFilter').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    back.querySelectorAll('.type-row').forEach((b) => { b.hidden = !!q && !b.textContent.toLowerCase().includes(q); });
  };
  back.querySelectorAll('.type-row').forEach((b) => { b.onclick = () => { closeOverlays(); mergeNodes(n.id, +b.dataset.mid); }; });
}
