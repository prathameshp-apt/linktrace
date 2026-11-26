'use strict';
/* ---------------------------------------------------------------------
   9. Evidence modals
   --------------------------------------------------------------------- */
function optionsHtml(values, selectedValue) {
  return values.map((v) => '<option ' + (v === selectedValue ? 'selected' : '') + '>' + esc(v) + '</option>').join('');
}

function showEvidenceModal(n) {
  const kinds = STANDARD_EVIDENCE.concat(customEvidence);
  const back = openModal('Add evidence', 'Attach structured evidence to ' + n.label,
    '<label>Evidence type</label><select id="evType">' + optionsHtml(kinds, kinds[0]) + '</select>' +
    '<label>Title</label><input id="evTitle" placeholder="Short, descriptive title" autocomplete="off">' +
    '<label>Source URL (optional)</label><input id="evUrl" placeholder="https://\u2026" autocomplete="off">' +
    '<label>Summary / excerpt</label><textarea id="evNote" placeholder="What does this evidence show?" autocomplete="off"></textarea>' +
    '<label>Confidence</label><select id="evConfidence">' + optionsHtml(Object.keys(STATUS), 'unverified') + '</select>',
    '<button id="evCancel">Cancel</button><button class="primary" id="evSave">Add evidence</button>');

  back.querySelector('#evCancel').onclick = closeOverlays;
  back.querySelector('#evSave').onclick = () => {
    const title = back.querySelector('#evTitle').value.trim();
    if (!title) return showAlert('Missing title', 'Give the evidence a short title.');
    const url = back.querySelector('#evUrl').value.trim();
    if (url && !isValidUrl(url)) return showAlert('Invalid URL', 'Source URL must start with http:// or https://.');
    mark();
    n.evidence.push({
      id: Date.now(),
      type: back.querySelector('#evType').value,
      title,
      url,
      notes: back.querySelector('#evNote').value.trim(),
      confidence: back.querySelector('#evConfidence').value,
      date: new Date().toISOString().slice(0, 10),
    });
    closeOverlays();
    saveBoard();
    render();
  };
}

function showCustomEvidenceModal() {
  const rows = customEvidence.map((kind, i) =>
    '<div class="card">' + esc(kind) + ' <button data-remove-kind="' + i + '">Remove</button></div>'
  ).join('') || '<small>No custom evidence types yet.</small>';

  const back = openModal('Custom evidence types', 'Add project-specific evidence categories.',
    rows + '<div class="row"><input id="newKind" placeholder="e.g. Court filing" autocomplete="off"><button id="addKind">Add</button></div>',
    '<button class="primary" id="kindDone">Done</button>');

  back.querySelector('#kindDone').onclick = closeOverlays;
  back.querySelector('#addKind').onclick = () => {
    const v = back.querySelector('#newKind').value.trim();
    if (!v) return;
    customEvidence.push(v.slice(0, 60));
    saveCaseData();
    showCustomEvidenceModal();
  };
  back.querySelectorAll('[data-remove-kind]').forEach((btn) => {
    btn.onclick = () => { customEvidence.splice(+btn.dataset.removeKind, 1); saveCaseData(); showCustomEvidenceModal(); };
  });
}

