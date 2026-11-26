'use strict';
/* ---------------------------------------------------------------------
   11. Undo / redo
   --------------------------------------------------------------------- */
function undo() {
  if (!hist.length) return;
  future.push(snapshotBoard());
  loadBoard(JSON.parse(hist.pop()));
  saveBoard();
  render();
}
function redo() {
  if (!future.length) return;
  hist.push(snapshotBoard());
  loadBoard(JSON.parse(future.pop()));
  saveBoard();
  render();
}

