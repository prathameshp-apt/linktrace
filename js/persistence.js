'use strict';
/* ---------------------------------------------------------------------
   5. Persistence
   --------------------------------------------------------------------- */
function snapshotBoard() {
  return JSON.stringify({ nodes, links, nextId, nextLink });
}
function saveBoard() {
  localStorage.setItem(STORE_KEY, snapshotBoard());
  if (typeof scheduleBackup === 'function') scheduleBackup();
}
function saveCaseData() {
  localStorage.setItem(CASE_KEY, JSON.stringify(ltCase));
  localStorage.setItem(TIMELINE_KEY, JSON.stringify(ltTimeline.slice(0, 500)));
  localStorage.setItem(TASKS_KEY, JSON.stringify(ltTasks));
  localStorage.setItem(ENGINES_KEY, JSON.stringify(ltEngines));
  localStorage.setItem(EVIDENCE_TYPES_KEY, JSON.stringify(customEvidence));
}
function logEvent(action, detail) {
  ltTimeline.unshift({ id: Date.now() + Math.random(), at: new Date().toISOString(), action, detail: detail || '' });
  saveCaseData();
}
function mark() {
  hist.push(snapshotBoard());
  if (hist.length > 50) hist.shift();
  future = [];
}

/* One entity's evidence entry: {id,type,title,url,image?,notes,confidence,date} */
function sanitizeEvidence(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e.title === 'string' && e.title.trim())
    .map((e) => ({
      id: Number.isFinite(+e.id) ? +e.id : Date.now() + Math.random(),
      type: typeof e.type === 'string' ? e.type.slice(0, 60) : 'Analyst note',
      title: String(e.title).slice(0, 250),
      url: isValidUrl(e.url) ? String(e.url).slice(0, 2000) : '',
      image: isValidUrl(e.image) ? String(e.image).slice(0, 2000) : '', // optional preview photo from the source page
      notes: typeof e.notes === 'string' ? e.notes.slice(0, 10000) : '',
      confidence: STATUS[e.confidence] ? e.confidence : 'unverified',
      date: typeof e.date === 'string' ? e.date.slice(0, 10) : new Date().toISOString().slice(0, 10),
    }))
    .slice(0, 200);
}

/* Card photo: an http(s) URL, or a small data: image (uploaded/pasted). */
function sanitizePhoto(v) {
  if (typeof v !== 'string') return '';
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(v) && v.length < 600000) return v;
  return isValidUrl(v) ? v.slice(0, 2000) : '';
}
/* Card property table: [{k,v}] shown under the title on the node card. */
function sanitizeProps(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && String(p.k ?? '').trim() && String(p.v ?? '').trim())
    .map((p) => ({ k: String(p.k).trim().slice(0, 60), v: String(p.v).trim().slice(0, 400) }))
    .slice(0, 20);
}

/* Validates + normalizes an imported/loaded board. Throws on structurally invalid input. */
function loadBoard(data) {
  if (!data || !Array.isArray(data.nodes)) throw new Error('Not a LinkTrace board.');
  const seenIds = new Set();

  nodes = data.nodes.map((raw) => {
    if (!raw || !String(raw.type ?? '').trim() || !String(raw.label ?? '').trim()) return null;
    const id = +raw.id;
    if (!Number.isSafeInteger(id) || seenIds.has(id)) return null;
    seenIds.add(id);

    // v3 boards stored "sources" separately from "evidence" - fold sources into evidence on load.
    const legacySources = Array.isArray(raw.sources)
      ? raw.sources
          .filter((s) => s && isValidUrl(s.url))
          .map((s) => ({
            type: 'Web page / URL',
            title: s.title || s.url,
            url: s.url,
            notes: '',
            confidence: 'unverified',
            date: s.date || '',
          }))
      : [];

    return {
      id,
      type: String(raw.type).trim().slice(0, 60),
      label: String(raw.label).trim().slice(0, 500),
      x: Number.isFinite(+raw.x) ? Math.max(10, +raw.x) : 60,
      y: Number.isFinite(+raw.y) ? Math.max(10, +raw.y) : 60,
      w: Number.isFinite(+raw.w) ? Math.max(140, +raw.w) : undefined,
      h: Number.isFinite(+raw.h) ? Math.max(70, +raw.h) : undefined,
      parentId: null, // resolved below, once every id is known
      sourceUrl: isValidUrl(raw.sourceUrl) ? String(raw.sourceUrl).slice(0, 2000) : '',
      image: sanitizePhoto(raw.image),
      props: sanitizeProps(raw.props),
      notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 10000) : '',
      confidence: STATUS[raw.confidence] ? raw.confidence : 'unverified',
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string').slice(0, 15) : [],
      evidence: sanitizeEvidence([...(raw.evidence || []), ...legacySources]),
    };
  }).filter(Boolean);

  const validIds = new Set(nodes.map((n) => n.id));
  nodes.forEach((n) => {
    const raw = data.nodes.find((x) => +x.id === n.id);
    const parentId = +raw.parentId;
    n.parentId = validIds.has(parentId) && parentId !== n.id ? parentId : null;
  });

  const seenPairs = new Set();
  links = (data.links || [])
    .map((l) => ({
      id: +l.id,
      a: +l.a,
      b: +l.b,
      label: String(l.label || 'related to').slice(0, 100),
      confidence: STATUS[l.confidence] ? l.confidence : 'unverified',
    }))
    .filter((l) => {
      if (!Number.isSafeInteger(l.id) || !validIds.has(l.a) || !validIds.has(l.b) || l.a === l.b) return false;
      const pairKey = Math.min(l.a, l.b) + ':' + Math.max(l.a, l.b);
      if (seenPairs.has(pairKey)) return false;
      seenPairs.add(pairKey);
      return true;
    });

  nextId = Math.max(0, ...nodes.map((n) => n.id)) + 1;
  nextLink = Math.max(0, ...links.map((l) => l.id)) + 1;
  selected = null; multi.clear();
}

function migrateLegacyBoard() {
  // A pre-existing v3 save (separate "sources" array) gets folded into v4 evidence.
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return false;
    loadBoard(JSON.parse(legacy));
    saveBoard();
    return true;
  } catch { return false; }
}

function loadEverything() {
  try {
    const current = localStorage.getItem(STORE_KEY);
    if (current) loadBoard(JSON.parse(current));
    else migrateLegacyBoard();
  } catch { /* corrupt save - start with an empty board rather than crashing */ }

  try { ltCase = JSON.parse(localStorage.getItem(CASE_KEY)) || ltCase; } catch {}
  try { ltTimeline = JSON.parse(localStorage.getItem(TIMELINE_KEY)) || []; } catch {}
  try { ltTasks = JSON.parse(localStorage.getItem(TASKS_KEY)) || []; } catch {}
  try { ltEngines = JSON.parse(localStorage.getItem(ENGINES_KEY)) || DEFAULT_ENGINES.slice(); } catch {}
  try { customEvidence = JSON.parse(localStorage.getItem(EVIDENCE_TYPES_KEY)) || []; } catch {}
}

