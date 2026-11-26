'use strict';
/* ---------------------------------------------------------------------
   18. Multi-engine search
   Opens the entity's value on one or more public search engines / lookup
   services in new tabs. This never fetches results itself -- it just
   builds the same URL you'd get typing the value into that site's own
   search box, so it carries no more risk than doing that by hand.
   --------------------------------------------------------------------- */
const ENGINE_SELECTION_KEY = 'linktrace.engineSelection';

function loadEngineSelection() {
  try { return new Set(JSON.parse(localStorage.getItem(ENGINE_SELECTION_KEY)) || []); }
  catch { return new Set(); }
}
function saveEngineSelection(set) {
  localStorage.setItem(ENGINE_SELECTION_KEY, JSON.stringify([...set]));
}

function relevantEngines(type) {
  return ltEngines.filter((e) => !e.forTypes.length || (type && e.forTypes.includes(type)));
}

function runSearch(value, engines) {
  if (!value.trim()) return showAlert('Nothing to search', 'Type or select an entity value first.');
  const q = encodeURIComponent(value.trim());
  engines.forEach((e, i) => {
    // small stagger so browsers are less likely to treat the burst as spam and block it
    setTimeout(() => window.open(e.url.replace('{q}', q), '_blank', 'noopener,noreferrer'), i * 120);
  });
  logEvent('Searched entity across engines', value + ' \u00b7 ' + engines.map((e) => e.name).join(', '));
}

function showSearchModal(value, type) {
  const engines = relevantEngines(type);
  const picked = loadEngineSelection();

  const rows = engines.map((e) =>
    '<label class="engine-row">' +
      '<input type="checkbox" data-engine="' + esc(e.name) + '"' + (picked.size ? (picked.has(e.name) ? ' checked' : '') : ' checked') + '>' +
      '<span class="name">' + esc(e.name) + '</span>' +
      (e.hint ? '<span class="hint">' + esc(e.hint) + '</span>' : '') +
    '</label>'
  ).join('') || '<small>No engines configured for this entity type.</small>';

  const back = openModal('Search across engines', value ? 'Searching for: ' + value : 'Enter a value to search',
    '<div class="engine-list">' + rows + '</div>' +
    '<h3 style="margin-top:16px">Add a custom engine</h3>' +
    '<div class="row"><input id="engName" placeholder="Name" autocomplete="off"><input id="engUrl" placeholder="https://example.com/search?q={q}" autocomplete="off"></div>',
    '<button id="searchManage">Manage list</button><button id="searchCancel">Cancel</button><button class="primary" id="searchGo">Search selected</button>');

  back.querySelector('#searchCancel').onclick = closeOverlays;
  back.querySelector('#searchGo').onclick = () => {
    const chosenNames = [...back.querySelectorAll('[data-engine]')].filter((c) => c.checked).map((c) => c.dataset.engine);
    saveEngineSelection(new Set(chosenNames));
    const chosen = engines.filter((e) => chosenNames.includes(e.name));
    if (!chosen.length) return showAlert('Pick at least one', 'Select one or more engines to search.');
    closeOverlays();
    runSearch(value, chosen);
  };
  back.querySelector('#searchManage').onclick = () => {
    const name = back.querySelector('#engName').value.trim();
    const url = back.querySelector('#engUrl').value.trim();
    if (!name || !url.includes('{q}') || !isValidUrl(url)) {
      return showAlert('Invalid engine', 'Give it a name and a URL containing {q}, starting with http(s)://.');
    }
    ltEngines.push({ name, url, forTypes: [] });
    saveCaseData();
    closeOverlays();
    showSearchModal(value, type);
  };
}

