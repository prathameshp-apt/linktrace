'use strict';
/* ---------------------------------------------------------------------
   15. Workspaces (multiple cases, each fully separate: own board, case
   metadata, timeline, tasks, engine list, custom evidence types) plus
   the single active case's workspace panel (name/description, research
   queue, activity log).

   How switching works: every existing save/load function (persistence.js)
   is untouched -- it still reads and writes the same handful of plain
   localStorage keys (STORE_KEY, CASE_KEY, ...) it always has, listed
   together as WORKSPACE_DATA_KEYS (config.js). A workspace is just a
   named snapshot of those keys. Switching = serialize the live keys into
   the outgoing workspace's slot, deserialize the incoming workspace's
   slot back into those same live keys, then run the exact load path
   boot.js runs on startup (loadEverything + render). Nothing downstream
   of that point knows workspaces exist.
   --------------------------------------------------------------------- */
function formatTime(iso) { return new Date(iso).toLocaleString(); }

/* ---- Registry ---- */
function loadWorkspaceRegistry() {
  try { return JSON.parse(localStorage.getItem(WORKSPACES_KEY)) || []; } catch { return []; }
}
function saveWorkspaceRegistry(list) {
  localStorage.setItem(WORKSPACES_KEY, JSON.stringify(list));
}
function activeWorkspaceId() { return localStorage.getItem(ACTIVE_WORKSPACE_KEY); }

/* ---- Snapshot / restore: the only two functions that touch the raw
   per-workspace storage slot (WORKSPACE_PREFIX + id). Everything else
   in the app keeps using the live keys as if there were only ever one
   case, exactly as before. ---- */
function snapshotLiveKeysInto(id) {
  const snap = {};
  WORKSPACE_DATA_KEYS.forEach((k) => { snap[k] = localStorage.getItem(k); });
  localStorage.setItem(WORKSPACE_PREFIX + id, JSON.stringify(snap));
}
function restoreLiveKeysFrom(id) {
  let snap = {};
  try { snap = JSON.parse(localStorage.getItem(WORKSPACE_PREFIX + id)) || {}; } catch {}
  WORKSPACE_DATA_KEYS.forEach((k) => {
    if (snap[k] == null) localStorage.removeItem(k);
    else localStorage.setItem(k, snap[k]);
  });
}

/* Called once, the very first time this browser has any board data but
   no workspace registry yet -- folds the existing single case into a
   registry of one, so nobody's current work disappears when this ships. */
function ensureWorkspaceRegistry() {
  let list = loadWorkspaceRegistry();
  if (list.length && activeWorkspaceId()) return;
  const id = 'ws_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const name = (() => { try { return (JSON.parse(localStorage.getItem(CASE_KEY)) || {}).name; } catch { return null; } })() || 'Untitled case';
  snapshotLiveKeysInto(id);
  list = [{ id, name, createdAt: new Date().toISOString() }];
  saveWorkspaceRegistry(list);
  localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
}

/* Switches the live app over to a different workspace: seals the
   outgoing one's data into its slot, loads the incoming one's data into
   the live keys, then re-runs the normal startup load path. If the
   OPSEC vault is on, reseals right after so the new live data doesn't
   sit in plaintext any longer than a normal save would leave it. */
async function switchWorkspace(id) {
  if (id === activeWorkspaceId()) return;
  const outgoing = activeWorkspaceId();
  if (outgoing) snapshotLiveKeysInto(outgoing);
  restoreLiveKeysFrom(id);
  localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
  if (typeof vaultCryptoKey !== 'undefined' && vaultCryptoKey) await sealVault();

  loadEverything();
  selected = null;
  hist = []; future = [];
  logEvent('Switched workspace', ltCase.name);
  renderCaseButton();
  render();
  closeOverlays();
}

function createWorkspace(name) {
  const outgoing = activeWorkspaceId();
  if (outgoing) snapshotLiveKeysInto(outgoing);

  const id = 'ws_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // Blank live keys so the new workspace starts empty, not as a copy of whatever was live.
  WORKSPACE_DATA_KEYS.forEach((k) => localStorage.removeItem(k));
  ltCase = { name, description: '' };
  ltTimeline = []; ltTasks = []; ltEngines = DEFAULT_ENGINES.slice(); customEvidence = [];
  nodes = []; links = []; nextId = 1; nextLink = 1;
  saveBoard(); saveCaseData();
  snapshotLiveKeysInto(id);

  const list = loadWorkspaceRegistry();
  list.push({ id, name, createdAt: new Date().toISOString() });
  saveWorkspaceRegistry(list);
  localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);

  selected = null; multi.clear(); hist = []; future = [];
  logEvent('Created workspace', name);
  renderCaseButton();
  render();
  closeOverlays();
}

function renameWorkspace(id, name) {
  const list = loadWorkspaceRegistry();
  const entry = list.find((w) => w.id === id);
  if (!entry) return;
  entry.name = name;
  saveWorkspaceRegistry(list);
  if (id === activeWorkspaceId()) {
    ltCase.name = name;
    saveCaseData();
    renderCaseButton();
  }
}

function deleteWorkspace(id) {
  const list = loadWorkspaceRegistry();
  if (list.length <= 1) return; // never delete the last workspace
  const remaining = list.filter((w) => w.id !== id);
  saveWorkspaceRegistry(remaining);
  localStorage.removeItem(WORKSPACE_PREFIX + id);
  if (id === activeWorkspaceId()) {
    switchWorkspace(remaining[0].id);
  } else {
    showWorkspaceSwitcher();
  }
}

/* ---- Switcher UI ---- */
function showWorkspaceSwitcher() {
  const list = loadWorkspaceRegistry();
  const activeId = activeWorkspaceId();
  const rows = list.map((w) =>
    '<div class="card workspace-row' + (w.id === activeId ? ' workspace-row-active' : '') + '">' +
      '<div class="workspace-row-main" data-switch="' + esc(w.id) + '">' +
        '<b>' + esc(w.name) + '</b>' + (w.id === activeId ? ' <small>(current)</small>' : '') + '<br>' +
        '<small>Created ' + formatTime(w.createdAt) + '</small>' +
      '</div>' +
      '<div class="workspace-row-actions">' +
        '<button data-rename="' + esc(w.id) + '">Rename</button>' +
        (list.length > 1 ? '<button class="danger" data-delete="' + esc(w.id) + '">Delete</button>' : '') +
      '</div>' +
    '</div>'
  ).join('');

  const back = openModal('Workspaces', 'Each workspace is a fully separate case \u2014 its own board, evidence and timeline.',
    rows +
    '<div class="row" style="margin-top:14px"><input id="newWsName" placeholder="New workspace name" autocomplete="off"><button class="primary" id="newWsAdd">Create</button></div>',
    '<button id="wsClose">Close</button>');

  back.querySelectorAll('[data-switch]').forEach((el) => {
    el.onclick = () => switchWorkspace(el.dataset.switch);
  });
  back.querySelectorAll('[data-rename]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.rename;
      const current = list.find((w) => w.id === id);
      showPrompt('Rename workspace', 'Workspace name', current?.name, (name) => {
        renameWorkspace(id, name);
        showWorkspaceSwitcher();
      });
    };
  });
  back.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.delete;
      const current = list.find((w) => w.id === id);
      showConfirm('Delete workspace', 'This permanently deletes "' + (current?.name || 'this workspace') + '" \u2014 its board, evidence and activity log. This can\u2019t be undone.', () => {
        deleteWorkspace(id);
      }, 'Delete workspace', true);
    };
  });
  back.querySelector('#wsClose').onclick = closeOverlays;
  back.querySelector('#newWsAdd').onclick = () => {
    const name = back.querySelector('#newWsName').value.trim();
    if (!name) return;
    createWorkspace(name);
  };
  back.querySelector('#newWsName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') back.querySelector('#newWsAdd').click();
  });
}

/* ---- Single-case details (name/description, research queue, activity) ---- */
function showCaseWorkspace() {
  const taskRows = ltTasks.map((t, i) =>
    '<div class="card"><b>' + esc(t.title) + '</b><br><small>' + esc(t.status) + ' \u00b7 ' + esc(t.entity || 'case-level') + '</small> ' +
    (t.status !== 'Completed' ? '<button data-task="' + i + '">Done</button>' : '') + '</div>'
  ).join('') || '<small>Your research queue is clear.</small>';

  const timeRows = ltTimeline.slice(0, 20).map((x) =>
    '<div class="card"><b>' + esc(x.action) + '</b><br><small>' + esc(x.detail) + ' \u00b7 ' + formatTime(x.at) + '</small></div>'
  ).join('') || '<small>Activity will appear here as you work.</small>';

  const back = openModal('Case details', 'Manage this case\u2019s name, queue and investigation activity.',
    '<label>Case name</label><input id="caseName" value="' + esc(ltCase.name) + '" autocomplete="off">' +
    '<label>Case description</label><textarea id="caseDescription" autocomplete="off">' + esc(ltCase.description || '') + '</textarea>' +
    '<h3>Research queue</h3>' + taskRows +
    '<div class="row"><input id="taskTitle" placeholder="New research task" autocomplete="off"><button id="taskAdd">Add</button></div>' +
    '<div class="sidebar-title" style="margin-top:18px"><h3 style="margin:0">Recent activity</h3>' +
      (ltTimeline.length ? '<button id="clearActivity" class="danger" style="padding:3px 9px;font-size:11px">Clear</button>' : '') +
    '</div>' + timeRows,
    '<button id="caseSwitch">All workspaces</button><button id="caseCancel">Close</button><button class="primary" id="caseSave">Save case</button>');

  if (back.querySelector('#clearActivity')) {
    back.querySelector('#clearActivity').onclick = () => {
      showConfirm('Clear recent activity', 'This removes the case\u2019s activity log. It doesn\u2019t affect entities, relationships or evidence.', () => {
        ltTimeline = [];
        saveCaseData();
        showCaseWorkspace();
      }, 'Clear activity', true);
    };
  }
  back.querySelector('#caseCancel').onclick = closeOverlays;
  back.querySelector('#caseSwitch').onclick = showWorkspaceSwitcher;
  back.querySelector('#caseSave').onclick = () => {
    const name = back.querySelector('#caseName').value.trim() || 'Untitled case';
    ltCase.name = name;
    ltCase.description = back.querySelector('#caseDescription').value.trim();
    renameWorkspace(activeWorkspaceId(), name);
    logEvent('Updated case', ltCase.name);
    closeOverlays();
    renderCaseButton();
  };
  back.querySelector('#taskAdd').onclick = () => {
    const title = back.querySelector('#taskTitle').value.trim();
    if (!title) return;
    ltTasks.unshift({ title, status: 'Open', entity: find(selected)?.label || '' });
    logEvent('Added research task', title);
    saveCaseData();
    showCaseWorkspace();
  };
  back.querySelectorAll('[data-task]').forEach((btn) => {
    btn.onclick = () => {
      ltTasks[+btn.dataset.task].status = 'Completed';
      logEvent('Completed research task', ltTasks[+btn.dataset.task].title);
      saveCaseData();
      showCaseWorkspace();
    };
  });
}

function renderCaseButton() {
  const btn = $('workspaceBtn');
  btn.style.display = 'inline-block';
  btn.textContent = ltCase.name + ' \u00b7 Workspace';
  btn.onclick = showWorkspaceSwitcher;
}
