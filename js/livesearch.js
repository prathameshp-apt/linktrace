'use strict';
/* ---------------------------------------------------------------------
   19. Search panel (bottom-left circle)
   Calls the local SearXNG backend bundled with this VM (see
   /osint-vm/README.md) and renders results as real result cards right
   here in the panel -- no iframe, no popup, no new tab.

   This works reliably where embedding Google/Bing/DuckDuckGo/etc.
   directly never could: those engines block iframes at the browser
   level (a header their server sends), which no front-end code can
   open back up. SearXNG here is *your own* local server, so there's
   no such header and results come back as plain JSON data instead of
   a whole webpage -- rendered with LinkTrace's own result cards.

   If the backend isn't running, the panel says so plainly with the
   command to start it, rather than failing silently.
   --------------------------------------------------------------------- */

const SEARXNG_BASE = 'http://127.0.0.1:8888';

/* "Engine" tabs here just add a SearXNG engine filter (?engines=...) to
   the same local query -- still one backend, no separate embeds. Every
   engine listed here is enabled in osint-vm/searxng/settings.yml. */
const SEARCH_TABS = [
  { id: 'all', label: 'All engines', engines: '' },
  { id: 'google', label: 'Google', engines: 'google' },
  { id: 'bing', label: 'Bing', engines: 'bing' },
  { id: 'duckduckgo', label: 'DuckDuckGo', engines: 'duckduckgo' },
  { id: 'brave', label: 'Brave', engines: 'brave' },
  { id: 'startpage', label: 'Startpage', engines: 'startpage' },
  { id: 'yandex', label: 'Yandex', engines: 'yandex' },
  { id: 'mojeek', label: 'Mojeek', engines: 'mojeek' },
  { id: 'wikipedia', label: 'Wikipedia', engines: 'wikipedia' },
  { id: 'github', label: 'GitHub', engines: 'github' },
  { id: 'gitlab', label: 'GitLab', engines: 'gitlab' },
  { id: 'stackoverflow', label: 'Stack Overflow', engines: 'stackoverflow' },
  { id: 'arxiv', label: 'arXiv', engines: 'arxiv' },
];

let lsActiveTab = SEARCH_TABS[0].id;

/* ---- infinite-scroll state: SearXNG returns one page (~20-30 results)
   per request, so "unlimited" scrolling means fetching page 2, 3, ...
   on demand as the panel is scrolled, and stitching results together. ---- */
let lsResultsData = [];
let lsToolData = [];                    // hits from Holehe / Ignorant / Maigret, shown in the same list
const TOOL_BASE = 100000;               // data-ri >= this means lsToolData[ri - TOOL_BASE]
const resultAt = (ri) => (ri >= TOOL_BASE ? lsToolData[ri - TOOL_BASE] : lsResultsData[ri]);
const allResults = () => lsToolData.concat(lsResultsData);
const pickKey = (r) => r._key || r.url;
let lsPageNo = 1;
let lsLoadingMore = false;
let lsExhausted = false;
let lsLastQuery = '';
let lsLastEngines = '';

function setLsStatus(text) { $('lsStatus').textContent = text || ''; }
function setLoadMoreStatus(text) {
  const el = $('lsLoadMore');
  if (el) el.textContent = text || '';
}

/* SOCIAL_PATTERNS now lives in config.js (shared with manual entry in
   utils.js) -- see that file for the platform list. */

function extractEntities(text) {
  const out = { email: new Set(), phone: new Set(), url: new Set(), domain: new Set(), username: new Set() };
  const usernameUrls = new Map(); // "handle (Platform)" -> the exact profile URL it was found at
  (text.match(EXTRACT_PATTERNS.email) || []).forEach((v) => out.email.add(v));
  (text.match(EXTRACT_PATTERNS.url) || []).forEach((v) => {
    out.url.add(v);
    try { out.domain.add(new URL(v).hostname.replace(/^www\./, '')); } catch {}
    SOCIAL_PATTERNS.forEach((s) => {
      const m = v.match(s.re);
      if (m) {
        const chip = m[1] + ' (' + s.platform + ')';
        out.username.add(chip);
        usernameUrls.set(chip, v); // the real URL this chip was extracted from, not a guess
      }
    });
  });
  (text.match(EXTRACT_PATTERNS.phone) || []).forEach((v) => {
    const digits = v.replace(/[^\d]/g, '');
    if (digits.length >= 7 && digits.length <= 15) out.phone.add(v.trim());
  });
  out._usernameUrls = usernameUrls;
  return out;
}

/* What a search result offers to add to the board: ONLY the result's own
   link (the page it actually points at), plus the profile handle if that
   link is a recognised social profile. Previously every URL, domain,
   e-mail and phone number found anywhere in the title/snippet was
   offered too, which buried the real result under a pile of chips. */
function resultEntities(r) {
  if (r && r._acct) {
    const e = ACCOUNT_TOOLS[r._acct.tool].entity(r._acct.f, r._acct.subject);
    return [{ type: e.type, value: e.value, url: e.url || '', meta: e.meta }];
  }
  const out = [];
  if (!r || !r.url) return out;
  const host = hostOf(r.url);
  const snip = (r.content || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const social = detectSocialProfile(r.url);
  out.push({ type: 'url', value: r.url, url: r.url, meta: { image: r.img || '', props: [
    { k: 'Site', v: host }, { k: 'Title', v: r.title || '' }, { k: 'About', v: snip } ] } });
  if (social) out.push({ type: 'username', value: social.handle + ' (' + social.platform + ')', url: r.url, meta: { image: r.img || '', props: [
    { k: 'Platform', v: social.platform }, { k: 'Handle', v: social.handle }, { k: 'Page', v: r.title || '' } ] } });
  return out;
}
/* what the card's main "Add +" adds: the profile if it is one, else the link */
function primaryEntity(r) {
  const e = resultEntities(r);
  return e.find((x) => x.type === 'username') || e[0] || null;
}

const lsPicked = new Set();   // result urls ticked for bulk add
function entityChipsHtml(list) {
  return list.map((e) =>
    '<span class="ls-chip ls-chip-' + (e.type === 'url' ? 'url' : 'handle') + '" draggable="true" data-drag-type="' + e.type +
      '" data-drag-value="' + esc(e.value) + '" title="' + esc(e.value) + '">' +
      '<span class="ls-chip-text">' + esc(e.value) + '</span>' +
      '<button data-add-type="' + e.type + '" data-add-value="' + esc(e.value) + '" data-add-url="' + esc(e.url || '') + '">+ node</button>' +
    '</span>'
  ).join('');
}

/* ---- tab bar + "which entity gets palette drops" row ---- */
function renderEngineMenu() {
  const cur = SEARCH_TABS.find((t) => t.id === lsActiveTab) || SEARCH_TABS[0];
  $('lsEngineLabel').textContent = cur.label;
  $('lsEngineMenu').innerHTML = SEARCH_TABS.map((t) =>
    '<button type="button" role="option" class="ls-engine-opt' + (t.id === lsActiveTab ? ' active' : '') + '" aria-selected="' + (t.id === lsActiveTab) + '" data-tab="' + t.id + '">' +
      '<span class="ls-engine-tick">' + (t.id === lsActiveTab ? '\u2713' : '') + '</span>' + esc(t.label) + '</button>'
  ).join('');
  $('lsEngineMenu').querySelectorAll('[data-tab]').forEach((btn) => {
    btn.onclick = () => {
      lsActiveTab = btn.dataset.tab;
      setEngineMenu(false); renderEngineMenu(); renderLsTarget();
      if ($('lsQuery').value.trim()) runLiveSearch();
    };
  });
}
function setEngineMenu(open) {
  $('lsEngineMenu').hidden = !open;
  $('lsEngineBtn').setAttribute('aria-expanded', String(open));
}
$('lsEngineBtn').onclick = (e) => { e.stopPropagation(); setEngineMenu($('lsEngineMenu').hidden); };
document.addEventListener('click', (e) => { if (!e.target.closest('.ls-engine-wrap')) setEngineMenu(false); });
document.addEventListener('keydown', (e) => {          // capture phase: Esc closes just the menu, not the whole panel
  if (e.key === 'Escape' && !$('lsEngineMenu').hidden) { setEngineMenu(false); e.stopImmediatePropagation(); e.preventDefault(); }
}, true);

function renderLsTarget() {
  const n = find(selected);
  $('lsTarget').innerHTML = n
    ? 'Evidence goes to: <b>' + esc(n.label) + '</b>'
    : '<span class="dim">Select an entity on the board to enable \u201c+ evidence\u201d</span>';
}

/* ---- advanced search: builds a proper operator query string, the same
   idea as site:/filetype:/intitle:/intext:/exclude terms that tools like
   python-advanced-search generate, just assembled client-side here since
   this panel already talks directly to the search backend. The base
   query box and these fields combine into one query string. ---- */
function buildAdvancedQuery(baseQuery) {
  const parts = [];
  if (baseQuery) parts.push(baseQuery);
  const exact = $('lsAdvExact').value.trim();
  if (exact) parts.push('"' + exact.replace(/"/g, '') + '"');
  const site = $('lsAdvSite').value.trim();
  if (site) parts.push('site:' + site.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''));
  const filetype = $('lsAdvFiletype').value.trim();
  if (filetype) parts.push('filetype:' + filetype.replace(/^\./, ''));
  const intitle = $('lsAdvIntitle').value.trim();
  if (intitle) intitle.split(/\s+/).forEach((w) => parts.push('intitle:' + w));
  // "in page body": plain required words -- every engine honours these, and the
  // result check below confirms them (intext: is Google-only, so it was unreliable)
  const intext = $('lsAdvIntext').value.trim();
  if (intext) intext.split(/\s+/).forEach((w) => parts.push(w));
  const exclude = $('lsAdvExclude').value.trim();
  if (exclude) exclude.split(',').map((w) => w.trim()).filter(Boolean).forEach((w) => parts.push('-' + w.replace(/\s+/g, '')));
  return parts.join(' ');
}

function updateAdvPreview() {
  const built = buildAdvancedQuery($('lsQuery').value.trim());
  $('lsAdvPreview').textContent = built ? 'Query: ' + built : '';
}

function bindAdvancedFields() {
  ['lsAdvSite', 'lsAdvFiletype', 'lsAdvExact', 'lsAdvExclude', 'lsAdvIntitle', 'lsAdvIntext'].forEach((id) => {
    $(id).addEventListener('input', updateAdvPreview);
  });
  $('lsQuery').addEventListener('input', updateAdvPreview);
  $('lsAdvancedToggle').onclick = () => {
    const panel = $('lsAdvanced');
    const open = panel.hasAttribute('hidden');
    panel.toggleAttribute('hidden', !open);
    $('lsAdvancedToggle').setAttribute('aria-expanded', String(open));
    $('lsAdvancedToggle').classList.toggle('active', open);
    if (open) updateAdvPreview();
  };
}
bindAdvancedFields();

/* ---- add a URL to the currently selected entity's EVIDENCE palette (only
   ever called from an explicit "+ evidence" / evidence drop -- adding a
   node never creates evidence on its own) ---- */
function addUrlToPalette(url, title, snippet, image) {
  const target = find(selected);
  if (!target) { setLsStatus('Select an entity on the board first.'); return false; }
  if (!url) return false;
  mark();
  target.evidence.push({
    id: Date.now(),
    type: 'Web page / URL',
    title: title || url,
    url,
    image: isValidUrl(image) ? image : '',
    notes: snippet || '',
    confidence: 'unverified',
    date: new Date().toISOString().slice(0, 10),
  });
  saveBoard(); render();
  setLsStatus('Added to palette.');
  return true;
}

/* Pull the most plausible URL out of whatever got dropped -- kept for
   the drop zone, which still accepts a link dragged in from anywhere
   the browser allows dragging from (another tab, a selection). */
function extractDroppedUrl(dataTransfer) {
  if (!dataTransfer) return '';
  const uriList = dataTransfer.getData('text/uri-list');
  if (uriList) return uriList.split('\n').find((l) => l && !l.startsWith('#')) || '';
  const plain = dataTransfer.getData('text/plain') || dataTransfer.getData('text');
  if (plain) {
    const m = plain.match(EXTRACT_PATTERNS.url);
    if (m) return m[0];
  }
  const html = dataTransfer.getData('text/html');
  if (html) {
    const m = html.match(/href=["']([^"']+)["']/i) || html.match(/src=["']([^"']+)["']/i);
    if (m) return m[1];
  }
  return '';
}

/* ---- result thumbnails: shown when SearXNG supplied one; otherwise filled
   in by enrichResults() through the local helper (og:image / first photo). ---- */
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

function resultThumbHtml(r) {
  if (r.img) return thumbHtml(r.img, 'ls-thumb');
  return r._thumbPending ? '<div class="ls-thumb ls-thumb-pending" aria-hidden="true"></div>' : '';
}

let lsGen = 0; // bumped on every new search so stale work can't paint into a newer list
const lsAutoThumbsOn = () => $('lsAutoThumbs').checked;

/* Photos are fetched lazily: only for cards that scroll into view, two at a
   time, each with a hard timeout -- instead of hitting the helper for every
   result up-front (that was a big source of lag). */
let lsObserver = null, enrichActive = 0;
const enrichQueue = [];
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

function observeEnrich(cards) {
  if (!lsAutoThumbsOn()) return;
  if (!lsObserver || lsObserver._gen !== lsGen) {
    if (lsObserver) lsObserver.disconnect();
    enrichQueue.length = 0;
    const gen = lsGen;
    lsObserver = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        lsObserver.unobserve(en.target);
        const r = resultAt(+en.target.dataset.ri);
        if (r && r.url && !r.img && !r._enriched && !en.target.hidden) { r._thumbPending = true; enrichQueue.push({ r, gen }); paintThumb(r); }
      });
      pumpEnrich();
    }, { root: $('lsResultsScroll'), rootMargin: '300px' });
    lsObserver._gen = gen;
  }
  cards.forEach((c) => { const r = resultAt(+c.dataset.ri); if (r && r.url && !r.img && !r._enriched) lsObserver.observe(c); });
}
function paintThumb(r) {
  const card = r._ri == null ? null : $('lsPanel').querySelector('.ls-result[data-ri="' + r._ri + '"]');
  const slot = card && card.querySelector('.ls-thumb-slot');
  if (slot) slot.innerHTML = resultThumbHtml(r);
}
function pumpEnrich() {
  while (enrichActive < 2 && enrichQueue.length) {
    const job = enrichQueue.shift();
    if (job.gen !== lsGen) continue;
    enrichActive++;
    (async () => {
      const r = job.r;
      r._enriched = true;
      try {
        if (await probeHelper()) {
          const info = await withTimeout(fetchPageInfo(r.url), 7000);
          if (job.gen === lsGen) {
            r.pageImageCount = (info.images || []).length;
            r.img = info.ogImage || (info.images && info.images[0] && info.images[0].url) || '';
          }
        }
      } catch { /* unreachable / slow page: leave the card as it was */ }
      r._thumbPending = false;
      if (job.gen === lsGen) paintThumb(r);
      enrichActive--;
      pumpEnrich();
    })();
  }
}

/* ---- render real result cards from SearXNG's JSON ---- */
const LS_EXT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

/* ---- grouping + filter ---- */
let lsGroup = 'all', lsFilterText = '', lsShowWeak = false;
const LS_GROUPS = [['accounts', 'Accounts'], ['people', 'People & profiles'], ['docs', 'Documents'], ['images', 'Images'], ['pages', 'Pages']];
function resultGroup(r) {
  if (r._acct) return 'accounts';
  const path = String(r.url || '').split(/[?#]/)[0].toLowerCase();
  if (detectSocialProfile(r.url)) return 'people';
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv|rtf)$/.test(path)) return 'docs';
  if (/\.(jpe?g|png|gif|webp|bmp|svg|avif)$/.test(path)) return 'images';
  return 'pages';
}
function resultVisible(r) {
  if (r._weak && !lsShowWeak) return false;
  if (lsGroup !== 'all' && resultGroup(r) !== lsGroup) return false;
  const q = lsFilterText.trim().toLowerCase();
  return !q || (r.title + ' ' + r.url + ' ' + r.content).toLowerCase().includes(q);
}
function renderGroupBar() {
  const pool = allResults().filter((r) => !r._weak || lsShowWeak);
  const weak = allResults().filter((r) => r._weak).length;
  const counts = { all: pool.length };
  LS_GROUPS.forEach(([k]) => { counts[k] = pool.filter((r) => resultGroup(r) === k).length; });
  $('lsGroups').hidden = !allResults().length;
  $('lsGroupChips').innerHTML = [['all', 'All']].concat(LS_GROUPS).filter(([k]) => k === 'all' || counts[k])
    .map(([k, l]) => '<button type="button" class="ls-tab' + (k === lsGroup ? ' active' : '') + '" data-grp="' + k + '">' + l + ' (' + counts[k] + ')</button>').join('') +
    (weak ? '<button type="button" class="ls-tab ls-weak-toggle" id="lsWeakToggle">' + (lsShowWeak ? 'Hide' : 'Show') + ' ' + weak + ' weaker match' + (weak === 1 ? '' : 'es') + '</button>' : '');
  $('lsGroupChips').querySelectorAll('[data-grp]').forEach((b) => { b.onclick = () => { lsGroup = b.dataset.grp; applyResultFilter(); }; });
  if ($('lsWeakToggle')) $('lsWeakToggle').onclick = () => { lsShowWeak = !lsShowWeak; applyResultFilter(); };
}
function applyResultFilter() {
  $('lsPanel').querySelectorAll('.ls-result').forEach((c) => { const r = resultAt(+c.dataset.ri); c.hidden = !(r && resultVisible(r)); });
  renderGroupBar(); updateBulkBar();
}
$('lsFilter').oninput = (e) => { lsFilterText = e.target.value; applyResultFilter(); };

/* ---- search history (recent queries, offered as suggestions) ---- */
const LS_HISTORY_KEY = 'linktrace.lsHistory';
function lsHistory() { try { return JSON.parse(localStorage.getItem(LS_HISTORY_KEY)) || []; } catch { return []; } }
function rememberQuery(q) {
  try { localStorage.setItem(LS_HISTORY_KEY, JSON.stringify([q, ...lsHistory().filter((x) => x !== q)].slice(0, 15))); } catch {}
  renderHistory();
}
function renderHistory() { $('lsHistory').innerHTML = lsHistory().map((q) => '<option value="' + esc(q) + '">').join(''); }
renderHistory();

/* Archive: save a snapshot at the Internet Archive (user-initiated, contacts archive.org) */
function archiveResult(r) {
  window.open('https://web.archive.org/save/' + r.url, '_blank', 'noopener,noreferrer');
  const t = find(selected);
  if (!t) return showToast('Archive requested \u2014 select an entity to also log it as evidence', null);
  mark();
  t.evidence.push({ id: Date.now(), type: 'Archive snapshot', title: 'Archive of ' + hostOf(r.url), url: 'https://web.archive.org/web/' + r.url,
    notes: 'Snapshot requested for ' + r.url, confidence: 'unverified', date: new Date().toISOString().slice(0, 10) });
  logEvent('Archive requested', r.url);
  saveBoard(); render();
  showToast('Archive requested + logged as evidence', 'Undo', undo);
}

function updateBulkBar() {
  const list = allResults().filter((r) => r.url && resultVisible(r));
  const cnt = list.filter((r) => lsPicked.has(pickKey(r))).length;
  $('lsBulk').hidden = !list.length;
  $('lsPickAll').checked = cnt > 0 && cnt === list.length;
  $('lsPickAll').indeterminate = cnt > 0 && cnt < list.length;
  $('lsBulkCount').textContent = cnt ? cnt + ' selected' : list.length + ' result' + (list.length === 1 ? '' : 's');
  $('lsBulkAdd').disabled = !cnt;
  $('lsBulkAdd').textContent = cnt ? 'Add ' + cnt + ' +' : 'Add selected';
  $('lsBulkClear').hidden = !cnt;
}

const TIER_LABEL = { 3: ['exact', 'The typed phrase appears in the title, link or snippet'], 2: ['all words', 'Every word you typed appears, not as one phrase'], 1: ['partial', 'Only some of your words appear'] };

function cardHtml(r, i) {
  const ents = resultEntities(r);
  r._ri = i;
  const picked = r.url && lsPicked.has(pickKey(r));
  const tl = r._acct ? null : TIER_LABEL[r._tier];
  const acctBadge = r._acct ? '<span class="ls-badge t1" title="Found by ' + esc(ACCOUNT_TOOLS[r._acct.tool].name) + ' \u2014 not verified">' + esc(ACCOUNT_TOOLS[r._acct.tool].name) + ' \u00b7 unverified</span>' : '';
  const nEng = (r.engines || []).length;
  return '<div class="card ls-result' + (picked ? ' picked' : '') + '" data-ri="' + i + '"' + (resultVisible(r) ? '' : ' hidden') + '>' +
    (r.url ? '<label class="ls-pick" title="Select for bulk add"><input type="checkbox" data-pick="' + i + '"' + (picked ? ' checked' : '') + '></label>' : '') +
    '<div class="ls-thumb-slot">' + resultThumbHtml(r) + '</div>' +
    '<div class="ls-result-main">' +
      '<div class="ls-title-row"><span class="title">' + esc(r.title || '(untitled)') + '</span>' +
        (r.url ? '<button class="ls-ext" data-open-link="' + i + '" title="Open in a new tab" aria-label="Open in a new tab">' + LS_EXT_ICON + '</button>' : '') + '</div>' +
      '<div class="ls-domain-row">' + (r.url ? '<span class="ls-domain">' + esc(hostOf(r.url)) + '</span>' : '') +
        (tl ? '<span class="ls-badge t' + r._tier + '" title="' + esc(tl[1]) + '">' + tl[0] + '</span>' : '') +
        acctBadge + (!r._acct && nEng > 1 ? '<span class="ls-badge" title="' + esc(r.engines.join(', ')) + '">' + nEng + ' engines</span>' : '') + '</div>' +
      (r.content ? '<small class="ls-snippet">' + esc(r.content) + '</small>' : '') +
      (r._acct ? '' : '<div class="ls-found">' + entityChipsHtml(ents) + '</div>') +
      '<div class="ls-actions">' +
        (r.url && !r._acct ? '<button data-ls-images="' + i + '" title="Find every image on this page and add them to the selected entity\u2019s palette">Images</button>' : '') +
        (r.url ? '<button data-ls-archive="' + i + '" title="Ask the Internet Archive to save a snapshot of this page (contacts archive.org)">Archive</button>' : '') +
        '<button data-to-palette="' + i + '"' + (find(selected) ? '' : ' disabled title="Select an entity first"') + '>+ evidence</button>' +
        '<span class="grow"></span>' +
        (ents.length ? '<button class="primary ls-add" data-ls-add="' + i + '">Add +</button>' : '') +
      '</div>' +
      '<div class="ls-gal viewer-gallery" data-ls-gal="' + i + '" hidden></div>' +
    '</div>' +
  '</div>';
}

function flashAdded(btn, label) {
  const original = btn.dataset.origLabel || btn.textContent;
  btn.dataset.origLabel = original;
  btn.textContent = label || 'added';
  btn.classList.add('ls-just-added');
  clearTimeout(btn._addedTimer);
  btn._addedTimer = setTimeout(() => { btn.textContent = original; btn.classList.remove('ls-just-added'); }, 1200);
}

function bindCard(card) {
  const q = (sel) => card.querySelector(sel);
  const ri = +card.dataset.ri;
  const add = q('[data-ls-add]');
  if (add) add.onclick = () => {
    const e = primaryEntity(resultAt(ri));
    if (!e) return;
    const target = find(selected);
    addNode(e.type, e.value, target ? target.id : null, null, e.url, () => flashAdded(add, 'Added'), e.meta);
  };
  card.querySelectorAll('[data-add-type]').forEach((btn) => {
    btn.onclick = () => {
      const e = resultEntities(resultAt(ri)).find((x) => x.type === btn.dataset.addType && x.value === btn.dataset.addValue);
      const target = find(selected);
      addNode(btn.dataset.addType, btn.dataset.addValue, target ? target.id : null, null, btn.dataset.addUrl || '', () => flashAdded(btn), e ? e.meta : null);
    };
  });
  const pick = q('[data-pick]');
  if (pick) pick.onchange = () => {
    if (pick.checked) lsPicked.add(pickKey(resultAt(ri))); else lsPicked.delete(pickKey(resultAt(ri)));
    card.classList.toggle('picked', pick.checked);
    updateBulkBar();
  };
  const ext = q('[data-open-link]');
  if (ext) ext.onclick = () => window.open(resultAt(ri).url, '_blank', 'noopener,noreferrer');
  const arch = q('[data-ls-archive]');
  if (arch) arch.onclick = () => archiveResult(resultAt(ri));
  const imgs = q('[data-ls-images]');
  if (imgs) imgs.onclick = () => {
    const gal = q('[data-ls-gal]');
    const open = gal.hidden;
    gal.hidden = !open;
    imgs.classList.toggle('active', open);
    if (open) loadGalleryInto(gal, resultAt(ri).url);
  };
  const pal = q('[data-to-palette]');
  if (pal) pal.onclick = () => { const r = resultAt(ri); if (addUrlToPalette(r.url, r.title, r.content, r.img)) flashAdded(pal); };
  card.querySelectorAll('.ls-chip[draggable]').forEach((chip) => {
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-linktrace-entity', JSON.stringify({ type: chip.dataset.dragType, value: chip.dataset.dragValue }));
      e.dataTransfer.setData('text/plain', chip.dataset.dragValue);
      e.dataTransfer.effectAllowed = 'copy';
    });
  });
}

/* full render (new search) */
function renderLsResults(items) {
  const box = $('lsResults');
  box.innerHTML = (!items.length ? '<small>No results.</small>' : items.map(cardHtml).join('')) + '<div class="ls-loadmore" id="lsLoadMore"></div>';
  const cards = [...box.querySelectorAll('.ls-result')];
  cards.forEach(bindCard);
  renderGroupBar(); updateBulkBar(); observeEnrich(cards);
}

/* "load more": only the NEW cards are built -- the ones already on screen are left alone */
function appendLsResults(from) {
  const box = $('lsResults');
  const old = $('lsLoadMore'); if (old) old.remove();
  const tmp = document.createElement('div');
  tmp.innerHTML = lsResultsData.slice(from).map((r, k) => cardHtml(r, from + k)).join('') + '<div class="ls-loadmore" id="lsLoadMore"></div>';
  const fresh = [...tmp.children];
  fresh.forEach((el) => box.appendChild(el));
  const cards = fresh.filter((el) => el.classList.contains('ls-result'));
  cards.forEach(bindCard);
  renderGroupBar(); updateBulkBar(); observeEnrich(cards);
}

/* bulk bar: select all / add selected / clear */
$('lsPickAll').onchange = () => {
  const on = $('lsPickAll').checked;
  allResults().forEach((r) => { if (r.url && resultVisible(r)) { if (on) lsPicked.add(pickKey(r)); else lsPicked.delete(pickKey(r)); } });
  $('lsPanel').querySelectorAll('.ls-result:not([hidden]) [data-pick]').forEach((cb) => { cb.checked = on; cb.closest('.ls-result').classList.toggle('picked', on); });
  updateBulkBar();
};
$('lsBulkClear').onclick = () => {
  lsPicked.clear();
  $('lsPanel').querySelectorAll('[data-pick]').forEach((cb) => { cb.checked = false; cb.closest('.ls-result').classList.remove('picked'); });
  updateBulkBar();
};
$('lsBulkAdd').onclick = () => {
  const items = allResults().filter((r) => lsPicked.has(pickKey(r))).map(primaryEntity).filter(Boolean);
  if (!items.length) return;
  const target = find(selected);
  addNodesBatch(items, target ? target.id : null, () => { $('lsBulkClear').click(); });
};

/* ---- fetch one page of SearXNG JSON results ----
   Hard 12s timeout, one quick retry on a network blip, and one retry when a
   first page came back empty but some engines were only temporarily failing
   (CAPTCHA / timeout). Returns the engines that did NOT answer too, so the
   panel can say so instead of silently showing fewer results. */
const LS_TIMEOUT = 12000;
const lsCtls = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function abortInflight() { lsCtls.forEach((c) => c.abort()); lsCtls.clear(); }

async function fetchSearxPage(query, engines, pageno) {
  const url = SEARXNG_BASE + '/search?format=json&language=all&safesearch=0&q=' + encodeURIComponent(query) +
    '&pageno=' + pageno + (engines ? '&engines=' + encodeURIComponent(engines) : '');
  const attempt = async () => {
    const ctl = trackFetch(new AbortController());
    lsCtls.add(ctl);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, LS_TIMEOUT);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error('Backend returned ' + res.status);
      return await res.json();
    } catch (e) {
      if (timedOut) throw new Error('The search backend took longer than ' + (LS_TIMEOUT / 1000) + 's');
      throw e;
    } finally { clearTimeout(timer); untrackFetch(ctl); lsCtls.delete(ctl); }
  };
  let data;
  try { data = await attempt(); }
  catch (e) { if (e.name === 'AbortError') throw e; await sleep(500); data = await attempt(); }
  let unresp = (data.unresponsive_engines || []).map((x) => ({ engine: x[0], reason: String(x[1] || '') }));
  if (pageno === 1 && !(data.results || []).length && unresp.length) {
    await sleep(1200);
    try {
      const d2 = await attempt();
      if ((d2.results || []).length) { data = d2; unresp = (d2.unresponsive_engines || []).map((x) => ({ engine: x[0], reason: String(x[1] || '') })); }
    } catch (e) { if (e.name === 'AbortError') throw e; }
  }
  const items = (data.results || []).map((r) => {
    const img = [r.img_src, r.thumbnail_src, r.thumbnail].find((u) => isValidUrl(u)) || '';
    return { title: r.title || '', url: r.url, content: r.content || '', img, engines: r.engines || (r.engine ? [r.engine] : []) };
  }).filter((r) => isValidUrl(r.url));
  return { items, unresp };
}

/* ---- lightweight reachability probe, separate from any particular
   query -- lets the section label show "backend reachable" / "backend
   not running" at a glance, instead of only finding out after a search
   fails partway through. Cheap: no query text, SearXNG answers with an
   empty result set instantly either way. ---- */
let lsBackendReachable = null;
async function checkBackendReachable() {
  const note = $('lsBackendNote');
  try {
    const res = await fetch(SEARXNG_BASE + '/search?format=json&q=ping&pageno=1');
    lsBackendReachable = res.ok;
  } catch {
    lsBackendReachable = false;
  }
  if (note) {
    note.textContent = lsBackendReachable ? 'backend reachable' : 'backend not running \u2014 see osint-vm/README.md';
    note.classList.toggle('backend-up', lsBackendReachable === true);
    note.classList.toggle('backend-down', lsBackendReachable === false);
  }
  return lsBackendReachable;
}

/* ---- result bookkeeping: dedupe (same page from many engines = one card),
   score against what was typed, order best-first ---- */
let lsPq = null, lsSeen = new Map(), lsStrict = true, lsEmptyPages = 0;
const LS_MAX_PAGES = 10;

function ingestResults(raw) {
  const fresh = [];
  raw.forEach((r) => {
    const key = SC.normUrl(r.url);
    const have = lsSeen.get(key);
    if (have) {                                   // same page again: merge, don't duplicate
      have.engines = [...new Set([...(have.engines || []), ...(r.engines || [])])];
      if ((r.content || '').length > (have.content || '').length) have.content = r.content;
      if (!have.img && r.img) have.img = r.img;
      return;
    }
    r._tier = SC.tier(r, lsPq);
    r._weak = lsStrict && r._tier < 2;
    r._order = lsSeen.size;
    lsSeen.set(key, r);
    fresh.push(r);
  });
  fresh.sort((a, b) => (b._tier - a._tier) || ((b.engines || []).length - (a.engines || []).length) || (a._order - b._order));
  return fresh;
}

function showEngineNote(unresp) {
  const el = $('lsEngineNote');
  if (!unresp || !unresp.length) { el.hidden = true; el.textContent = ''; return; }
  const short = (x) => x.engine + (x.reason ? ' (' + x.reason.replace(/^(HTTP error|Suspended:?)\s*/i, '$1 ').toLowerCase().slice(0, 28) + ')' : '');
  el.hidden = false;
  el.innerHTML = 'Not responding: ' + esc(unresp.map(short).join(', ')) + ' \u2014 results come from the other engines. <button type="button" id="lsEngineRetry">Retry</button>';
  $('lsEngineRetry').onclick = runLiveSearch;
}

function strongCount() { return lsResultsData.filter((r) => !r._weak).length; }

/* ---- run the search against the local SearXNG JSON API (page 1) ---- */
async function runLiveSearch() {
  const baseQuery = $('lsQuery').value.trim();
  const advancedOpen = !$('lsAdvanced').hasAttribute('hidden');
  const typed = advancedOpen ? buildAdvancedQuery(baseQuery) : baseQuery;
  if (!typed) return setLsStatus('Type something to search first.');
  const tab = SEARCH_TABS.find((t) => t.id === lsActiveTab) || SEARCH_TABS[0];

  abortInflight();                       // a newer search always wins; older replies can never overwrite it
  const gen = ++lsGen;
  lsStrict = $('lsMatch').value !== 'broad';
  lsPq = SC.parseQuery(typed);
  const sendQ = lsStrict ? SC.quoteFreeWords(typed) : typed;
  const engines = tab.engines || (lsPq.hasOps ? SC.DORK_ENGINES : '');
  lsPageNo = 1; lsExhausted = false; lsLoadingMore = false; lsEmptyPages = 0;
  lsLastQuery = sendQ; lsLastEngines = engines;
  clearToolResults();
  lsResultsData = []; lsSeen = new Map(); lsShowWeak = false;
  lsPicked.clear();
  lsGroup = 'all'; lsFilterText = ''; $('lsFilter').value = '';
  showEngineNote(null);
  updateBulkBar();
  rememberQuery(baseQuery || typed);

  runSmartTools(baseQuery || typed, gen);       // armed lookups for what was typed (e-mail, phone, username, domain, IP)
  setLsStatus('Searching\u2026');
  $('lsResults').innerHTML = '<div class="ls-skeleton"></div><div class="ls-skeleton"></div><div class="ls-skeleton"></div>';
  $('lsGroups').hidden = true; $('lsBulk').hidden = true;

  try {
    let { items, unresp } = await fetchSearxPage(sendQ, engines, 1);
    if (gen !== lsGen) return;
    lsResultsData = ingestResults(items);
    let broadened = false;
    // exact-phrase search found too little: also run the plain query, the scoring keeps the best on top
    if (lsStrict && sendQ !== typed && strongCount() < 5) {
      try {
        const more = await fetchSearxPage(typed, engines, 1);
        if (gen !== lsGen) return;
        unresp = unresp.length ? unresp : more.unresp;
        lsResultsData = lsResultsData.concat(ingestResults(more.items));
        lsLastQuery = typed;
        broadened = true;
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    if (gen !== lsGen) return;
    showEngineNote(unresp);

    const strong = strongCount(), weak = lsResultsData.length - strong;
    if (!lsResultsData.length) {
      setLsStatus('No results from ' + tab.label + ' for \u201c' + typed + '\u201d.' +
        (unresp.length ? ' Some engines didn\u2019t answer \u2014 try Retry.' : (tab.id !== 'all' ? ' Single engines are less reliable than \u201cAll engines\u201d.' : '')));
    } else if (!strong) {
      lsShowWeak = true;                 // nothing matched exactly: show what there is rather than an empty list
      setLsStatus('No result contains everything you typed \u2014 showing ' + weak + ' closest match' + (weak === 1 ? '' : 'es') + '.');
    } else {
      setLsStatus(strong + ' match' + (strong === 1 ? '' : 'es') + ' for \u201c' + typed + '\u201d' + (weak ? ' \u00b7 ' + weak + ' weaker hidden' : '') +
        (broadened ? ' \u00b7 widened beyond the exact phrase' : '') + ' \u00b7 ' + tab.label);
    }
    renderLsResults(lsResultsData);
    fillViewport();
    logEvent('Search', tab.label + ': ' + typed);
  } catch (err) {
    if (err.name === 'AbortError' || gen !== lsGen) return; // superseded by a newer search, or panic clear
    setLsStatus('Couldn\u2019t reach the local search backend.');
    $('lsResults').innerHTML =
      '<p class="hint">The local SearXNG backend isn\u2019t responding at ' + esc(SEARXNG_BASE) + '. ' +
      'If it isn\u2019t running yet, start it from the VM\u2019s <code>osint-vm/</code> folder:</p>' +
      '<pre class="ls-cmd">cd osint-vm &amp;&amp; docker compose up -d</pre>' +
      '<p class="hint">(' + esc(err.message) + ')</p>' +
      '<button id="lsRetry">Retry</button>';
    $('lsRetry').onclick = runLiveSearch;
  }
}

/* ---- next page, appended when the panel is scrolled near the bottom.
   Stops by itself once pages only contain weaker matches (that's where the
   lag and the noise came from), or after LS_MAX_PAGES. ---- */
async function loadMoreResults() {
  if (lsLoadingMore || lsExhausted || !lsLastQuery) return;
  const gen = lsGen;
  lsLoadingMore = true;
  setLoadMoreStatus('Loading more results\u2026');
  try {
    const nextPage = lsPageNo + 1;
    const { items: raw } = await fetchSearxPage(lsLastQuery, lsLastEngines, nextPage);
    if (gen !== lsGen) return;                    // a new search started meanwhile: drop this page
    lsPageNo = nextPage;
    const fresh = ingestResults(raw);
    if (!raw.length || nextPage >= LS_MAX_PAGES) {
      lsExhausted = true;
      setLoadMoreStatus(raw.length ? 'Reached the page limit \u2014 refine the search for more.' : 'No more results.');
    }
    if (fresh.length) {
      const from = lsResultsData.length;
      lsResultsData = lsResultsData.concat(fresh);
      lsEmptyPages = fresh.some((r) => !r._weak) ? 0 : lsEmptyPages + 1;
      appendLsResults(from);
      const strong = strongCount(), weak = lsResultsData.length - strong;
      setLsStatus(strong + ' match' + (strong === 1 ? '' : 'es') + (weak ? ' \u00b7 ' + weak + ' weaker' + (lsShowWeak ? '' : ' hidden') : '') + ' for \u201c' + lsLastQuery + '\u201d');
      if (lsStrict && lsEmptyPages >= 2 && !lsExhausted) {
        lsExhausted = true;
        setLoadMoreStatus('The next pages only had weaker matches \u2014 stopped. Use \u201cShow weaker matches\u201d or refine the search.');
      } else if (!lsExhausted) setLoadMoreStatus('');
    } else if (!lsExhausted) {                 // a page of pure repeats counts as an empty page
      lsEmptyPages++;
      if (lsEmptyPages >= 3) { lsExhausted = true; setLoadMoreStatus('No more new results.'); } else setLoadMoreStatus('');
    }
  } catch (err) {
    if (err.name !== 'AbortError' && gen === lsGen) setLoadMoreStatus('Couldn\u2019t load more \u2014 scroll to retry.');
  } finally {
    if (gen === lsGen) { lsLoadingMore = false; fillViewport(); }
  }
}

/* After a page lands: if the panel is still at the bottom (short list, or the page only
   added hidden/duplicate cards) no scroll event will ever fire -- so ask for the next page. */
function fillViewport() {
  setTimeout(() => {
    const box = $('lsResultsScroll');
    if (box && !lsExhausted && lsResultsData.length && box.scrollTop + box.clientHeight >= box.scrollHeight - 120) loadMoreResults();
  }, 60);
}

function setLsOpen(open) {
  const panel = $('lsPanel');
  panel.toggleAttribute('hidden', !open);
  $('livesearchToggle').setAttribute('aria-expanded', String(open));
  if (open) { renderEngineMenu(); renderLsTarget(); updateSmartBar(); checkBackendReachable(); setTimeout(() => $('lsQuery').focus(), 0); }
}
$('livesearchToggle').onclick = () => setLsOpen($('lsPanel').hasAttribute('hidden'));
$('lsClose').onclick = () => setLsOpen(false);

/* Larger layout for real research sessions; remembered between visits. */
function setLsExpanded(on) {
  $('lsPanel').classList.toggle('xl', on);
  $('lsExpand').setAttribute('aria-pressed', String(on));
  $('lsExpand').title = on ? 'Back to the compact panel' : 'Make the search panel larger';
  try { localStorage.setItem('linktrace.lsExpanded', on ? '1' : '0'); } catch {}
}
$('lsExpand').onclick = () => setLsExpanded(!$('lsPanel').classList.contains('xl'));
try { setLsExpanded(localStorage.getItem('linktrace.lsExpanded') === '1'); } catch {}

try { $('lsAutoThumbs').checked = localStorage.getItem('linktrace.lsThumbs') !== '0'; } catch {}
$('lsAutoThumbs').onchange = () => {
  try { localStorage.setItem('linktrace.lsThumbs', $('lsAutoThumbs').checked ? '1' : '0'); } catch {}
  if ($('lsAutoThumbs').checked && lsResultsData.length) observeEnrich([...$('lsPanel').querySelectorAll('.ls-result')]);
};

/* "/" jumps straight into search from anywhere on the board; Esc closes. */
document.addEventListener('keydown', (e) => {
  const typing = e.target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable);
  if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector('.modal-backdrop')) {
    e.preventDefault(); setLsOpen(true); $('lsQuery').focus();
  } else if (e.key === 'Escape' && !$('lsPanel').hasAttribute('hidden') && !document.querySelector('.modal-backdrop')) {
    if (typing && e.target.id !== 'lsQuery') return;
    setLsOpen(false);
  }
});
$('lsRun').onclick = runLiveSearch;
$('lsQuery').onkeydown = (e) => { if (e.key === 'Enter') runLiveSearch(); };

$('lsResultsScroll').addEventListener('scroll', () => {
  const box = $('lsResultsScroll');
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 120) loadMoreResults();
});
