'use strict';
/* ---------------------------------------------------------------------
   8. Inspector (right-hand side panel)
   --------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   Inline preview: shows the entity's page / PDF / image right inside its
   panel, like opening it in a browser tab, without leaving the board.
   - images -> <img>;  video -> <video>;  PDF and web pages -> <iframe>.
   - Many sites forbid being framed (X-Frame-Options / CSP). That is a
     rule set by their server and can't be overridden from here, so a
     blank frame means "use Open" -- the note under the frame says so.
   - Frames are sent with no Referer; web pages are also sandboxed (a
     PDF can't be, Chrome's PDF viewer refuses to run in a sandbox).
   --------------------------------------------------------------------- */
function previewKind(url) {
  const path = String(url || '').split(/[?#]/)[0].toLowerCase();
  if (/\.pdf$/.test(path)) return 'pdf';
  if (/\.(jpe?g|png|gif|webp|bmp|svg|avif)$/.test(path)) return 'image';
  if (/\.(mp4|webm|ogg|mov)$/.test(path)) return 'video';
  return 'site';
}
function entityPreviewUrl(n) {
  if (isValidUrl(n.sourceUrl)) return n.sourceUrl;
  if (isValidUrl(n.label)) return n.label;
  return '';
}
function viewerHtml(url, opts) {
  const kind = (opts && opts.kind) || previewKind(url);
  const u = esc(url);
  const body =
    kind === 'image' ? '<img class="viewer-img" src="' + u + '" alt="" referrerpolicy="no-referrer" loading="lazy">' :
    kind === 'video' ? '<video src="' + u + '" controls preload="metadata"></video>' :
    kind === 'pdf'   ? '<iframe src="' + u + '" loading="lazy" referrerpolicy="no-referrer" title="PDF preview"></iframe>' :
                       // src is set in hydrateViewers(): the helper's snapshot when it's running, a plain frame otherwise
                       '<iframe data-site-url="' + u + '" loading="lazy" referrerpolicy="no-referrer" title="Page preview"></iframe>';
  const note = (kind === 'site' || kind === 'pdf')
    ? '<div class="viewer-note">Blank or refused? That server doesn\u2019t allow embedding \u2014 start the local helper, or use Open.</div>' : '';
  const canGallery = kind === 'site';
  return '<div class="viewer" data-viewer-url="' + u + '" data-viewer-kind="' + kind + '">' +
    '<div class="viewer-bar"><span class="viewer-kind">' + (kind === 'site' ? 'Web' : kind) + '</span>' +
      '<span class="viewer-url" title="' + u + '">' + u + '</span>' +
      (canGallery ? '<button type="button" data-viewer-live hidden title="Load the real site instead of the script-free snapshot">Live</button>' : '') +
      (canGallery ? '<button type="button" data-viewer-images title="Find every image on this page">Images</button>' : '') +
      (opts && opts.noExpand ? '' : '<button type="button" data-viewer-expand="' + u + '">Expand</button>') +
      '<a href="' + u + '" target="_blank" rel="noopener noreferrer"><button type="button">Open</button></a>' +
    '</div>' + body + note +
    (canGallery ? '<div class="viewer-gallery" hidden></div>' : '') +
  '</div>';
}

/* Called after any HTML containing viewers is placed in the DOM. Decides
   what each web-page frame shows: the helper's script-free snapshot
   (works on sites that forbid framing) when the helper is running, or the
   original direct frame when it isn't. Also wires Live / Images. */
async function hydrateViewers(root) {
  const viewers = [...root.querySelectorAll('.viewer[data-viewer-kind]')];
  if (!viewers.length) return;
  const up = await probeHelper();
  viewers.forEach((v) => {
    const url = v.dataset.viewerUrl;
    const kind = v.dataset.viewerKind;
    const frame = v.querySelector('iframe[data-site-url]');
    const note = v.querySelector('.viewer-note');
    if (frame && !frame.getAttribute('src')) {
      if (up) {
        frame.setAttribute('sandbox', 'allow-popups');
        frame.src = snapshotUrl(url);
        const live = v.querySelector('[data-viewer-live]');
        if (live) {
          live.hidden = false;
          live.onclick = (e) => {
            e.stopPropagation();
            const isLive = live.classList.toggle('active');
            frame.setAttribute('sandbox', isLive ? 'allow-scripts allow-same-origin allow-popups allow-forms' : 'allow-popups');
            frame.src = isLive ? url : snapshotUrl(url);
            live.textContent = isLive ? 'Snapshot' : 'Live';
            if (note) note.textContent = isLive
              ? 'Live page. Blank or refused? That server forbids embedding \u2014 switch back to Snapshot.'
              : 'Snapshot via the local helper: scripts removed, images proxied. Pages built purely in JavaScript may look sparse.';
          };
        }
        if (note) note.textContent = 'Snapshot via the local helper: scripts removed, images proxied. Pages built purely in JavaScript may look sparse.';
      } else {
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
        frame.src = url;
      }
    }
    const img = v.querySelector('img.viewer-img');
    if (img && !img.dataset.hooked) {
      img.dataset.hooked = '1';
      img.addEventListener('error', () => {
        if (up && !img.dataset.proxied) { img.dataset.proxied = '1'; img.src = proxiedImg(url); }
      });
      // the direct load may already have failed before this ran
      if (up && img.complete && img.naturalWidth === 0) { img.dataset.proxied = '1'; img.src = proxiedImg(url); }
    }
    const imgBtn = v.querySelector('[data-viewer-images]');
    const gal = v.querySelector('.viewer-gallery');
    if (imgBtn && gal) {
      imgBtn.onclick = (e) => {
        e.stopPropagation();
        const open = gal.hidden;
        gal.hidden = !open;
        imgBtn.classList.toggle('active', open);
        if (open && !gal.dataset.loaded) { gal.dataset.loaded = '1'; loadGalleryInto(gal, url, selected); }
      };
    }
  });
}

/* Thumbnails: go through the helper when it's running (no Referer, gets
   past hotlink protection), and fall back to the other route if one fails. */
function thumbHtml(src, cls) {
  const first = proxiedImg(src);
  const alt = first === src ? (helperUp === false ? '' : HELPER_BASE + '/api/img?url=' + encodeURIComponent(src)) : src;
  return '<img class="' + cls + '" src="' + esc(first) + '" data-alt-src="' + esc(alt) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
    'onerror="ltThumbFallback(this)">';
}
function ltThumbFallback(img) {
  const alt = img.dataset.altSrc;
  if (alt && !img.dataset.tried) { img.dataset.tried = '1'; img.src = alt; } else { img.remove(); }
}

/* Image palette: every picture attached to this entity as one grid. */
function paletteImages(n) {
  return (n.evidence || [])
    .map((e, i) => ({ e, i, src: e.image || ((e.type === 'Image' && isValidUrl(e.url)) ? e.url : '') }))
    .filter((x) => x.src);
}
function imagePaletteHtml(n) {
  const imgs = paletteImages(n);
  if (!imgs.length) return '';
  return '<h3>Image palette <span class="pal-count">' + imgs.length + '</span></h3>' +
    '<div class="pal-grid">' + imgs.map((x) =>
      '<button type="button" class="pal-item" data-pal-src="' + esc(x.src) + '" title="' + esc(x.e.title) + '">' +
        thumbHtml(x.src, 'pal-img') + '</button>').join('') + '</div>';
}

function showViewerModal(url, kind) {
  const back = openModal('Preview', url, viewerHtml(url, { noExpand: true, kind }), '<button class="primary" id="vClose">Close</button>');
  back.querySelector('.modal').classList.add('modal-wide');
  back.querySelector('#vClose').onclick = closeOverlays;
  hydrateViewers(back);
}
const evPreviewOpen = new Set(); // evidence ids whose inline preview is expanded (session only)
let entityPreviewOn = localStorage.getItem('linktrace.previewOn') !== '0';

function evidenceCardsHtml(n) {
  return (n.evidence || []).map((e, i) =>
    '<div class="card evidence-item' + (e.url ? ' clickable' : '') + '"' +
      (e.url ? ' data-open-url="' + esc(e.url) + '" title="Click to open ' + esc(e.url) + '"' : '') + '>' +
      (e.image && e.type !== 'Image' ? thumbHtml(e.image, 'ev-thumb') : '') +
      '<b>' + esc(e.title) + '</b><br>' +
      '<span class="evidence-tag">' + esc(e.type) + '</span>' +
      '<span class="evidence-tag">' + esc(e.confidence) + '</span><br>' +
      '<small>' + esc(e.date || '') + '</small> ' +
      (e.url ? '<a href="' + esc(e.url) + '" target="_blank" rel="noopener noreferrer">Open source</a>' : '') +
      (e.url ? ' <button data-ev-preview="' + e.id + '">' + (evPreviewOpen.has(e.id) ? 'Hide preview' : 'Preview') + '</button>' : '') +
      ' <button data-evidence="' + i + '">Remove</button>' +
      (e.url && evPreviewOpen.has(e.id) ? viewerHtml(e.url) : '') +
    '</div>'
  ).join('') || '<small>No evidence attached yet.</small>';
}

function relationCardsHtml(n) {
  return rels(n.id).map((l) => {
    const other = find(l.a === n.id ? l.b : l.a);
    if (!other) return '';
    return '<div class="card"><b>' + esc(other.label) + '</b><br>' +
      '<small>' + esc(l.label) + ' \u00b7 ' + esc(l.confidence) + '</small> ' +
      '<button data-link="' + l.id + '">Remove</button></div>';
  }).join('') || '<small>No relationships yet.</small>';
}

/* Linked findings: the entity this one hangs under (if any) and the
   findings hanging under it. Each can be detached (kept on the board,
   just unlinked) or deleted on its own -- removing one finding never
   touches the others. */
function findingsHtml(n) {
  const parent = find(n.parentId);
  const kids = childrenOf(n.id);
  let html = '';
  if (parent) {
    html += '<div class="card"><small>Linked under</small><br><b>' + esc(parent.label) + '</b>' +
      '<div class="btns" style="margin-top:6px"><button data-detach-self="' + n.id + '">Detach from this entity</button></div></div>';
  }
  html += kids.map((c) =>
    '<div class="card"><b>' + esc(c.label) + '</b><br><small>' + esc(typeLabel(c.type)) + '</small>' +
      '<div class="btns" style="margin-top:6px;display:flex;gap:6px">' +
        '<button data-detach="' + c.id + '" title="Keep it on the board, just unlink it from this entity">Remove from entity</button>' +
        '<button class="danger" data-delchild="' + c.id + '">Delete</button>' +
      '</div></div>'
  ).join('');
  return html || '<small>No linked findings.</small>';
}

/* Quick research pivots: same tool config that powers the "Lookup
   tools" panel (config.js: DEFAULT_ENGINES / LOOKUP_CATEGORIES /
   BREACH_CHECK_TOOLS), filtered to whatever's relevant for this
   entity's type and pre-filled with its value -- one click, no
   re-typing the value into the lookup panel or picking a category by
   hand. A tool with an empty forTypes list is general-purpose (search
   engines, maps) and always shown; everything else only shows up when
   its forTypes includes this entity's type. */
function pivotTools(n) {
  const t = n.type;
  const all = [
    ...DEFAULT_ENGINES,
    ...LOOKUP_CATEGORIES.flatMap((c) => c.tools),
    ...BREACH_CHECK_TOOLS,
  ];
  const seen = new Set();
  return all.filter((tool) => {
    if (tool.forTypes.length && !tool.forTypes.includes(t)) return false;
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

function pivotToolsHtml(n) {
  return pivotTools(n).map((tool, i) =>
    '<button type="button" class="tool" data-pivot="' + i + '">' + esc(tool.name) + '</button>'
  ).join('');
}

function renderInspector(n) {
  const evidenceKinds = STANDARD_EVIDENCE.concat(customEvidence);

  side.innerHTML =
    '<div class="sidebar-title"><div><div class="kind"><img class="icon" src="' + typeIconSrc(n.type, n.label) + '" alt="" ' +
      'onerror="this.onerror=null;this.src=\'icons/generic.svg\'"> ' + esc(typeLabel(n.type)) + '</div>' +
      '<h2>' + esc(n.label) + '</h2>' +
      (n.sourceUrl
        ? '<a class="node-source-url" href="' + esc(n.sourceUrl) + '" target="_blank" rel="noopener noreferrer" title="Open the actual profile/page">' +
            esc(n.sourceUrl) + '</a>'
        : (n.type === 'username'
            ? '<button id="addSourceUrl" class="node-source-add">+ add profile URL</button>'
            : '')) +
      '</div>' +
      '<button id="closeInspector" aria-label="Close inspector">&times;</button></div>' +

    (entityPreviewUrl(n)
      ? '<h3>Preview <button id="togglePreview" style="float:right;padding:0 7px;font-size:10.5px">' + (entityPreviewOn ? 'Hide' : 'Show') + '</button></h3>' +
        (entityPreviewOn ? viewerHtml(entityPreviewUrl(n)) : '')
      : '') +

    '<h3>Assessment</h3>' +
    '<div class="row">' +
      '<select id="conf" aria-label="Confidence">' +
        Object.keys(STATUS).map((s) => '<option ' + (s === n.confidence ? 'selected' : '') + '>' + s + '</option>').join('') +
      '</select>' +
      '<input id="tags" value="' + esc(n.tags.join(', ')) + '" placeholder="tags, comma separated" autocomplete="off">' +
    '</div>' +

    '<h3>Card photo</h3>' +
    (n.image ? '<div class="photo-prev">' + photoImgHtml(n.image, 'photo-prev-img') + '</div>' : '') +
    '<div class="row photo-btns">' +
      '<button id="photoFetch" title="Pull the photo and details from this entity\u2019s link (needs the local helper)">From link</button>' +
      '<button id="photoUpload">Upload\u2026</button>' +
      '<button id="photoUrl">Image URL\u2026</button>' +
      (n.image ? '<button id="photoClear">Remove</button>' : '') +
    '</div>' +
    '<input type="file" id="photoFile" accept="image/*" hidden>' +
    '<small>You can also drop an image file on the card, or paste one (Ctrl+V) while it is selected.</small>' +

    '<h3>Card properties</h3>' +
    '<div class="props-edit">' + (n.props || []).map((pr, i) =>
      '<div class="row prop-row"><input data-pk="' + i + '" value="' + esc(pr.k) + '" placeholder="name" autocomplete="off">' +
      '<input data-pv="' + i + '" value="' + esc(pr.v) + '" placeholder="value" autocomplete="off">' +
      '<button data-prm="' + i + '" class="prop-x" aria-label="Remove property">&times;</button></div>').join('') + '</div>' +
    '<button id="propAdd">+ Add property</button>' +

    imagePaletteHtml(n) +

    '<h3>Evidence</h3>' +
    '<div class="row"><button class="primary" id="addEvidence">Add evidence</button><button id="manageEvidenceTypes">Custom types</button></div>' +
    evidenceCardsHtml(n) +

    '<h3>Notes</h3><textarea id="notes" aria-label="Notes" autocomplete="off">' + esc(n.notes) + '</textarea>' +

    '<h3>Relationships</h3>' + relationCardsHtml(n) +
    '<button id="connect">Connect entity</button>' +

    '<h3>Linked findings</h3>' + findingsHtml(n) +

    '<h3>Quick research pivots</h3><div class="tools">' + pivotToolsHtml(n) + '</div>' +
    '<div class="row" style="margin-top:8px"><button id="searchAllEngines">Search across engines\u2026</button></div>' +

    '<h3>Add linked finding</h3>' +
    '<div class="row">' +
      '<input id="childtype" list="typeList" placeholder="Type (optional)" aria-label="New finding type" autocomplete="off">' +
      '<input id="child" placeholder="Value" autocomplete="off">' +
    '</div>' +
    '<button id="childadd">Add finding</button>' +

    '<h3>Actions</h3><button class="danger" id="del">Delete entity</button>';

  $('closeInspector').onclick = () => { selected = null; render(); };
  if ($('addSourceUrl')) {
    $('addSourceUrl').onclick = () => {
      showPrompt('Profile URL', 'Paste the actual link to this profile/page', 'https://', (url) => {
        const v = url.trim();
        if (!v) return;
        mark(); n.sourceUrl = v; saveBoard(); render();
      });
    };
  }
  $('conf').onchange = (e) => { mark(); n.confidence = e.target.value; saveBoard(); render(); };
  $('tags').onchange = (e) => { mark(); n.tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 15); saveBoard(); render(); };
  $('notes').onchange = (e) => { mark(); n.notes = e.target.value; saveBoard(); };

  $('photoFetch').onclick = () => {
    if (!entityPreviewUrl(n)) return showAlert('No link', 'This entity has no web link to read a photo from. Upload one or paste an image URL instead.');
    probeHelper(true).then((up) => {
      if (!up) return showAlert('Helper not running', 'Reading a page\u2019s photo needs the local helper (osint-vm/start.sh). You can still upload an image or paste an image URL.');
      mark(); attachPageInfo(n.id, true);
    });
  };
  $('photoUpload').onclick = () => $('photoFile').click();
  $('photoFile').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    fileToPhotoData(f).then((d) => setNodePhoto(n, d)).catch((err) => showAlert('Couldn\u2019t use that image', err.message));
  };
  $('photoUrl').onclick = () => showPrompt('Image URL', 'Direct link to the picture', 'https://', (u) => {
    if (!isValidUrl(u)) return showAlert('Invalid URL', 'The link must start with http:// or https://.');
    setNodePhoto(n, u);
  });
  if ($('photoClear')) $('photoClear').onclick = () => setNodePhoto(n, '');
  const saveProps = () => { saveBoard(); render(); if (autoLayoutOn) { relayoutFor(n.id); saveBoard(); render(); } };
  side.querySelectorAll('[data-pk],[data-pv]').forEach((inp) => {
    inp.onchange = () => {
      const i = +(inp.dataset.pk ?? inp.dataset.pv);
      mark(); n.props[i][inp.dataset.pk !== undefined ? 'k' : 'v'] = inp.value.trim();
      n.props = sanitizeProps(n.props); saveProps();
    };
  });
  side.querySelectorAll('[data-prm]').forEach((btn) => {
    btn.onclick = () => { mark(); n.props.splice(+btn.dataset.prm, 1); saveProps(); };
  });
  $('propAdd').onclick = () => {
    const back = openModal('Add property', 'Shown in the table on the entity card.',
      '<label>Name</label><input id="pName" placeholder="e.g. Employer" autocomplete="off"><label>Value</label><input id="pVal" autocomplete="off">',
      '<button id="pCancel">Cancel</button><button class="primary" id="pOk">Add</button>');
    back.querySelector('#pCancel').onclick = closeOverlays;
    const ok = () => {
      const k = back.querySelector('#pName').value.trim(), v = back.querySelector('#pVal').value.trim();
      if (!k || !v) return;
      closeOverlays(); mark(); n.props = sanitizeProps([...(n.props || []), { k, v }]); saveProps();
    };
    back.querySelector('#pOk').onclick = ok;
    back.querySelector('#pVal').addEventListener('keydown', (e) => e.key === 'Enter' && ok());
  };

  $('addEvidence').onclick = () => showEvidenceModal(n);
  $('manageEvidenceTypes').onclick = showCustomEvidenceModal;

  side.querySelectorAll('[data-evidence]').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); mark(); n.evidence.splice(+btn.dataset.evidence, 1); saveBoard(); render(); };
  });
  side.querySelectorAll('[data-open-url]').forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest('a') || e.target.closest('button') || e.target.closest('.viewer')) return; // let those handle themselves
      window.open(card.dataset.openUrl, '_blank', 'noopener,noreferrer');
    };
  });
  side.querySelectorAll('[data-link]').forEach((btn) => {
    btn.onclick = () => { mark(); links = links.filter((l) => l.id !== +btn.dataset.link); saveBoard(); render(); };
  });
  side.querySelectorAll('[data-detach]').forEach((btn) => {
    btn.onclick = () => detachNode(+btn.dataset.detach);
  });
  side.querySelectorAll('[data-detach-self]').forEach((btn) => {
    btn.onclick = () => detachNode(+btn.dataset.detachSelf);
  });
  side.querySelectorAll('[data-delchild]').forEach((btn) => {
    btn.onclick = () => removeNode(+btn.dataset.delchild);
  });
  if ($('togglePreview')) {
    $('togglePreview').onclick = () => {
      entityPreviewOn = !entityPreviewOn;
      localStorage.setItem('linktrace.previewOn', entityPreviewOn ? '1' : '0');
      renderInspector(n);
    };
  }
  side.querySelectorAll('[data-ev-preview]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = +btn.dataset.evPreview;
      if (evPreviewOpen.has(id)) evPreviewOpen.delete(id); else evPreviewOpen.add(id);
      renderInspector(n);
    };
  });
  side.querySelectorAll('[data-viewer-expand]').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); showViewerModal(btn.dataset.viewerExpand); };
  });
  side.querySelectorAll('[data-pal-src]').forEach((btn) => {
    btn.onclick = () => showViewerModal(btn.dataset.palSrc, 'image');
  });
  hydrateViewers(side);
  const pivots = pivotTools(n);
  side.querySelectorAll('[data-pivot]').forEach((btn) => {
    btn.onclick = () => {
      const tool = pivots[+btn.dataset.pivot];
      const q = encodeURIComponent(n.label);
      window.open(tool.url.replace('{q}', q), '_blank', 'noopener,noreferrer');
      logEvent('Lookup tool', tool.name + ': ' + n.label);
    };
  });

  $('searchAllEngines').onclick = () => showSearchModal(n.label, n.type);
  $('connect').onclick = () => { linkFrom = n.id; $('banner').classList.add('on'); };
  $('childadd').onclick = () => addNode(resolveType($('childtype').value, $('child').value), $('child').value, n.id);
  $('del').onclick = () => removeNode(n.id);
}

