'use strict';
/* ---------------------------------------------------------------------
   Local helper client (osint-vm/linktrace_helper.py)
   Browsers won't let a page frame most websites or read their HTML, so
   a tiny server on this machine fetches pages for us. Everything here
   degrades gracefully: if the helper isn't running, previews fall back
   to a plain iframe and image extraction says how to start the helper.
   --------------------------------------------------------------------- */
const HELPER_BASE = 'http://127.0.0.1:8899';

let helperUp = null;            // null = unknown, true / false after a probe
let helperProbe = null;
const helperPageCache = new Map(); // url -> Promise<pageInfo>

function probeHelper(force) {
  if (!force && helperProbe) return helperProbe;
  helperProbe = (async () => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(HELPER_BASE + '/api/health', { signal: ctl.signal });
      clearTimeout(t);
      helperUp = res.ok;
    } catch { helperUp = false; }
    return helperUp;
  })();
  return helperProbe;
}

/* URL an <img>/<iframe> should use. The proxy fetches with no Referer,
   which gets past hotlink protection and keeps the investigator's browser
   from touching the target's servers directly. */
function proxiedImg(url) {
  return helperUp ? HELPER_BASE + '/api/img?url=' + encodeURIComponent(url) : url;
}
function snapshotUrl(url) {
  return HELPER_BASE + '/api/render?url=' + encodeURIComponent(url);
}

function fetchPageInfo(url) {
  if (!helperPageCache.has(url)) {
    const p = (async () => {
      const ctl = trackFetch(new AbortController());
      try {
        const res = await fetch(HELPER_BASE + '/api/page?url=' + encodeURIComponent(url), { signal: ctl.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('Helper returned ' + res.status));
        return data;
      } finally { untrackFetch(ctl); }
    })();
    helperPageCache.set(url, p);
    p.catch(() => helperPageCache.delete(url)); // failures aren't cached, so Retry works
  }
  return helperPageCache.get(url);
}

/* ---- add an extracted image to an entity's evidence palette ---- */
function imageEvidence(img, pageInfo, pageUrl) {
  const name = (img.alt || '').trim() || decodeURIComponent((img.url.split(/[?#]/)[0].split('/').pop()) || 'image');
  return {
    id: Date.now() + Math.floor(Math.random() * 1000),
    type: 'Image',
    title: name.slice(0, 120),
    url: img.url,
    image: img.url,
    notes: 'Extracted from ' + (pageInfo && pageInfo.title ? pageInfo.title + ' \u2014 ' : '') + pageUrl,
    confidence: 'unverified',
    date: new Date().toISOString().slice(0, 10),
  };
}

function addImagesToEntity(nodeId, images, pageInfo, pageUrl) {
  const target = find(nodeId);
  if (!target) return 0;
  const have = new Set((target.evidence || []).map((e) => e.image || e.url));
  const fresh = images.filter((i) => !have.has(i.url));
  if (!fresh.length) return 0;
  mark();
  fresh.forEach((i) => target.evidence.push(imageEvidence(i, pageInfo, pageUrl)));
  logEvent('Images added', fresh.length + ' from ' + pageUrl);
  saveBoard(); render();
  return fresh.length;
}

/* ---- gallery markup, shared by the inspector preview and search cards ---- */
function galleryHtml(info, opts) {
  const imgs = (info.images || []);
  if (!imgs.length) return '<div class="gal-empty">No usable images found on this page.</div>';
  const canAdd = !!find(selected);
  return '<div class="gal-head"><b>' + imgs.length + ' image' + (imgs.length === 1 ? '' : 's') + ' found</b>' +
    '<button type="button" class="gal-add-all primary"' + (canAdd ? '' : ' disabled title="Select an entity first"') + '>Add all to palette</button></div>' +
    '<div class="gal-grid">' + imgs.map((im, i) =>
      '<figure class="gal-item" data-gi="' + i + '">' +
        '<img src="' + esc(proxiedImg(im.url)) + '" alt="' + esc(im.alt || '') + '" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest(\'.gal-item\').remove()">' +
        '<figcaption>' +
          '<button type="button" class="gal-add"' + (canAdd ? '' : ' disabled') + ' title="Add this image to the selected entity\u2019s palette">+ palette</button>' +
          '<button type="button" class="gal-photo"' + (canAdd ? '' : ' disabled') + ' title="Use as the entity card photo">photo</button>' +
          '<a href="' + esc(im.url) + '" target="_blank" rel="noopener noreferrer" title="Open original">open</a>' +
        '</figcaption>' +
      '</figure>').join('') + '</div>';
}

function bindGallery(box, info, pageUrl, entityId) {
  const flash = (btn, text) => {
    const o = btn.dataset.o || btn.textContent; btn.dataset.o = o; btn.textContent = text;
    clearTimeout(btn._t); btn._t = setTimeout(() => { btn.textContent = o; }, 1200);
  };
  box.querySelectorAll('.gal-add').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const im = info.images[+btn.closest('.gal-item').dataset.gi];
      const id = entityId || selected;
      flash(btn, addImagesToEntity(id, [im], info, pageUrl) ? 'added' : 'already there');
    };
  });
  box.querySelectorAll('.gal-photo').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const t = find(entityId || selected);
      if (!t) return;
      setNodePhoto(t, info.images[+btn.closest('.gal-item').dataset.gi].url);
    };
  });
  const all = box.querySelector('.gal-add-all');
  if (all) all.onclick = (e) => {
    e.stopPropagation();
    // Only images that actually loaded in the grid (broken ones removed themselves).
    const shown = [...box.querySelectorAll('.gal-item')].map((f) => info.images[+f.dataset.gi]);
    const n = addImagesToEntity(entityId || selected, shown, info, pageUrl);
    flash(all, n ? n + ' added' : 'already there');
  };
}

/* Fills a [data-gallery] container for a page URL (used by the inspector
   preview). Safe to call repeatedly; shows a clear message when the
   helper isn't running instead of failing silently. */
async function loadGalleryInto(box, pageUrl, entityId) {
  box.innerHTML = '<div class="gal-empty">Extracting images\u2026</div>';
  const up = await probeHelper();
  if (!up) {
    box.innerHTML = '<div class="gal-empty">Image extraction needs the local helper. Start it with <code>osint-vm/start.sh</code> ' +
      '(or <code>python3 osint-vm/linktrace_helper.py</code>), then <button type="button" class="gal-retry">retry</button>.</div>';
    box.querySelector('.gal-retry').onclick = () => { probeHelper(true).then(() => loadGalleryInto(box, pageUrl, entityId)); };
    return;
  }
  try {
    const info = await fetchPageInfo(pageUrl);
    box.innerHTML = galleryHtml(info);
    bindGallery(box, info, pageUrl, entityId);
  } catch (err) {
    box.innerHTML = '<div class="gal-empty">Couldn\u2019t read this page (' + esc(err.message) + '). <button type="button" class="gal-retry">Retry</button></div>';
    box.querySelector('.gal-retry').onclick = () => loadGalleryInto(box, pageUrl, entityId);
  }
}

probeHelper();
