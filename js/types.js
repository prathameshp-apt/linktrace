'use strict';
/* ---------------------------------------------------------------------
   Entity types: picker + "Add Custom Entity" wizard
   Dock button opens a searchable list (Recent / Custom / Default). A
   custom type is defined once (kind, example, optional validation
   pattern, name, description) and then behaves like any built-in type:
   it appears here, in the type suggestions, and validates its values.
   --------------------------------------------------------------------- */
const CUSTOM_TYPES_KEY = 'linktrace.customTypes';
const RECENT_TYPES_KEY = 'linktrace.recentTypes';
const CUSTOM_KINDS = {            // kind -> icon slug in /icons
  String: 'entity', URL: 'url', Image: 'image', File: 'document', Phone: 'phone', Email: 'email',
  Location: 'generic', Timestamp: 'generic', Boolean: 'generic', Object: 'generic', List: 'generic',
};
let ltCustomTypes = [];
let ltRecentTypes = [];
try { ltCustomTypes = JSON.parse(localStorage.getItem(CUSTOM_TYPES_KEY)) || []; } catch {}
try { ltRecentTypes = JSON.parse(localStorage.getItem(RECENT_TYPES_KEY)) || []; } catch {}

function saveCustomTypes() { try { localStorage.setItem(CUSTOM_TYPES_KEY, JSON.stringify(ltCustomTypes)); } catch {} }
function customTypeOf(type) {
  const t = String(type || '').trim().toLowerCase();
  return ltCustomTypes.find((c) => c.name.toLowerCase() === t) || null;
}
function customTypeIcon(type) {
  const c = customTypeOf(type);
  return c ? 'icons/' + (CUSTOM_KINDS[c.kind] || 'generic') + '.svg' : '';
}
function refreshTypeList() {
  $('typeList').innerHTML = Object.values(TYPES).map((v) => v[0])
    .concat(TYPE_SUGGESTIONS, ltCustomTypes.map((c) => c.name))
    .map((label) => '<option value="' + esc(label) + '">').join('');
}

/* every selectable type as {key,label,icon,example,desc,custom} */
function allTypeEntries() {
  const def = Object.entries(TYPES).map(([key, v]) => ({ key, label: v[0], icon: typeIconSrc(key), example: '', desc: '', custom: false }))
    .concat(TYPE_SUGGESTIONS.map((l) => ({ key: l, label: l, icon: typeIconSrc(l), example: '', desc: '', custom: false })));
  const cus = ltCustomTypes.map((c) => ({ key: c.name, label: c.name, icon: customTypeIcon(c.name), example: c.example, desc: c.desc, custom: true }));
  return { def, cus };
}

function askEntityValue(t) {
  const back = openModal('Add ' + t.label, t.desc || (t.example ? 'Example: ' + t.example : 'Enter the value.'),
    '<label>Value</label><input id="etVal" placeholder="' + esc(t.example || 'value') + '" autocomplete="off">',
    '<button id="etCancel">Cancel</button><button class="primary" id="etOk">Add</button>');
  const ok = () => {
    const v = back.querySelector('#etVal').value.trim();
    if (!v) return;
    closeOverlays();
    const target = find(selected);
    addNode(t.key, v, target ? target.id : null);
    ltRecentTypes = [t.key, ...ltRecentTypes.filter((k) => k !== t.key)].slice(0, 5);
    try { localStorage.setItem(RECENT_TYPES_KEY, JSON.stringify(ltRecentTypes)); } catch {}
  };
  back.querySelector('#etCancel').onclick = closeOverlays;
  back.querySelector('#etOk').onclick = ok;
  back.querySelector('#etVal').addEventListener('keydown', (e) => e.key === 'Enter' && ok());
}

function showTypePicker() {
  const { def, cus } = allTypeEntries();
  const all = cus.concat(def);
  const recent = ltRecentTypes.map((k) => all.find((t) => t.key === k)).filter(Boolean);
  const row = (t) => '<button type="button" class="type-row" data-tk="' + esc(t.key) + '"><img class="icon" src="' + esc(t.icon) + '" alt="" onerror="this.onerror=null;this.src=\'icons/generic.svg\'"><span>' + esc(t.label) + '</span></button>';
  const sec = (title, list) => list.length ? '<div class="type-sec">' + title + '</div>' + list.map(row).join('') : '';
  const back = openModal('Add entity', 'Pick a type, then enter its value' + (find(selected) ? ' \u2014 it will link under \u201c' + find(selected).label + '\u201d.' : '.'),
    '<input id="typeFilter" placeholder="Search entity types" autocomplete="off"><div class="type-list" id="typeList2">' +
    sec('Recent', recent) + sec('Custom', cus) + sec('Default', def) + '</div>',
    '<button id="typeCancel">Close</button><button class="primary" id="typeNew">+ Add Custom Entity</button>');
  back.querySelector('#typeCancel').onclick = closeOverlays;
  back.querySelector('#typeNew').onclick = () => showCustomEntityWizard();
  back.querySelector('#typeFilter').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    back.querySelectorAll('.type-row').forEach((b) => { b.hidden = !!q && !b.textContent.toLowerCase().includes(q); });
  };
  back.querySelectorAll('.type-row').forEach((b) => {
    b.onclick = () => askEntityValue(all.find((t) => t.key === b.dataset.tk));
  });
}

/* 2-step wizard, like the "Add Custom Entity" flow in the reference video */
function showCustomEntityWizard(draft) {
  const d = Object.assign({ kind: 'String', example: '', pattern: '', name: '', desc: '' }, draft || {});
  const previewCard = (name, example, kind) =>
    '<div class="wiz-preview"><div class="wiz-card"><span class="node-icon"><img class="icon" src="icons/' + (CUSTOM_KINDS[kind] || 'generic') + '.svg" alt=""></span>' +
    '<div><div class="kind">' + esc(name || 'Entity name') + '</div><div class="label">' + esc(example || 'example') + '</div></div></div></div>';

  const step1 = () => {
    const back = openModal('Add Custom Entity', 'First, provide entity properties.',
      previewCard(d.name, d.example, d.kind) +
      '<label>Entity type</label><select id="wKind">' + Object.keys(CUSTOM_KINDS).map((k) => '<option' + (k === d.kind ? ' selected' : '') + '>' + k + '</option>').join('') + '</select>' +
      '<label>Example</label><input id="wExample" value="' + esc(d.example) + '" placeholder="Enter an example" autocomplete="off">' +
      '<label>Data validation (optional)</label><input id="wPattern" value="' + esc(d.pattern) + '" placeholder="Enter a RegEx pattern" autocomplete="off"><div class="opsec-err" id="wErr"></div>',
      '<button id="wCancel">Cancel</button><button class="primary" id="wNext">Next</button>');
    back.querySelector('#wCancel').onclick = closeOverlays;
    back.querySelector('#wNext').onclick = () => {
      d.kind = back.querySelector('#wKind').value;
      d.example = back.querySelector('#wExample').value.trim();
      d.pattern = back.querySelector('#wPattern').value.trim();
      if (d.pattern) {
        try { new RegExp(d.pattern); } catch { back.querySelector('#wErr').textContent = 'That is not a valid regular expression.'; return; }
        if (d.example && !new RegExp(d.pattern).test(d.example)) { back.querySelector('#wErr').textContent = 'The example does not match the pattern.'; return; }
      }
      step2();
    };
  };
  const step2 = () => {
    const back = openModal('Add Custom Entity', 'Now, give your entity a name.',
      previewCard(d.name, d.example, d.kind) +
      '<label>Name</label><input id="wName" value="' + esc(d.name) + '" placeholder="e.g. Incorporation Document" autocomplete="off">' +
      '<label>Description (optional)</label><textarea id="wDesc" placeholder="Enter a description">' + esc(d.desc) + '</textarea><div class="opsec-err" id="wErr"></div>',
      '<button id="wBack">Back</button><button class="primary" id="wAdd">Add Custom Entity</button>');
    back.querySelector('#wBack').onclick = () => { d.name = back.querySelector('#wName').value.trim(); d.desc = back.querySelector('#wDesc').value.trim(); step1(); };
    back.querySelector('#wAdd').onclick = () => {
      const name = back.querySelector('#wName').value.trim().slice(0, 60);
      if (!name) { back.querySelector('#wErr').textContent = 'Give the entity a name.'; return; }
      const clash = Object.entries(TYPES).some(([k, v]) => k === name.toLowerCase() || v[0].toLowerCase() === name.toLowerCase()) || customTypeOf(name);
      if (clash) { back.querySelector('#wErr').textContent = 'A type with that name already exists.'; return; }
      ltCustomTypes.push({ name, kind: d.kind, example: d.example, pattern: d.pattern, desc: back.querySelector('#wDesc').value.trim().slice(0, 300) });
      saveCustomTypes(); refreshTypeList();
      closeOverlays();
      showToast('Custom entity created', 'Use it', () => askEntityValue({ key: name, label: name, example: d.example, desc: d.desc }));
    };
  };
  step1();
}

$('typesBtn').onclick = showTypePicker;
refreshTypeList();
