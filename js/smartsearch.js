'use strict';
/* ---------------------------------------------------------------------
   Smart search: the search bar detects WHAT was typed and offers the
   matching lookups; everything comes back in the same results list.

     e-mail        -> Holehe   (which sites have an account)
     +phone        -> Ignorant (is the number registered on Instagram/Amazon/Snapchat)
     username      -> Maigret  (profiles under that name)
     domain / IP   -> WHOIS/RDAP registry record, IP geolocation

   Chips under the search box select which tools run. A chip you switch
   on runs now and again on every search until you switch it off.
   Account tools (Holehe / Ignorant / Maigret) send the identifier to
   third-party sites, so switching one on asks you to confirm first.
   Registry/IP lookups use public records (rdap.org, ip-api.com) and are
   on by default.
   --------------------------------------------------------------------- */

const LOOKUP_EXTERNAL_ICON =
  '<svg class="ls-ext-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 15 20 4M20 4h-6M20 4v6"/><path d="M12 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>';

const RDAP_BASE = 'https://rdap.org';
const IP_GEO_BASE = 'http://ip-api.com/json/'; // free tier is HTTP-only, no SSL on the no-key endpoint

function isIPv4(value) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every((o) => +o <= 255);
}
function isIPv6(value) {
  return /^[0-9a-f:]+:[0-9a-f:]+$/i.test(value) && value.includes(':');
}
function isDomain(value) {
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/i.test(value.trim());
}


/* Pulls the handful of fields worth showing out of an RDAP response --
   the full object also includes vCard entity arrays, event arrays,
   nested links, etc. that are more noise than signal for a quick
   investigator-facing card. */
function summarizeRdap(data) {
  const events = {};
  (data.events || []).forEach((e) => { events[e.eventAction] = e.eventDate; });
  const registrar = (data.entities || []).find((e) => (e.roles || []).includes('registrar'));
  const registrarName = registrar && registrar.vcardArray && registrar.vcardArray[1]
    ? (registrar.vcardArray[1].find((f) => f[0] === 'fn') || [])[3] : null;

  return {
    handle: data.handle || data.ldhName || data.name || null,
    status: (data.status || []).join(', ') || null,
    registrar: registrarName,
    registered: events.registration || null,
    expires: events.expiration || null,
    updated: events['last changed'] || events['last update of RDAP database'] || null,
    nameservers: (data.nameservers || []).map((ns) => ns.ldhName).filter(Boolean),
    country: data.country || null,
  };
}

function rdapResultCardHtml(query, summary, rawLink) {
  const rows = [
    ['Handle / name', summary.handle],
    ['Status', summary.status],
    ['Registrar', summary.registrar],
    ['Registered', summary.registered && summary.registered.slice(0, 10)],
    ['Expires', summary.expires && summary.expires.slice(0, 10)],
    ['Last updated', summary.updated && summary.updated.slice(0, 10)],
    ['Country', summary.country],
    ['Nameservers', summary.nameservers.length ? summary.nameservers.join(', ') : null],
  ].filter(([, v]) => v);

  return (
    '<div class="ls-net-card">' +
      '<div class="ls-net-card-head">' +
        '<b>' + esc(query) + '</b>' +
        '<span class="evidence-tag">RDAP</span>' +
      '</div>' +
      (rows.length
        ? '<table class="ls-net-table">' + rows.map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>').join('') + '</table>'
        : '<p class="dim">No registry record fields returned for this query.</p>') +
      '<div class="row">' +
        '<button data-net-add data-net-type="domain" data-net-value="' + esc(query) + '" ' +
          'data-net-notes="' + esc('RDAP: ' + (summary.registrar || summary.handle || 'registry record') + (summary.registered ? ' \u00b7 registered ' + summary.registered.slice(0, 10) : '')) + '">+ node</button>' +
        '<a href="' + esc(rawLink) + '" target="_blank" rel="noopener noreferrer" class="ls-net-raw">View raw RDAP JSON' + LOOKUP_EXTERNAL_ICON + '</a>' +
      '</div>' +
    '</div>'
  );
}

function geoResultCardHtml(query, geo) {
  if (geo.status !== 'success') {
    return '<div class="ls-net-card"><div class="ls-net-card-head"><b>' + esc(query) + '</b><span class="evidence-tag">IP geolocation</span></div>' +
      '<p class="dim">' + esc(geo.message || 'No geolocation data available for this address.') + '</p></div>';
  }
  const rows = [
    ['Country', geo.country],
    ['Region', geo.regionName],
    ['City', geo.city],
    ['ISP', geo.isp],
    ['Organization', geo.org],
    ['ASN', geo.as],
    ['Timezone', geo.timezone],
    ['Coordinates', (geo.lat != null && geo.lon != null) ? geo.lat + ', ' + geo.lon : null],
  ].filter(([, v]) => v);

  const locLabel = [geo.city, geo.regionName, geo.country].filter(Boolean).join(', ');
  return (
    '<div class="ls-net-card">' +
      '<div class="ls-net-card-head">' +
        '<b>' + esc(query) + '</b>' +
        '<span class="evidence-tag">IP geolocation</span>' +
      '</div>' +
      '<table class="ls-net-table">' + rows.map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>').join('') + '</table>' +
      '<p class="ls-net-approx">Approximate network location from the IP\'s registered routing info &mdash; not a precise or device-level location.</p>' +
      '<div class="row">' +
        '<button data-net-add data-net-type="ip" data-net-value="' + esc(query) + '" ' +
          'data-net-notes="' + esc('IP geolocation: ' + (locLabel || 'unknown') + (geo.isp ? ' \u00b7 ' + geo.isp : '')) + '">+ node</button>' +
      '</div>' +
    '</div>'
  );
}

function bindNetAddButtons(scope) {
  scope.querySelectorAll('[data-net-add]').forEach((btn) => {
    btn.onclick = () => {
      addNode(btn.dataset.netType, btn.dataset.netValue);
      const n = nodes.find((x) => x.id === selected);
      if (n && btn.dataset.netNotes) {
        n.notes = n.notes ? n.notes + '\n' + btn.dataset.netNotes : btn.dataset.netNotes;
        saveBoard(); render();
      }
    };
  });
}


const SMART_TOOLS = {
  holehe:   { kind: 'account', label: 'Holehe',       sub: 'accounts by e-mail',   kinds: ['email'] },
  ignorant: { kind: 'account', label: 'Ignorant',     sub: 'number registered?',   kinds: ['phone'] },
  maigret:  { kind: 'account', label: 'Maigret',      sub: 'profiles by username', kinds: ['username'] },
  rdap:     { kind: 'public',  label: 'WHOIS / RDAP', sub: 'registry record',      kinds: ['domain', 'ip'] },
  geo:      { kind: 'public',  label: 'IP location',  sub: 'network location',     kinds: ['ip'] },
};
const KIND_LABEL = { email: 'E-mail', phone: 'Phone number', ip: 'IP address', domain: 'Domain', username: 'Username' };
const SMART_KEY = 'linktrace.smartArmed', SMART_OPTS_KEY = 'linktrace.smartOpts';
let smartArmed = { rdap: true, geo: true, holehe: false, ignorant: false, maigret: false };
let smartOpts = {};
try { smartArmed = Object.assign(smartArmed, JSON.parse(localStorage.getItem(SMART_KEY)) || {}); } catch {}
try { smartOpts = JSON.parse(localStorage.getItem(SMART_OPTS_KEY)) || {}; } catch {}
const saveSmart = () => { try { localStorage.setItem(SMART_KEY, JSON.stringify(smartArmed)); localStorage.setItem(SMART_OPTS_KEY, JSON.stringify(smartOpts)); } catch {} };
const toolCtls = new Set();

/* what kind of thing is in the box? (cheap, local, no network) */
function detectKinds(raw) {
  const out = { kinds: [], subject: {}, hint: '' };
  const q = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!q || q.length > 254) return out;
  if (isValidValue('email', q)) { out.kinds.push('email'); out.subject.email = q; return out; }
  if (/^\+\d[\d ()\-]{6,24}$/.test(q)) { out.kinds.push('phone'); out.subject.phone = q; return out; }
  if (/^[\d ()\-]{7,25}$/.test(q) && /\d{6}/.test(q.replace(/\D/g, ''))) { out.hint = 'Looks like a phone number \u2014 add the country code (+91\u2026, +1\u2026) to check where it\u2019s registered.'; return out; }
  if (isIPv4(q) || isIPv6(q)) { out.kinds.push('ip'); out.subject.ip = q; return out; }
  let host = '';
  if (/^https?:\/\//i.test(q)) { try { host = new URL(q).hostname; } catch {} }
  else if (!/\s/.test(q) && isDomain(q)) host = q;
  if (host && isDomain(host)) { out.kinds.push('domain'); out.subject.domain = host.toLowerCase().replace(/^www\./, ''); }
  if (!/\s/.test(q) && !/^https?:\/\//i.test(q) && !(host && !q.startsWith('@'))) {   // example.com is a domain; @example.com is a username
    const u = q.replace(/^@/, '');
    if (/^[A-Za-z0-9][A-Za-z0-9._\-]{1,63}$/.test(u)) { out.kinds.push('username'); out.subject.username = u; }
  }
  return out;
}
function subjectFor(tool, d) {
  const s = d.subject;
  return { holehe: s.email, ignorant: s.phone, maigret: s.username, rdap: s.domain || s.ip, geo: s.ip }[tool] || '';
}
const toolApplies = (tool, d) => SMART_TOOLS[tool].kinds.some((k) => d.kinds.includes(k));

/* ---------- chips under the search box ---------- */
function updateSmartBar() {
  const box = $('lsSmart');
  const d = detectKinds($('lsQuery').value);
  const tools = Object.keys(SMART_TOOLS).filter((t) => toolApplies(t, d));
  if (!tools.length && !d.hint) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = (tools.length ? '<span class="ls-smart-label">' + d.kinds.map((k) => KIND_LABEL[k]).join(' / ') + '</span>' : '') +
    tools.map((t) => {
      const T = SMART_TOOLS[t], on = !!smartArmed[t];
      return '<button type="button" class="ls-tool-chip' + (on ? ' armed' : '') + '" data-tool="' + t + '" aria-pressed="' + on + '" ' +
        'title="' + (on ? 'On \u2014 runs on every search for this kind of value. Click to switch off.' : (T.kind === 'account' ? 'Click to run (asks to confirm first \u2014 contacts third-party sites)' : 'Click to run')) + '">' +
        (on ? '\u2713 ' : '') + esc(T.label) + ' <small>' + esc(T.sub) + '</small></button>';
    }).join('') + (d.hint ? '<span class="ls-smart-hint">' + esc(d.hint) + '</span>' : '');
  box.querySelectorAll('[data-tool]').forEach((b) => { b.onclick = () => onToolChip(b.dataset.tool); });
}
$('lsQuery').addEventListener('input', () => { clearTimeout(updateSmartBar._t); updateSmartBar._t = setTimeout(updateSmartBar, 120); });

async function onToolChip(tool) {
  const d = detectKinds($('lsQuery').value);
  const subject = subjectFor(tool, d);
  if (!subject) return;
  if (smartArmed[tool]) {                        // switch off
    smartArmed[tool] = false; saveSmart(); stopTool(tool); updateSmartBar();
    return;
  }
  if (SMART_TOOLS[tool].kind === 'account') {
    const opts = await confirmAccountTool(tool, subject);
    if (!opts) return;
    smartOpts[tool] = opts;
  }
  smartArmed[tool] = true; saveSmart(); updateSmartBar();
  runTool(tool, subject);
}

/* called by every new search: run whatever is switched on for what was typed */
function runSmartTools(q) {
  const d = detectKinds(q);
  Object.keys(SMART_TOOLS).forEach((t) => {
    if (smartArmed[t] && toolApplies(t, d) && subjectFor(t, d)) runTool(t, subjectFor(t, d));
  });
}

function clearToolResults() {
  toolCtls.forEach((c) => c.abort()); toolCtls.clear();
  lsToolData = [];
  $('lsToolResults').innerHTML = '';
}
function stopTool(tool) {
  $('lsToolResults').querySelectorAll('.ls-tool[data-tool="' + tool + '"]').forEach((el) => { if (el._ctl) el._ctl.abort(); el.remove(); });
}

/* ---------- one block per running tool: header, progress, hits ---------- */
function makeToolBlock(tool, subject) {
  stopTool(tool);                                 // re-running replaces the old block
  const T = SMART_TOOLS[tool];
  const el = document.createElement('div');
  el.className = 'ls-tool'; el.dataset.tool = tool;
  el.innerHTML = '<div class="ls-tool-head"><b>' + esc(T.label) + '</b><span class="ls-tool-sub">' + esc(subject) + '</span>' +
    '<span class="ls-tool-state"></span><button type="button" class="ls-tool-stop" title="Stop and remove">\u00d7</button></div>' +
    '<div class="hl-bar"><span class="indeterminate"></span></div><div class="ls-tool-warn" hidden></div><div class="ls-tool-hits"></div>';
  $('lsToolResults').append(el);
  const ref = { el, state: el.querySelector('.ls-tool-state'), bar: el.querySelector('.hl-bar span'), warn: el.querySelector('.ls-tool-warn'), hits: el.querySelector('.ls-tool-hits') };
  el.querySelector('.ls-tool-stop').onclick = () => { if (el._ctl) el._ctl.abort(); el.remove(); };
  return ref;
}
const blockDone = (b, text) => { b.state.textContent = text; b.bar.classList.remove('indeterminate'); b.bar.style.width = '100%'; };

function runTool(tool, subject) {
  if (SMART_TOOLS[tool].kind === 'account') runAccountTool(tool, subject);
  else runPublicTool(tool, subject);
}

function toolHitResult(tool, f, subject) {
  const T = ACCOUNT_TOOLS[tool];
  const url = T.evidenceUrl(f);
  return { title: T.label(f), url, content: T.evidenceNote(f), img: '', engines: [tool], _tier: 0, _weak: false,
    _acct: { tool, f, subject }, _key: tool + '|' + subject + '|' + url, _enriched: tool !== 'maigret' };
}

async function runAccountTool(tool, subject) {
  const T = ACCOUNT_TOOLS[tool];
  const gen = lsGen;
  const blk = makeToolBlock(tool, subject);
  const st = await helperToolStatus(tool);
  if (st !== 'ready') {
    blockDone(blk, st === 'down' ? 'Helper not running \u2014 start osint-vm/start.sh' : 'Not installed \u2014 in osint-vm run: .venv/bin/pip install ' + tool + '  then ./stop.sh && ./start.sh');
    blk.el.classList.add('error');
    return;
  }
  const ctl = trackFetch(new AbortController());
  toolCtls.add(ctl); blk.el._ctl = ctl;
  const hits = new Set();
  let total = 0, seen = 0, unknown = 0;
  const paint = () => {
    blk.state.textContent = (total ? seen + ' / ' + total + ' checked \u00b7 ' : 'searching \u00b7 ') + hits.size + ' hit' + (hits.size === 1 ? '' : 's');
    if (total) { blk.bar.classList.remove('indeterminate'); blk.bar.style.width = Math.min(100, seen / total * 100) + '%'; }
  };
  try {
    await streamAccountTool(tool, subject, smartOpts[tool] || {}, ctl, {
      start: (o) => { if (o.total) total = o.total; paint(); },
      warn: (text) => { blk.warn.hidden = false; blk.warn.textContent = text; },
      result: (o) => {
        seen++;
        if (o.status === 'unknown') unknown++;
        if (o.status !== 'found' || gen !== lsGen) return paint();
        const key = T.key(o);
        if (hits.has(key)) return;
        hits.add(key);
        const r = toolHitResult(tool, o, subject);
        lsToolData.push(r);
        const card = document.createElement('div');
        card.innerHTML = cardHtml(r, TOOL_BASE + lsToolData.length - 1);
        const el = card.firstElementChild;
        blk.hits.append(el); bindCard(el); observeEnrich([el]);
        renderGroupBar(); updateBulkBar(); paint();
      },
    });
    blockDone(blk, hits.size + ' hit' + (hits.size === 1 ? '' : 's') + (unknown ? ' \u00b7 ' + unknown + ' couldn\u2019t be checked' : '') + (tool === 'maigret' ? ' \u00b7 leads, not confirmed matches' : ''));
    logEvent(T.name, subject + ': ' + hits.size + ' hit(s)');
  } catch (err) {
    if (err.name !== 'AbortError') { blockDone(blk, 'Check failed: ' + err.message); blk.el.classList.add('error'); }
  } finally { toolCtls.delete(ctl); untrackFetch(ctl); }
}

async function runPublicTool(tool, subject) {
  const blk = makeToolBlock(tool, subject);
  const ctl = trackFetch(new AbortController());
  toolCtls.add(ctl); blk.el._ctl = ctl;
  const isIp = isIPv4(subject) || isIPv6(subject);
  try {
    let html = '';
    if (tool === 'geo') {
      const res = await fetch(IP_GEO_BASE + encodeURIComponent(subject) + '?fields=status,message,country,regionName,city,isp,org,as,timezone,lat,lon', { signal: ctl.signal });
      html = geoResultCardHtml(subject, res.ok ? await res.json() : { status: 'error', message: 'Geolocation service returned HTTP ' + res.status + '.' });
    } else {
      const path = (isIp ? '/ip/' : '/domain/') + encodeURIComponent(subject);
      const res = await fetch(RDAP_BASE + path, { signal: ctl.signal });
      if (res.ok) html = rdapResultCardHtml(subject, summarizeRdap(await res.json()), RDAP_BASE + path);
      else html = '<p class="dim">' + (res.status === 404 ? 'No registry record found (unregistered, or this TLD has no public RDAP server yet).' : 'Registry lookup failed (HTTP ' + res.status + ').') + '</p>';
    }
    blk.hits.innerHTML = html;
    bindNetAddButtons(blk.hits);
    blockDone(blk, 'done');
    logEvent('Lookup', SMART_TOOLS[tool].label + ': ' + subject);
  } catch (err) {
    if (err.name !== 'AbortError') { blockDone(blk, 'Couldn\u2019t reach the lookup service (' + (err.message || 'network error') + ')'); blk.el.classList.add('error'); }
  } finally { toolCtls.delete(ctl); untrackFetch(ctl); }
}
