'use strict';
/* Rolling local backups: everything lives in browser storage, so keep a
   few dated copies of the board (max one per 10 minutes, newest 5). */
const BACKUP_KEY = 'linktrace.backups';
let lastBackupAt = 0;
function readBackups() { try { return JSON.parse(localStorage.getItem(BACKUP_KEY)) || []; } catch { return []; } }
function writeBackups(list) {
  for (let keep = list.length; keep >= 0; keep--) {      // shrink until it fits the storage quota
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify(list.slice(0, keep))); return true; } catch { /* quota */ }
  }
  return false;
}
function makeBackup(force) {
  if (!nodes.length) return false;
  if (!force && Date.now() - lastBackupAt < 600000) return false;
  lastBackupAt = Date.now();
  const list = readBackups();
  list.unshift({ at: new Date().toISOString(), caseName: ltCase.name, count: nodes.length, data: snapshotBoard() });
  return writeBackups(list.slice(0, 5));
}
let backupTimer = null;
function scheduleBackup() { clearTimeout(backupTimer); backupTimer = setTimeout(() => makeBackup(false), 4000); }

function showBackupsModal() {
  const list = readBackups();
  const rows = list.map((b, i) =>
    '<div class="card"><b>' + esc(new Date(b.at).toLocaleString()) + '</b><br><small>' + esc(b.caseName || '') + ' \u00b7 ' + b.count + ' entities</small>' +
    '<div class="row" style="margin-top:6px"><button data-restore="' + i + '">Restore</button><button data-dl="' + i + '">Download</button></div></div>').join('')
    || '<small>No backups yet \u2014 one is saved automatically a few seconds after you change the board.</small>';
  const back = openModal('Backups', 'Saved in this browser only. Restoring replaces the current board (you can Undo).', rows,
    '<button id="bkClose">Close</button><button class="primary" id="bkNow">Back up now</button>');
  back.querySelector('#bkClose').onclick = closeOverlays;
  back.querySelector('#bkNow').onclick = () => { closeOverlays(); showToast(makeBackup(true) ? 'Backup saved' : 'Backup failed \u2014 browser storage is full', null); };
  back.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = () => {
      try { const data = JSON.parse(list[+b.dataset.restore].data); mark(); loadBoard(data); saveBoard(); closeOverlays(); render(); showToast('Backup restored', 'Undo', undo); }
      catch { showAlert('Restore failed', 'That backup could not be read.'); }
    };
  });
  back.querySelectorAll('[data-dl]').forEach((b) => {
    b.onclick = () => { const x = list[+b.dataset.dl]; const o = JSON.parse(x.data); downloadFile(JSON.stringify({ version: 4, nodes: o.nodes, links: o.links }, null, 2), 'linktrace-backup-' + x.at.slice(0, 16).replace(/[:T]/g, '-') + '.json', 'application/json'); };
  });
}
$('backupsBtn').onclick = showBackupsModal;
