'use strict';
/* ---------------------------------------------------------------------
   Graph physics
   Replaces the old "throw a card across a table" inertia (tilt, lift,
   rubber-banding) with behaviour closer to a link-analysis graph:

   - Connections act as elastic leashes. Drag an entity and the things
     linked to it follow along, then ease to a stop -- but only once a
     link is stretched past its natural length, so a layout you arranged
     by hand holds still instead of drifting.
   - Cards never rest on top of each other: overlapping boxes are pushed
     apart smoothly (soft force, not a snap).
   - Motion is critically-damped and cut off quickly, and the whole
     thing goes to sleep (and saves) the moment everything is still.

   The entity under the cursor is pinned to the cursor while dragging.
   --------------------------------------------------------------------- */
const PHYS = {
  restGap: 190,     // natural gap between linked card borders (px)
  slack: 1.25,      // leash only tightens beyond rest * slack
  spring: 0.02,     // pull per px of over-stretch
  gap: 14,          // breathing room kept between cards
  push: 0.22,       // how firmly overlapping cards separate
  damping: 0.78,    // velocity kept per frame
  maxV: 28,         // px/frame speed cap
  sleepV: 0.06,     // below this everything is considered at rest
  throwGain: 7,     // release velocity carried into a short glide
};

const physVel = new Map();
const edgeRest = new Map();   // 'a:b' -> link length when this drag session began   // node id -> {vx, vy}
let physRaf = null;

const physReducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function physV(id) {
  let v = physVel.get(id);
  if (!v) { v = { vx: 0, vy: 0 }; physVel.set(id, v); }
  return v;
}

function wakePhysics() {
  if (physRaf || physReducedMotion()) return;
  physRaf = requestAnimationFrame(physStep);
}

/* Every connection as [idA, idB]: parent/child findings + drawn links. */
function physEdges() {
  const edges = [];
  nodes.forEach((n) => { if (n.parentId && find(n.parentId)) edges.push([n.parentId, n.id]); });
  links.forEach((l) => { if (find(l.a) && find(l.b)) edges.push([l.a, l.b]); });
  return edges;
}

function physStep() {
  physRaf = null;
  const pinnedIds = new Set(drag && drag.moved ? (drag.group ? drag.group.map((g) => g.id) : [drag.id]) : []);
  const pinnedId = pinnedIds.size ? 1 : 0;
  const resizingId = resizeDrag ? resizeDrag.id : null;
  const isPinned = (id) => pinnedIds.has(id) || id === resizingId;
  const force = new Map();
  const add = (id, fx, fy) => {
    const f = force.get(id) || { fx: 0, fy: 0 };
    f.fx += fx; f.fy += fy; force.set(id, f);
  };

  // 1) leashes
  physEdges().forEach(([ia, ib]) => {
    const a = find(ia), b = find(ib);
    const da = nodeDims(a), db = nodeDims(b);
    const ax = a.x + da.w / 2, ay = a.y + da.h / 2;
    const bx = b.x + db.w / 2, by = b.y + db.h / 2;
    const dx = bx - ax, dy = by - ay;
    const d = Math.hypot(dx, dy) || 1;
    // measured between card borders, so tall photo cards in a tidy tree aren't dragged together
    const gx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + da.w, b.x + db.w));
    const gy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + da.h, b.y + db.h));
    const gap = Math.hypot(gx, gy);
    const key = ia + ':' + ib;
    if (!edgeRest.has(key)) edgeRest.set(key, Math.max(PHYS.restGap, gap));   // a layout you arranged (or auto-tidied) holds still
    const stretch = gap - edgeRest.get(key) * PHYS.slack;
    if (stretch <= 0) return;
    const f = stretch * PHYS.spring;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    add(ia, fx, fy);
    add(ib, -fx, -fy);
  });

  // 2) soft collision between cards
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const { w: aw, h: ah } = nodeDims(a);
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const { w: bw, h: bh } = nodeDims(b);
      const dx = (b.x + bw / 2) - (a.x + aw / 2);
      const dy = (b.y + bh / 2) - (a.y + ah / 2);
      const ox = (aw + bw) / 2 + PHYS.gap - Math.abs(dx);
      const oy = (ah + bh) / 2 + PHYS.gap - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;
      // shortest way out; exact overlap -> nudge on a stable axis
      if (ox < oy) {
        const dir = dx === 0 ? (a.id < b.id ? -1 : 1) : Math.sign(dx);
        const f = ox * PHYS.push;
        add(a.id, -dir * f, 0); add(b.id, dir * f, 0);
      } else {
        const dir = dy === 0 ? (a.id < b.id ? -1 : 1) : Math.sign(dy);
        const f = oy * PHYS.push;
        add(a.id, 0, -dir * f); add(b.id, 0, dir * f);
      }
    }
  }

  // 3) integrate
  let maxSpeed = 0;
  nodes.forEach((n) => {
    const v = physV(n.id);
    if (isPinned(n.id)) { v.vx = 0; v.vy = 0; return; }
    const f = force.get(n.id);
    v.vx = (v.vx + (f ? f.fx : 0)) * PHYS.damping;
    v.vy = (v.vy + (f ? f.fy : 0)) * PHYS.damping;
    const sp = Math.hypot(v.vx, v.vy);
    if (sp > PHYS.maxV) { v.vx *= PHYS.maxV / sp; v.vy *= PHYS.maxV / sp; }
    if (Math.hypot(v.vx, v.vy) < PHYS.sleepV && !f) { v.vx = 0; v.vy = 0; return; }
    const nx = Math.max(10, n.x + v.vx), ny = Math.max(10, n.y + v.vy);
    if (nx === 10 && n.x + v.vx < 10) v.vx = 0;
    if (ny === 10 && n.y + v.vy < 10) v.vy = 0;
    if (Math.abs(nx - n.x) > 0.01 || Math.abs(ny - n.y) > 0.01) {
      n.x = nx; n.y = ny;
      updateNodeAndPaths(n);
    }
    maxSpeed = Math.max(maxSpeed, Math.hypot(v.vx, v.vy));
  });

  // keep going while something moves or a drag is still in progress
  if (maxSpeed > PHYS.sleepV || pinnedId || resizingId) {
    physRaf = requestAnimationFrame(physStep);
  } else {
    physVel.clear();
    edgeRest.clear();
    resizeBoard();
    saveBoard();
  }
}

/* Called on release: the dropped card keeps a little of the pointer's
   velocity as a short glide, then the world settles. */
function releaseWithThrow(id, vx, vy) {
  const v = physV(id);
  v.vx = Math.max(-PHYS.maxV, Math.min(PHYS.maxV, vx * PHYS.throwGain));
  v.vy = Math.max(-PHYS.maxV, Math.min(PHYS.maxV, vy * PHYS.throwGain));
  wakePhysics();
}
