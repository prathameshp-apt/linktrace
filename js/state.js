'use strict';
/* ---------------------------------------------------------------------
   2. State
   --------------------------------------------------------------------- */
let nodes = [];          // {id,type,label,x,y,parentId,notes,confidence,tags[],evidence[]}
let links = [];          // {id,a,b,label,confidence}
let nextId = 1, nextLink = 1;
let selected = null;     // id of selected node (when exactly one is selected)
let multi = new Set();   // ids when two or more are selected (rectangle / Shift-click)
let linkFrom = null;     // id of node awaiting a relationship target
let zoom = 0.85;   // slightly zoomed out by default for a compact look
let drag = null;         // {id,x,y,ox,oy,moved}
let resizeDrag = null;   // {id,x,y,ow,oh}
let connectDrag = null;  // {fromId} -- dragging a connection line from the connect handle
let hist = [], future = [];

let ltCase = { name: 'Untitled case', description: '' };
let ltTimeline = [];
let ltTasks = [];
let ltEngines = DEFAULT_ENGINES.slice();
let customEvidence = [];

