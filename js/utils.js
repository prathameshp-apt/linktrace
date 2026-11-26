'use strict';
/* ---------------------------------------------------------------------
   4. Utilities
   --------------------------------------------------------------------- */
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const find = (id) => nodes.find((n) => n.id === id);
const rels = (id) => links.filter((l) => l.a === id || l.b === id);
const isValidValue = (type, value) => {
  const t = String(type || '').toLowerCase();
  const r = VALIDATORS[t];
  if (r && !r.test(value)) return false;
  const c = customTypeOf(type);
  if (c && c.pattern) { try { return new RegExp(c.pattern).test(value); } catch { return true; } }
  return true;
};
const isValidUrl = (u) => /^https?:\/\//i.test(u || '');

/* ---------------------------------------------------------------------
   Entity type: free text, with best-effort auto-detection.
   There is no fixed list of allowed types any more -- anyone can type
   any label. detectType() only supplies a sensible default while
   someone is typing; it never blocks a custom label.
   --------------------------------------------------------------------- */
/* Checks a raw value (typically a pasted URL) against the shared
   SOCIAL_PATTERNS list. Returns { handle, platform } if it's a
   recognized profile link, or null otherwise -- used so manually typed
   or pasted profile URLs get tagged with their platform exactly like
   ones found via live-search, and so pick up the matching brand icon. */
function detectSocialProfile(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  for (const s of SOCIAL_PATTERNS) {
    const m = v.match(s.re);
    if (m) return { handle: m[1], platform: s.platform };
  }
  return null;
}

function detectType(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (VALIDATORS.email.test(v)) return 'email';
  if (VALIDATORS.ip.test(v)) return 'ip';
  if (detectSocialProfile(v)) return 'username';
  if (/^https?:\/\//i.test(v)) return 'url';
  if (/\.(jpe?g|png|gif|webp|bmp|svg|heic|tiff?)$/i.test(v)) return 'image';
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv|rtf)$/i.test(v)) return 'document';
  if (VALIDATORS.domain.test(v)) return 'domain';
  if (VALIDATORS.phone.test(v) && v.replace(/\D/g, '').length >= 7) return 'phone';
  if (/^@?[A-Za-z0-9_.]{2,30}$/.test(v) && !/\s/.test(v)) return 'username';
  return 'entity';
}

/* If the text typed into the type field matches a known canonical key or
   label (case-insensitively), normalize to that key so lookups/icons/
   engine-matching keep working. Otherwise keep the custom text as-is. */
function labelToKey(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const lower = t.toLowerCase();
  const found = Object.entries(TYPES).find(([k, v]) => k === lower || v[0].toLowerCase() === lower);
  return found ? found[0] : t;
}

/* What to actually store as a node's label: if the typed/pasted value is
   a recognized social profile URL, store it the same way live-search
   chips do -- "handle (Platform)" -- so it picks up the platform's icon
   and reads the same everywhere on the board. Otherwise store as typed. */
function resolveEntityLabel(value) {
  const v = String(value || '').trim();
  const social = detectSocialProfile(v);
  return social ? social.handle + ' (' + social.platform + ')' : v;
}

/* The actual profile URL to carry alongside a "handle (Platform)" label.
   If the typed/pasted value was itself a full URL, use it as-is (it's
   already the exact page). Otherwise, for platforms with a predictable
   profile URL shape, reconstruct one from the handle so a manually typed
   "@handle" still ends up with a working link -- best-effort, since not
   every platform's URL scheme is guessable, but covers the common ones. */
const SOCIAL_PROFILE_URL_TEMPLATES = {
  Instagram: (h) => 'https://instagram.com/' + h,
  'X/Twitter': (h) => 'https://x.com/' + h,
  Facebook: (h) => 'https://facebook.com/' + h,
  LinkedIn: (h) => 'https://linkedin.com/in/' + h,
  TikTok: (h) => 'https://tiktok.com/@' + h,
  GitHub: (h) => 'https://github.com/' + h,
  Reddit: (h) => 'https://reddit.com/u/' + h,
  Telegram: (h) => 'https://t.me/' + h,
  YouTube: (h) => 'https://youtube.com/@' + h,
  Snapchat: (h) => 'https://snapchat.com/add/' + h,
  WhatsApp: (h) => 'https://wa.me/' + h,
  Discord: (h) => 'https://discord.com/users/' + h,
};
function resolveEntitySourceUrl(value) {
  const v = String(value || '').trim();
  if (isValidUrl(v)) return v; // already a real URL -- keep it exactly as given
  const social = detectSocialProfile(v);
  if (social && SOCIAL_PROFILE_URL_TEMPLATES[social.platform]) {
    return SOCIAL_PROFILE_URL_TEMPLATES[social.platform](social.handle);
  }
  return '';
}

/* What to actually store as a node's type: whatever the user typed,
   normalized; falling back to auto-detection from the value if the type
   field was left blank. */
function resolveType(typedTypeText, entityValue) {
  const typed = String(typedTypeText || '').trim();
  return typed ? labelToKey(typed) : (detectType(entityValue) || 'entity');
}

/* Display label for a type: canonical label if recognized, else the raw
   text exactly as entered. */
function typeLabel(type) {
  const key = String(type || '').trim().toLowerCase();
  return (TYPES[key] && TYPES[key][0]) || String(type || '').trim() || 'Entity';
}

/* Icon path for a type. Unknown/custom types still get a predictable,
   swappable filename: icons/<slug-of-what-was-typed>.svg. Drop a matching
   SVG in /icons and it's picked up automatically -- no code change. */
function slugify(text) {
  return String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'entity';
}

/* Social platform -> icon slug. Keys are matched case-insensitively
   against whatever follows "(...)" in a label like "jane.doe (Instagram)"
   -- the shape livesearch.js already produces when it pulls a profile
   out of a URL -- so those nodes get their platform's real icon instead
   of the generic username glyph. */
const SOCIAL_ICONS = {
  instagram: 'instagram',
  facebook: 'facebook',
  youtube: 'youtube',
  'x/twitter': 'x-twitter',
  twitter: 'x-twitter',
  x: 'x-twitter',
  snapchat: 'snapchat',
  tiktok: 'tiktok',
  linkedin: 'linkedin',
  github: 'github',
  reddit: 'reddit',
  telegram: 'telegram',
  whatsapp: 'whatsapp',
  discord: 'discord',
};

/* Pulls "Instagram" out of "jane.doe (Instagram)" and resolves it to a
   known icon slug, or '' if the label doesn't carry a recognized
   platform tag. */
function socialIconSlug(label) {
  const m = String(label || '').match(/\(([^()]+)\)\s*$/);
  if (!m) return '';
  return SOCIAL_ICONS[m[1].trim().toLowerCase()] || '';
}

function typeIconSrc(type, label) {
  if ((String(type || '').toLowerCase() === 'username') && label) {
    const slug = socialIconSlug(label);
    if (slug) return 'icons/' + slug + '.svg';
  }
  return customTypeIcon(type) || ('icons/' + slugify(type) + '.svg');
}

function freeSpot(x, y) {
  while (nodes.some((n) => Math.abs(n.x - x) < 210 && Math.abs(n.y - y) < 110)) {
    x += 215;
    if (x > 1000) { x = 60; y += 125; }
  }
  return { x, y };
}

