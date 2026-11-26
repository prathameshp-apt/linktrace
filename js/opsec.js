'use strict';
/* ---------------------------------------------------------------------
   21. OPSEC: encryption at rest, panic clear, and a plain-language
   accounting of what this app actually protects against.

   Architecture note on the encryption: every existing save/load call
   site (persistence.js) keeps writing to localStorage exactly as
   before -- unchanged, synchronous, zero risk of breaking anything
   that already works. Encryption wraps the *entire* case as one
   snapshot, taken right after every save and restored right after a
   password unlock on load, rather than intercepting each of the many
   individual localStorage calls scattered across the app. That keeps
   this additive: the app works identically with the vault off, and
   turning it on doesn't touch existing logic paths.

   This is real encryption (Web Crypto: PBKDF2 + AES-256-GCM), not
   obfuscation -- which also means a forgotten password is genuinely
   unrecoverable. That trade is stated plainly in the UI, not hidden.
   --------------------------------------------------------------------- */

const OPSEC_KEYS = WORKSPACE_DATA_KEYS.slice();
// Deliberately NOT included: linktrace.engineSelection (a UI checkbox
// preference read mid-session by showSearchModal every time it opens --
// stripping it after each seal would silently reset the selection on
// every open) and linktrace.caseInitialized (a one-time onboarding
// flag, not case content).
const VAULT_KEY = 'linktrace.vault';       // encrypted blob, replaces the plain keys above when the vault is on
const VAULT_SALT_KEY = 'linktrace.vaultSalt'; // not secret -- salts never are -- just needs to be stable per install
const VAULT_ON_KEY = 'linktrace.vaultOn';

let vaultCryptoKey = null; // CryptoKey, held only in memory for this session -- never persisted anywhere

/* ---------------------------------------------------------------------
   Shared abort registry. localStorage wiping is instant, but a live
   search or lookup request already in flight when panic fires would
   otherwise keep running in the background and render its results into
   a UI that just told the person everything was cleared -- a real gap,
   not a cosmetic one, for the exact moment this feature exists for.
   Any fetch elsewhere in the app that should die on panic registers its
   AbortController here via trackFetch(); panicClear() aborts every one.
   --------------------------------------------------------------------- */
const inFlightAborts = new Set();
function trackFetch(controller) {
  inFlightAborts.add(controller);
  return controller;
}
function untrackFetch(controller) {
  inFlightAborts.delete(controller);
}

function bufToB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function b64ToBuf(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer; }

async function deriveVaultKey(password, saltB64) {
  const enc = new TextEncoder();
  const salt = b64ToBuf(saltB64);
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function vaultIsOn() { return localStorage.getItem(VAULT_ON_KEY) === '1'; }

/* In-memory mirror of every OPSEC_KEYS value. This is what makes it
   safe to strip plaintext from localStorage after every seal: without
   it, the next partial save (saveBoard only rewrites linktrace.v4, not
   the other 7 keys) would have nothing to read for the untouched keys
   and sealVault would silently encrypt an incomplete payload, dropping
   data. With it, sealVault always has the last known value of every
   key, updated incrementally as each one changes. */
let vaultMemory = {};

/* Gathers the current value of every OPSEC key -- from localStorage if
   present (a save just wrote it), falling back to the in-memory cache
   otherwise (a different save just ran and this key wasn't touched) --
   encrypts the merged result, then strips plaintext back out of
   localStorage so nothing sits there in the clear between actions. */
async function sealVault() {
  if (!vaultCryptoKey) return;
  OPSEC_KEYS.forEach((k) => {
    const v = localStorage.getItem(k);
    if (v !== null) vaultMemory[k] = v;
  });

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vaultCryptoKey, enc.encode(JSON.stringify(vaultMemory)));

  localStorage.setItem(VAULT_KEY, JSON.stringify({ iv: bufToB64(iv), data: bufToB64(ciphertext) }));
  OPSEC_KEYS.forEach((k) => localStorage.removeItem(k));
}

/* Decrypts the vault blob back into the plaintext keys the rest of the
   app already knows how to read (persistence.js etc. are untouched --
   they just see the same localStorage keys they always have, restored
   right before loadEverything() runs) and seeds vaultMemory with the
   same values so the very next partial save has a complete picture to
   seal from. */
async function unsealVault(password) {
  const salt = localStorage.getItem(VAULT_SALT_KEY);
  const blob = localStorage.getItem(VAULT_KEY);
  if (!salt) throw new Error('No vault has been set up on this device.');

  const key = await deriveVaultKey(password, salt);
  if (!blob) { vaultCryptoKey = key; return; } // vault turned on but nothing saved yet

  const { iv, data } = JSON.parse(blob);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(iv) }, key, b64ToBuf(data));
  } catch {
    throw new Error('Wrong password.'); // AES-GCM fails closed on any tampering or wrong key -- this is the only way to detect it
  }
  const payload = JSON.parse(new TextDecoder().decode(plaintext));
  Object.entries(payload).forEach(([k, v]) => localStorage.setItem(k, v));
  vaultMemory = { ...payload };
  vaultCryptoKey = key;
}

/* Re-seals (and re-strips) on every meaningful save so nothing sits in
   plaintext for longer than the moment persistence.js's own write
   takes, and again on tab close as a last-chance pass. saveBoard/
   saveCaseData already exist and are called throughout the app --
   wrapping them here is the one small hook point instead of touching
   every call site. */
function hookIntoSaves() {
  ['saveBoard', 'saveCaseData'].forEach((fnName) => {
    const original = window[fnName];
    window[fnName] = function (...args) {
      const result = original.apply(this, args);
      if (vaultCryptoKey) sealVault();
      return result;
    };
  });
}

window.addEventListener('beforeunload', () => {
  if (vaultCryptoKey) {
    // Best-effort final seal; browsers don't reliably await async work
    // in beforeunload, so the per-save sealVault() calls above are the
    // real guarantee -- this is just a last pass.
    sealVault();
  }
});

/* ---------------------------------------------------------------------
   Panic clear: Ctrl/Cmd+Shift+Backspace, fires even while typing in a
   field (a panic moment doesn't wait for you to click out of a text
   box first) but requires a 3-key combo specifically so normal typing
   can't trigger it by accident. No confirmation dialog -- a confirm
   step defeats the entire purpose of a panic action. Wipes every
   linktrace.* key by prefix (not a hardcoded list) so it can't miss a
   key some future feature adds.
   --------------------------------------------------------------------- */
function panicClear() {
  inFlightAborts.forEach((c) => { try { c.abort(); } catch {} });
  inFlightAborts.clear();
  Object.keys(localStorage)
    .filter((k) => k.startsWith('linktrace.'))
    .forEach((k) => localStorage.removeItem(k));
  vaultCryptoKey = null;
  vaultMemory = {};
  nodes = []; links = []; selected = null;
  ltTimeline = []; ltTasks = [];
  if (typeof helperPageCache !== 'undefined') helperPageCache.clear(); // cached page lookups are case data too
  document.title = 'LinkTrace';
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;' +
    'background:#14120f;color:#ece7de;font:15px system-ui;flex-direction:column;gap:8px">' +
    '<div style="font-size:28px">\u2713</div><div>Board and saved data cleared.</div>' +
    '<div style="font-size:12px;color:#9c9388">Reload to start a new case.</div></div>';
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Backspace') {
    e.preventDefault();
    panicClear();
  }
});

/* ---------------------------------------------------------------------
   Settings panel: vault setup/unlock, plus a plain accounting of what
   this app actually does and doesn't protect. Overclaiming here would
   be worse than not having the feature -- someone relying on a false
   claim of protection is worse off than someone who never asked.
   --------------------------------------------------------------------- */
function opsecStatusHtml() {
  const on = vaultIsOn();
  return (
    '<div class="opsec-status">' +
      '<div class="opsec-row"><span>Data-at-rest encryption</span><b class="' + (on ? 'ok' : 'off') + '">' + (on ? 'ON' : 'OFF') + '</b></div>' +
      '<div class="opsec-row"><span>Panic clear</span><b class="ok">Ctrl/Cmd+Shift+Backspace</b></div>' +
      '<div class="opsec-row"><span>Outbound link referrers</span><b class="ok">Stripped (noreferrer)</b></div>' +
      '<div class="opsec-row"><span>Form/autofill history</span><b class="ok">Disabled on all fields</b></div>' +
    '</div>' +
    '<h3>What this actually covers</h3>' +
    '<ul class="opsec-list">' +
      '<li><b>Encryption at rest</b> protects the saved case file sitting in this browser\'s storage -- ' +
        'someone else with access to this computer/profile can\'t read it without your password. ' +
        'It does <b>not</b> protect data while you\'re actively viewing it on screen, and a forgotten ' +
        'password means the data is genuinely gone -- there is no recovery.</li>' +
      '<li><b>Panic clear</b> wipes this browser\'s saved copy immediately. It does not undo anything ' +
        'already exported to a file, printed, or synced by browser sync features -- check your browser\'s ' +
        'own sync settings if that matters to you.</li>' +
      '<li><b>Outbound links</b> (evidence URLs, lookup tools) no longer send a Referer header telling the ' +
        'destination site which LinkTrace page you clicked from.</li>' +
      '<li>This app does not hide your IP address, does not route traffic through a VPN or proxy, and does not ' +
        'anonymize the outbound requests made by the search lookups (registry/IP) or the search backend -- those go straight ' +
        'from your network connection to rdap.org / ip-api.com / whichever search engines are enabled. ' +
        'If IP-level anonymity matters for this case, that has to be handled at the network/VM level, ' +
        'not by this app.</li>' +
    '</ul>'
  );
}

function showOpsecSettings() {
  const on = vaultIsOn();
  const back = openModal('OPSEC', '', opsecStatusHtml() +
    (on
      ? '<div class="opsec-action"><button id="opsecTurnOff" class="danger">Turn off encryption (decrypts and keeps data in plain storage)</button></div>'
      : '<div class="opsec-action"><button id="opsecTurnOn" class="primary">Turn on encryption\u2026</button></div>') +
    '',
    '<button id="opsecClose">Close</button>');
  back.querySelector('#opsecClose').onclick = closeOverlays;

  if (!on) {
    back.querySelector('#opsecTurnOn').onclick = () => {
      closeOverlays();
      showVaultSetup();
    };
  } else {
    back.querySelector('#opsecTurnOff').onclick = () => {
      closeOverlays();
      showConfirm('Turn off encryption', 'Your case will be saved in plain, unencrypted browser storage again. Continue?', async () => {
        await sealVault(); // makes sure vaultMemory holds the latest value of every key before we write it back out
        Object.entries(vaultMemory).forEach(([k, v]) => localStorage.setItem(k, v));
        localStorage.removeItem(VAULT_KEY);
        localStorage.removeItem(VAULT_ON_KEY);
        vaultCryptoKey = null;
        vaultMemory = {};
        showAlert('Encryption off', 'The case is now stored unencrypted, same as before the vault was set up.');
      }, 'Turn off', true);
    };
  }
}

function showVaultSetup() {
  const back = openModal('Set a vault password', 'This encrypts everything already saved, plus everything saved from now on. Write this password down somewhere separate -- there is no reset and no recovery.',
    '<label>Password</label><input id="vaultPw" type="password" autocomplete="off">' +
    '<label>Confirm password</label><input id="vaultPw2" type="password" autocomplete="off">' +
    '<div id="vaultSetupErr" class="opsec-err"></div>',
    '<button id="vaultCancel">Cancel</button><button class="primary" id="vaultCreate">Encrypt case</button>');

  back.querySelector('#vaultCreate').onclick = async () => {
    const pw = back.querySelector('#vaultPw').value;
    const pw2 = back.querySelector('#vaultPw2').value;
    const err = back.querySelector('#vaultSetupErr');
    if (pw.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    if (pw !== pw2) { err.textContent = 'Passwords do not match.'; return; }

    const salt = bufToB64(crypto.getRandomValues(new Uint8Array(16)));
    localStorage.setItem(VAULT_SALT_KEY, salt);
    vaultCryptoKey = await deriveVaultKey(pw, salt);
    await sealVault();
    localStorage.setItem(VAULT_ON_KEY, '1');
    closeOverlays();
    showAlert('Encryption on', 'This case is now encrypted at rest. You\'ll be asked for this password each time LinkTrace loads.');
  };
  back.querySelector('#vaultCancel').onclick = closeOverlays;
}

/* Blocks app startup behind a password prompt when the vault is on --
   called from boot.js before loadEverything(), so nothing else in the
   app runs against half-decrypted state. */
function requireVaultUnlock(onReady) {
  if (!vaultIsOn()) return onReady();

  const attempt = (errText) => {
    const back = openModal('LinkTrace is locked', 'Enter the vault password to open this case.',
      '<label>Password</label><input id="unlockPw" type="password" autocomplete="off">' +
      (errText ? '<div class="opsec-err">' + esc(errText) + '</div>' : ''),
      '<button class="primary" id="unlockGo">Unlock</button>');
    // openModal's own listener closes on Escape unconditionally; a
    // listener added afterward on the same (bubble) phase can't
    // override that with preventDefault alone since both listeners
    // still fire independently. Registering on the CAPTURE phase runs
    // this before openModal's own handler even sees the event, so
    // stopImmediatePropagation here actually prevents it from closing --
    // the lock screen has to be actually unlocked, not dismissed.
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    back.addEventListener('click', (e) => {
      if (e.target === back) e.stopImmediatePropagation();
    }, true);
    const submit = async () => {
      const pw = back.querySelector('#unlockPw').value;
      try {
        await unsealVault(pw);
        closeOverlays();
        onReady();
      } catch (e) {
        attempt(e.message || 'Could not unlock.');
      }
    };
    back.querySelector('#unlockGo').onclick = submit;
    back.querySelector('#unlockPw').addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  };
  attempt();
}

hookIntoSaves();
$('opsecBtn').onclick = showOpsecSettings;
