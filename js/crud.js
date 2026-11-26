'use strict';
/* ---------------------------------------------------------------------
   10. Node / link CRUD
   --------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   Duplicate detection
   Compared on a normalised key (case, leading "@", protocol/www and
   trailing slashes ignored) so "@Jane", "jane" and
   "https://www.site.com/x/" vs "site.com/x" are recognised as the same
   thing instead of slipping through as new entities.
   --------------------------------------------------------------------- */
function entityKey(type, label) {
  let v = String(label || '').trim().toLowerCase().replace(/^@/, '');
  if (/^https?:\/\//.test(v)) v = v.replace(/^https?:\/\/(www\.)?/, '').replace(/[\/#?]+$/, '');
  return String(type || '').trim().toLowerCase() + '|' + v;
}
function findDuplicate(type, label) {
  const key = entityKey(type, label);
  return nodes.find((n) => entityKey(n.type, n.label) === key) || null;
}

/* Validates + normalises raw input into {type,label,sourceUrl}, or null
   (after showing an alert) if it isn't usable. Shared by single adds and
   batch adds so both follow exactly the same rules. */
function prepareEntity(type, rawLabel, sourceUrlOverride, quiet, meta) {
  const label = resolveEntityLabel(rawLabel);
  type = (type || '').trim() || detectType(label) || 'entity';
  if (!label) return null;
  if (!isValidValue(type, label)) {
    if (!quiet) showAlert('Invalid value', 'That does not look like a valid ' + typeLabel(type).toLowerCase() + '.');
    return null;
  }
  // The actual page a "handle (Platform)" or plain URL entity resolves
  // to -- callers that already have the exact source URL (search result,
  // dropped link) pass it via sourceUrlOverride so it's used verbatim.
  return { type, label, sourceUrl: sourceUrlOverride || resolveEntitySourceUrl(rawLabel) || '', meta: meta || null };
}

/* Pure insert: no mark()/save/render, so batch adds can do those once. */
function createNodeRaw(prep, parentId, positionOverride) {
  const parent = find(parentId);
  const spot = positionOverride || freeSpot(
    parent ? parent.x + 215 : 60 + nodes.filter((n) => !n.parentId).length * 215,
    parent ? parent.y + 125 : 60
  );
  const node = {
    id: nextId++, type: prep.type, label: prep.label, x: spot.x, y: spot.y,
    parentId: parent ? parent.id : null,
    notes: '', confidence: 'unverified', tags: [], evidence: [],
    sourceUrl: prep.sourceUrl || '',
    image: sanitizePhoto(prep.meta && prep.meta.image),
    props: sanitizeProps(prep.meta && prep.meta.props),
  };
  if (!node.image && /^image$/i.test(prep.type) && isValidUrl(prep.label)) node.image = sanitizePhoto(prep.label);
  nodes.push(node);
  return node;
}

function focusNode(id) {
  const n = find(id);
  if (!n) return;
  selected = id;
  render();
  view.scrollTo(PAN_PAD + (n.x - 120) * zoom, PAN_PAD + (n.y - 120) * zoom);
}

/* Single add. If the value is already on the board the person always
   gets a clear warning saying WHERE it already is, and can cancel, jump
   to the existing one, or add another copy on purpose. onAdded fires
   only when a node was actually created, so callers can show "added"
   feedback truthfully. */
function addNode(type, label, parentId, positionOverride, sourceUrlOverride, onAdded, meta) {
  const prep = prepareEntity(type, label, sourceUrlOverride, false, meta);
  if (!prep) return;

  const create = () => {
    mark();
    const node = createNodeRaw(prep, parentId, positionOverride);
    // keep the parent selected so the next add fans out under it (a tree), not into a chain
    selected = find(parentId) ? parentId : node.id;
    saveBoard();
    afterNodesAdded([node], prep.meta ? 'Result added' : 'Entity added');
    if ($('value')) $('value').value = '';
    if (onAdded) onAdded(node);
  };

  const dupe = findDuplicate(prep.type, prep.label);
  if (!dupe) return create();

  const dupeParent = find(dupe.parentId);
  const alreadyUnderTarget = parentId != null && dupe.parentId === parentId;
  const where = alreadyUnderTarget
    ? 'It is already linked under \u201c' + find(parentId).label + '\u201d.'
    : dupeParent
      ? 'It currently sits under \u201c' + dupeParent.label + '\u201d.'
      : 'It is already on the board as a top-level entity.';
  const canFillUrl = !!(prep.sourceUrl && !dupe.sourceUrl);

  const back = openModal(
    'Already on the board',
    'A ' + typeLabel(prep.type).toLowerCase() + ' \u201c' + dupe.label + '\u201d already exists.',
    '<div class="dupe-where">' + esc(where) + '</div>',
    '<button id="dupCancel">Cancel</button>' +
    '<button id="dupGoto">Show existing</button>' +
    (canFillUrl ? '<button id="dupFill">Add link to existing</button>' : '') +
    '<button class="primary" id="dupAdd">Add duplicate anyway</button>'
  );
  back.querySelector('#dupCancel').onclick = closeOverlays;
  back.querySelector('#dupGoto').onclick = () => { closeOverlays(); focusNode(dupe.id); };
  if (canFillUrl) {
    back.querySelector('#dupFill').onclick = () => {
      closeOverlays();
      mark(); dupe.sourceUrl = prep.sourceUrl; saveBoard(); render();
      setLsStatusSafe('Added the profile link to the existing \u201c' + dupe.label + '\u201d entity.');
    };
  }
  back.querySelector('#dupAdd').onclick = () => { closeOverlays(); create(); };
}

/* Batch add (e.g. "+ add all" on a search result). Asks ONE question
   for the whole batch -- the old per-item confirm dialogs replaced each
   other, so only the last duplicate was ever actually asked about and
   the rest were silently dropped or added. items: [{type,value,url}] */
function addNodesBatch(items, parentId, onAdded) {
  const seen = new Set();
  const preps = [];
  items.forEach((it) => {
    const prep = prepareEntity(it.type, it.value, it.url || '', true, it.meta);
    if (!prep) return;
    const k = entityKey(prep.type, prep.label);
    if (seen.has(k)) return; // same value twice within the batch itself
    seen.add(k);
    preps.push(prep);
  });
  if (!preps.length) return;

  const fresh = preps.filter((p) => !findDuplicate(p.type, p.label));
  const dupes = preps.filter((p) => findDuplicate(p.type, p.label));

  const commit = (list) => {
    if (!list.length) return;
    mark();
    const made = list.map((p) => createNodeRaw(p, parentId));
    selected = find(parentId) ? parentId : made[made.length - 1].id;
    saveBoard();
    const fromResults = list.some((p) => p.meta);
    afterNodesAdded(made, made.length + (fromResults ? ' result' : ' entit') + (fromResults ? (made.length === 1 ? '' : 's') : (made.length === 1 ? 'y' : 'ies')) + ' added');
    if (onAdded) onAdded(list.length);
  };

  if (!dupes.length) return commit(fresh);

  const back = openModal(
    'Some of these are already on the board',
    dupes.length + ' of ' + preps.length + ' already exist.',
    '<div class="dupe-where">' + dupes.map((p) => esc(p.label)).join('<br>') + '</div>',
    '<button id="batCancel">Cancel</button>' +
    (fresh.length ? '<button id="batSkip">Add only the ' + fresh.length + ' new</button>' : '') +
    '<button class="primary" id="batAll">Add all ' + preps.length + ' anyway</button>'
  );
  back.querySelector('#batCancel').onclick = closeOverlays;
  if (fresh.length) back.querySelector('#batSkip').onclick = () => { closeOverlays(); commit(fresh); };
  back.querySelector('#batAll').onclick = () => { closeOverlays(); commit(preps); };
}

/* setLsStatus only exists once livesearch.js has loaded and only makes
   sense to call while that panel is open -- this avoids addNode (used
   from several places besides the search panel) throwing if it isn't. */
function setLsStatusSafe(text) {
  if (typeof setLsStatus === 'function' && $('lsStatus')) setLsStatus(text);
}

/* ---------------------------------------------------------------------
   Delete / detach
   Deleting an entity now removes ONLY that entity. Its linked findings
   stay on the board (re-attached to the deleted entity's own parent if
   it had one, otherwise left standing on their own). Wiping the whole
   branch is an explicit second choice, not the default.
   --------------------------------------------------------------------- */
function childrenOf(id) { return nodes.filter((n) => n.parentId === id); }

function deleteNodeOnly(id) {
  const n = find(id);
  if (!n) return;
  childrenOf(id).forEach((c) => { c.parentId = n.parentId && find(n.parentId) ? n.parentId : null; });
  nodes = nodes.filter((x) => x.id !== id);
  links = links.filter((l) => l.a !== id && l.b !== id);
}

function deleteNodeCascade(id) {
  childrenOf(id).forEach((c) => deleteNodeCascade(c.id));
  nodes = nodes.filter((x) => x.id !== id);
  links = links.filter((l) => l.a !== id && l.b !== id);
}

function removeNode(id) {
  const n = find(id);
  if (!n) return;
  const kids = childrenOf(id);
  const finish = () => { selected = null; saveBoard(); render(); };

  if (!kids.length) {
    return showConfirm('Delete entity', 'Delete \u201c' + n.label + '\u201d? You can bring it back with Undo.', () => {
      mark(); deleteNodeOnly(id); finish();
    }, 'Delete', true);
  }

  const parent = find(n.parentId);
  const back = openModal(
    'Delete entity',
    '\u201c' + n.label + '\u201d has ' + kids.length + ' linked finding' + (kids.length === 1 ? '' : 's') + '.',
    '<div class="dupe-where">' + (parent
      ? 'If you delete only this entity, its findings stay and move up under \u201c' + esc(parent.label) + '\u201d.'
      : 'If you delete only this entity, its findings stay on the board as standalone entities.') + '</div>',
    '<button id="delCancel">Cancel</button>' +
    '<button class="danger" id="delCascade">Delete with ' + kids.length + ' finding' + (kids.length === 1 ? '' : 's') + '</button>' +
    '<button class="primary" id="delOnly">Delete entity only</button>'
  );
  back.querySelector('#delCancel').onclick = closeOverlays;
  back.querySelector('#delOnly').onclick = () => { closeOverlays(); mark(); deleteNodeOnly(id); finish(); };
  back.querySelector('#delCascade').onclick = () => { closeOverlays(); mark(); deleteNodeCascade(id); finish(); };
}

/* Remove a finding from its parent entity WITHOUT deleting it -- the
   node stays on the board, it just stops being a child of that entity.
   (Explicit relationship lines drawn between nodes are separate and
   are removed from the Relationships list.) */
function detachNode(id) {
  const n = find(id);
  if (!n || n.parentId == null) return;
  mark();
  n.parentId = null;
  saveBoard();
  render();
}

/* Right-click shortcut: create a brand-new entity that is immediately
   parented (and thus auto-connected, see render.js) to the node the
   menu was opened on -- no separate "add" then "connect to..." step. */
function showNewConnectedEntity(parentNode) {
  const typeOptions = Object.values(TYPES).map((v) => v[0]).concat(TYPE_SUGGESTIONS)
    .map((label) => '<option value="' + esc(label) + '">').join('');
  const back = openModal(
    'New connected entity',
    'Linked to "' + parentNode.label + '"',
    '<label>Type</label>' +
    '<input id="newEntType" list="newEntTypeList" placeholder="Type (optional)" autocomplete="off">' +
    '<datalist id="newEntTypeList">' + typeOptions + '</datalist>' +
    '<label>Value</label>' +
    '<input id="newEntValue" placeholder="e.g. jane@example.com" autocomplete="off">',
    '<button id="newEntCancel">Cancel</button><button class="primary" id="newEntOk">Add & connect</button>'
  );
  const typeInput = back.querySelector('#newEntType');
  const valueInput = back.querySelector('#newEntValue');
  valueInput.addEventListener('input', () => {
    if (typeInput.value.trim()) return;
    const key = detectType(valueInput.value);
    typeInput.placeholder = key ? 'Type (auto: ' + typeLabel(key) + ')' : 'Type (optional)';
  });
  const submit = () => {
    const value = valueInput.value.trim();
    if (!value) return;
    closeOverlays();
    addNode(resolveType(typeInput.value, value), value, parentNode.id);
  };
  valueInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  typeInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  back.querySelector('#newEntCancel').onclick = closeOverlays;
  back.querySelector('#newEntOk').onclick = submit;
}

function connectNodes(fromId, toId) {
  if (fromId === toId) return;
  if (links.some((l) => (l.a === fromId && l.b === toId) || (l.a === toId && l.b === fromId))) return;
  showPrompt('Relationship label', 'Describe how these are related', 'related to', (label) => {
    mark();
    links.push({ id: nextLink++, a: fromId, b: toId, label, confidence: 'unverified' });
    saveBoard();
    render();
  });
}

