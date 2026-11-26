'use strict';
/* ---------------------------------------------------------------------
   Account checks (all run in the local helper, results stream back live):
     Holehe    e-mail    -> sites that have an account for this address
     Ignorant  phone     -> Instagram / Amazon / Snapchat know this number?
     Maigret   username  -> sites with a profile under this name
   Nothing runs without a confirmation: the identifier is sent to third-party
   sites from this computer's IP.
   --------------------------------------------------------------------- */
const ACCOUNT_TOOLS = {
  holehe: {
    name: 'Holehe', type: 'email', button: 'Find sites using this e-mail\u2026',
    hint: 'Asks ~110 sites whether an account exists for this address.',
    subject: (n) => String(n.label || '').trim(),
    valid: (s) => isValidValue('email', s),
    invalid: 'This entity\u2019s value doesn\u2019t look like a valid e-mail address.',
    intro: 'Holehe asks about 110 websites whether an account exists for:',
    notes: 'It does not log in, read mail or use breach data. \u201cFound\u201d means a site recognised the address (occasionally wrong); \u201cnot found\u201d is weak evidence.',
    options: [
      { id: 'recovery', param: 'recovery', label: 'Include password-recovery checks', small: '(Adobe, Mail.ru, OK.ru, Samsung \u2014 these start a real reset and <b>can e-mail the account owner</b>)' },
      { id: 'adult', param: 'adult', label: 'Include adult sites', small: '(sensitive: off by default)' },
    ],
    query: (s, o) => 'email=' + encodeURIComponent(s) + '&adult=' + (o.adult ? 1 : 0) + '&recovery=' + (o.recovery ? 1 : 0),
    key: (f) => f.domain,
    label: (f) => f.domain,
    extras: (f) => [f.recovery_email && 'recovery e-mail: ' + f.recovery_email, f.phone && 'phone: ' + f.phone],
    evidenceTitle: (f, s) => 'Holehe: ' + f.domain + ' recognised ' + s,
    evidenceUrl: (f) => 'https://' + f.domain,
    evidenceNote: (f) => 'Site reported an account for this address (Holehe). Unverified.' + (f.recovery_email ? ' Recovery e-mail hint: ' + f.recovery_email + '.' : '') + (f.phone ? ' Phone hint: ' + f.phone + '.' : ''),
    entity: (f, s) => ({ type: 'Account', value: f.domain, url: '', meta: { props: [{ k: 'Site', v: f.domain }, { k: 'E-mail', v: s }, { k: 'Source', v: 'Holehe' }, { k: 'Status', v: 'account exists (unverified)' }]
      .concat(f.recovery_email ? [{ k: 'Recovery e-mail', v: f.recovery_email }] : [], f.phone ? [{ k: 'Phone hint', v: f.phone }] : []) } }),
  },
  ignorant: {
    name: 'Ignorant', type: 'phone', button: 'Check where this number is registered\u2026',
    hint: 'Checks Instagram, Amazon and Snapchat for this number.',
    subject: (n) => String(n.label || '').trim(),
    valid: (s) => /^\+\d[\d ()\-]{6,24}$/.test(s),
    invalid: 'Write the number in international form with the country code, e.g. +91 98765 43210, then try again.',
    intro: 'Ignorant asks Instagram, Amazon and Snapchat whether this phone number is registered:',
    notes: 'It uses each site\u2019s own \u201cis this number registered?\u201d lookup and is not designed to message the number, but I can\u2019t promise that for every site. Only three sites are covered, so \u201cnot found\u201d means very little.',
    options: [],
    query: (s) => 'phone=' + encodeURIComponent(s),
    key: (f) => f.domain,
    label: (f) => f.domain,
    extras: () => [],
    evidenceTitle: (f, s) => 'Ignorant: ' + f.domain + ' recognised ' + s,
    evidenceUrl: (f) => 'https://' + f.domain,
    evidenceNote: () => 'Site reported an account registered to this phone number (Ignorant). Unverified.',
    entity: (f, s) => ({ type: 'Account', value: f.domain, url: '', meta: { props: [{ k: 'Site', v: f.domain }, { k: 'Phone', v: s }, { k: 'Source', v: 'Ignorant' }, { k: 'Status', v: 'number registered (unverified)' }] } }),
  },
  maigret: {
    name: 'Maigret', type: 'username', button: 'Find profiles with this username\u2026',
    hint: 'Looks for a profile under this exact name on hundreds of sites.',
    subject: (n) => String(n.label || '').replace(/\s*\([^)]*\)\s*$/, '').replace(/^@/, '').trim(),
    valid: (s) => /^[A-Za-z0-9][A-Za-z0-9._\-]{1,63}$/.test(s),
    invalid: 'Maigret needs a plain username (letters, digits, . _ -), 2\u201364 characters.',
    intro: 'Maigret checks whether a profile exists on many sites for the username:',
    notes: 'It only looks up the exact name you typed (it does not follow leads to other names). The same username is often used by <b>different people</b> \u2014 treat every hit as a lead to verify, not as a match.',
    options: [],
    select: { id: 'sites', label: 'How many sites', choices: [['200', 'Top 200 (about a minute)'], ['500', 'Top 500 (a few minutes)'], ['all', 'All ~8,000 (very slow, noisy)']], def: '200' },
    query: (s, o) => 'username=' + encodeURIComponent(s) + '&sites=' + encodeURIComponent(o.sites || '200'),
    key: (f) => f.url || f.domain,
    label: (f) => f.name + ' \u2014 ' + f.domain,
    extras: (f) => [f.url],
    evidenceTitle: (f, s) => 'Maigret: ' + s + ' profile on ' + f.name,
    evidenceUrl: (f) => f.url,
    evidenceNote: (f) => 'A profile page was found at this address for the username (Maigret). Unverified \u2014 may be a different person.',
    entity: (f, s) => ({ type: 'username', value: s + ' (' + f.name + ')', url: f.url, meta: { props: [{ k: 'Site', v: f.name }, { k: 'Username', v: s }, { k: 'Source', v: 'Maigret' }, { k: 'Status', v: 'profile found (unverified)' }] } }),
  },
};

async function helperToolStatus(tool) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(HELPER_BASE + '/api/health', { signal: ctl.signal });
    clearTimeout(t);
    return (await res.json())[tool] ? 'ready' : 'missing';
  } catch { return 'down'; }
}

/* Confirmation before an account tool runs for the first time: what is sent where,
   plus the tool's options. Resolves with the chosen options, or null if cancelled. */
function confirmAccountTool(tool, subject) {
  const T = ACCOUNT_TOOLS[tool];
  return new Promise(async (resolve) => {
    if (!T.valid(subject)) { showAlert('Can\u2019t run ' + T.name, T.invalid); return resolve(null); }
    const st = await helperToolStatus(tool);
    if (st === 'down') { showAlert('Helper not running', T.name + ' runs through the local helper. Start it with osint-vm/start.sh.'); return resolve(null); }
    if (st === 'missing') { showAlert(T.name + ' isn\u2019t installed', 'Install it into the helper\u2019s virtual environment (osint-vm folder):\n\n  .venv/bin/pip install ' + tool + '\n\nthen run ./stop.sh && ./start.sh.'); return resolve(null); }
    const opts = T.options.map((o) => '<label class="check"><input type="checkbox" id="ac_' + o.id + '"> ' + o.label + ' <small>' + o.small + '</small></label>').join('');
    const sel = T.select ? '<label>' + T.select.label + '</label><select id="ac_' + T.select.id + '">' +
      T.select.choices.map(([v, l]) => '<option value="' + v + '"' + (v === T.select.def ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' : '';
    const back = openModal(T.name + ' \u00b7 confirm', T.intro,
      '<div class="card"><b>' + esc(subject) + '</b></div>' +
      '<p class="hint">It is sent to those sites <b>from this computer\u2019s IP</b> (use your VPN/Tor setup if that matters). ' + T.notes +
      ' Only check identifiers you are authorised to investigate.</p><p class="hint">Once switched on, ' + esc(T.name) + ' runs automatically whenever you search this kind of value. Click its chip again to switch it off.</p>' + sel + opts,
      '<button id="acCancel">Cancel</button><button class="primary" id="acRun">Switch on and run</button>');
    back.querySelector('#acCancel').onclick = () => { closeOverlays(); resolve(null); };
    back.querySelector('#acRun').onclick = () => {
      const o = {};
      T.options.forEach((x) => { o[x.param] = back.querySelector('#ac_' + x.id).checked; });
      if (T.select) o[T.select.id] = back.querySelector('#ac_' + T.select.id).value;
      closeOverlays();
      resolve(o);
    };
  });
}

/* Streams one tool run from the helper (NDJSON). h = {start, result, warn}; resolves when the stream ends. */
async function streamAccountTool(tool, subject, opts, ctl, h) {
  const T = ACCOUNT_TOOLS[tool];
  const res = await fetch(HELPER_BASE + '/api/' + tool + '?' + T.query(subject, opts), { signal: ctl.signal });
  if (!res.ok) { let m = 'Helper returned ' + res.status; try { m = (await res.json()).error || m; } catch {} throw new Error(m); }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  const handle = (line) => {
    if (!line.trim()) return;
    const o = JSON.parse(line);
    if (o.type === 'start' && h.start) h.start(o);
    else if (o.type === 'warn' && h.warn) h.warn(o.text);
    else if (o.type === 'result' && h.result) h.result(o);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    lines.forEach(handle);
  }
  if (buf) handle(buf);
}
