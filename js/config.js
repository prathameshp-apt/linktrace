'use strict';
/* =========================================================================
   LinkTrace
   A client-side research board: entities, relationships, evidence and
   case notes, persisted to localStorage in this browser. Split into one
   file per module -- load order matches the <script> tags in index.html.
   ========================================================================= */

/* ---------------------------------------------------------------------
   1. Config
   --------------------------------------------------------------------- */
/* TYPES holds the categories LinkTrace can auto-detect from a typed value
   -- it is no longer a restrictive list. The entity-type field is free
   text: anyone can type any label they want ("HUMINT source", "Vehicle",
   "Bank account", whatever the case needs). If what they type matches one
   of these canonical labels/keys it gets that label + icon; otherwise the
   raw text they typed is used as-is, with a generic icon. Icons are loaded
   from /icons/<slug>.svg (see utils.js: typeIconSrc) -- drop a same-named
   SVG in that folder to reskin any type, known or custom, no code change. */
const TYPES = {
  entity:   ['Entity'],
  name:     ['Person'],
  username: ['Username'],
  email:    ['Email'],
  phone:    ['Phone'],
  ip:       ['IP address'],
  domain:   ['Domain'],
  url:      ['URL / page'],
  image:    ['Image'],
  document: ['Document'],
};
/* Extra labels offered as datalist suggestions on the type field -- not
   enforced, just quick-fill for common investigation categories. */
const TYPE_SUGGESTIONS = [
  'Organization', 'Account', 'Address', 'HUMINT source', 'GEOINT location', 'SOCMINT profile',
];
const STATUS = { unverified: '#a89a7c', corroborated: '#5fae8f', disproved: '#d9584f' };
const STANDARD_EVIDENCE = [
  'Web page / URL', 'Screenshot', 'Image', 'PDF / document', 'Archive snapshot',
  'Social post / profile', 'Email / header', 'Public record / filing',
  'Domain / DNS / certificate', 'Infrastructure observation', 'Chat / message',
  'Video / audio', 'Geolocation observation', 'Analyst note', 'File hash', 'External report',
];
const VALIDATORS = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  ip: /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/,
  domain: /^(?:[\w-]+\.)+[a-z]{2,}$/i,
  phone: /^\+?[\d ()-]{7,25}$/,
};
const STORE_KEY = 'linktrace.v4';           // board: nodes + links
const LEGACY_KEY = 'linktrace.v3';          // previous format, migrated on load
const CASE_KEY = 'linktrace.case';
const TIMELINE_KEY = 'linktrace.timeline';
const TASKS_KEY = 'linktrace.tasks';
const ENGINES_KEY = 'linktrace.engines';
const LIVESEARCH_KEY = 'linktrace.livesearch';
const CASE_INIT_KEY = 'linktrace.caseInitialized';
const EVIDENCE_TYPES_KEY = 'linktrace.customEvidence';
/* Multi-workspace registry. Each workspace is a fully separate case:
   its own board, case metadata, timeline, tasks, engine list and
   custom evidence types. WORKSPACES_KEY holds the index (id/name/
   createdAt for every workspace); ACTIVE_WORKSPACE_KEY holds which one
   is currently loaded into the live keys above (STORE_KEY, CASE_KEY,
   etc.); WORKSPACE_PREFIX + id holds that workspace's full snapshot
   when it's not the active one. Switching workspace serializes the
   live keys into the outgoing workspace's snapshot, then deserializes
   the incoming one back into those same live keys -- so persistence.js,
   opsec.js and every existing save/load call site keep working exactly
   as before, unaware anything changed underneath them. */
const WORKSPACES_KEY = 'linktrace.workspaces';
const ACTIVE_WORKSPACE_KEY = 'linktrace.activeWorkspace';
const WORKSPACE_PREFIX = 'linktrace.ws.';
/* The exact set of live keys that make up one workspace's data -- kept
   here as a single source of truth so workspace.js's snapshot/restore
   and opsec.js's vault coverage can never drift apart from each other. */
const WORKSPACE_DATA_KEYS = [STORE_KEY, CASE_KEY, TIMELINE_KEY, TASKS_KEY, ENGINES_KEY, LIVESEARCH_KEY, EVIDENCE_TYPES_KEY];

/* Patterns used to pull candidate entities out of live-search result
   text (title + snippet) -- deliberately loose since these only ever
   produce suggestions the user reviews and chooses to add. Also reused
   to auto-detect the type of whatever a person types into "Add an entity". */
const EXTRACT_PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  /* Requires an explicit phone "shape" -- a leading + country code or a
     parenthesized/dashed area code -- rather than any bare run of 7-11
     digits. Cuts false positives from order numbers, years-plus-suffix,
     and partial postal codes that show up constantly in search snippets;
     a plain digit run with no separators or country/area-code marker no
     longer qualifies. */
  phone: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?|\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{2,4}/g,
  url: /https?:\/\/[^\s"'<>)]+/g,
};

/* Known social platforms -- pulled out of any URL (found in a search
   result, or pasted straight into the "Add an entity" box) so a profile
   link becomes a linkable "username" entity carrying its platform name,
   instead of just a generic URL. Shared by livesearch.js (results) and
   utils.js (manual entry) so both paths recognize the same platforms
   and get the same icon. */
const SOCIAL_PATTERNS = [
  { host: /(?:^|\.)instagram\.com$/, re: /instagram\.com\/([a-zA-Z0-9_.]{2,30})/, platform: 'Instagram' },
  { host: /(?:^|\.)(?:twitter|x)\.com$/, re: /(?:twitter|x)\.com\/([a-zA-Z0-9_]{2,15})/, platform: 'X/Twitter' },
  { host: /(?:^|\.)facebook\.com$/, re: /facebook\.com\/([a-zA-Z0-9_.\-]{2,50})/, platform: 'Facebook' },
  { host: /(?:^|\.)linkedin\.com$/, re: /linkedin\.com\/in\/([a-zA-Z0-9_-]{2,60})/, platform: 'LinkedIn' },
  { host: /(?:^|\.)tiktok\.com$/, re: /tiktok\.com\/@([a-zA-Z0-9_.]{2,30})/, platform: 'TikTok' },
  { host: /(?:^|\.)github\.com$/, re: /github\.com\/([a-zA-Z0-9_-]{2,39})/, platform: 'GitHub' },
  { host: /(?:^|\.)reddit\.com$/, re: /reddit\.com\/u(?:ser)?\/([a-zA-Z0-9_-]{2,20})/, platform: 'Reddit' },
  { host: /(?:^|\.)t\.me$/, re: /t\.me\/([a-zA-Z0-9_]{3,32})/, platform: 'Telegram' },
  { host: /(?:^|\.)youtube\.com$/, re: /youtube\.com\/@([a-zA-Z0-9_.-]{2,30})/, platform: 'YouTube' },
  { host: /(?:^|\.)snapchat\.com$/, re: /snapchat\.com\/add\/([a-zA-Z0-9_.-]{2,30})/, platform: 'Snapchat' },
  { host: /(?:^|\.)wa\.me$/, re: /wa\.me\/([0-9]{7,15})/, platform: 'WhatsApp' },
  { host: /(?:^|\.)discord(?:app)?\.com$/, re: /discord(?:app)?\.com\/users\/([0-9]{5,25})/, platform: 'Discord' },
];

/* Search engines / lookup services used by the "Search web" picker.
   Every entry just opens a public results page in a new tab with the
   entity value filled into {q} -- nothing here is scraped or fetched
   automatically, and none of it returns actual leaked personal data;
   the breach-check entries only report whether an address/name has
   appeared in a known breach, same as visiting the site directly. */
const DEFAULT_ENGINES = [
  { name: 'Google', url: 'https://www.google.com/search?q={q}', forTypes: [] },
  { name: 'Bing', url: 'https://www.bing.com/search?q={q}', forTypes: [] },
  { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={q}', forTypes: [] },
  { name: 'Yandex', url: 'https://yandex.com/search/?text={q}', forTypes: [] },
  { name: 'Startpage', url: 'https://www.startpage.com/sp/search?query={q}', forTypes: [] },
  { name: 'Have I Been Pwned', url: 'https://haveibeenpwned.com/account/{q}', forTypes: ['email', 'username'], hint: 'Public breach-presence check only' },
  { name: 'WHOIS', url: 'https://www.whois.com/whois/{q}', forTypes: ['domain', 'ip'] },
  { name: 'Wayback Machine', url: 'https://web.archive.org/web/*/{q}', forTypes: ['domain', 'url'] },
  { name: 'crt.sh (certificates)', url: 'https://crt.sh/?q={q}', forTypes: ['domain'] },
  { name: 'Google Maps', url: 'https://www.google.com/maps/search/?api=1&query={q}', forTypes: [] },
  { name: 'Social search', url: 'https://www.google.com/search?q={q}+site:linkedin.com+OR+site:instagram.com+OR+site:x.com+OR+site:facebook.com', forTypes: ['username'] },
  /* Reverse image search -- same link-out model as everything else here:
     opens the provider's own public reverse-image page in a new tab.
     For an "Image" entity the label is normally a filename or a pasted
     image URL, not something typed as a search phrase, so these engines
     matter specifically for the 'image' type. Google Lens and Yandex
     both accept a direct image URL appended to their query param; TinEye
     and Bing use their own upload/URL-search entry points. */
  { name: 'Google Lens (reverse image)', url: 'https://lens.google.com/uploadbyurl?url={q}', forTypes: ['image', 'url'], hint: 'Needs a direct image URL, not a filename' },
  { name: 'Yandex Images (reverse)', url: 'https://yandex.com/images/search?rpt=imageview&url={q}', forTypes: ['image', 'url'], hint: 'Needs a direct image URL, not a filename' },
  { name: 'TinEye (reverse image)', url: 'https://tineye.com/search?url={q}', forTypes: ['image', 'url'], hint: 'Needs a direct image URL, not a filename' },
  { name: 'Bing Visual Search', url: 'https://www.bing.com/images/search?q=imgurl:{q}&view=detailv2&iss=sbiupload', forTypes: ['image', 'url'], hint: 'Needs a direct image URL, not a filename' },
];

/* ---------------------------------------------------------------------
   Lookup tools -- category-grouped link-out shortcuts, same model as
   DEFAULT_ENGINES above (opens the provider's own public page with the
   value filled in; nothing is scraped or fetched by LinkTrace itself).
   Grouped by category so the "Lookup tools" tab can show one row of
   category buttons instead of one long flat list.

   Deliberately NOT included, on purpose, in any category: credential /
   password-dump lookup sites, hash-cracking services, or dark-web /
   breach-forum mirrors. Those exist (see e.g. the "Credentials" and
   "Leaks" sections of awesome-hacker-search-engines) but surface other
   people's stolen data on request, which isn't something this tool will
   do regardless of the reason. Have I Been Pwned is the one exception:
   it only ever reports whether an address/name appears in a known
   breach (yes/no + which breach), never the leaked data itself, so it's
   listed separately below as a plain exposure check. */
const LOOKUP_CATEGORIES = [
  {
    id: 'code',
    label: 'Code',
    tools: [
      { name: 'GitHub Code Search', url: 'https://github.com/search?q={q}&type=code', forTypes: [] },
      { name: 'grep.app', url: 'https://grep.app/search?q={q}', forTypes: [] },
      { name: 'SourceGraph', url: 'https://sourcegraph.com/search?q=context:global+{q}', forTypes: [] },
      { name: 'GitHub Gists', url: 'https://gist.github.com/search?q={q}', forTypes: [] },
    ],
  },
  {
    id: 'certs',
    label: 'Certificates',
    tools: [
      { name: 'crt.sh', url: 'https://crt.sh/?q={q}', forTypes: ['domain'] },
      { name: 'Censys Certificates', url: 'https://search.censys.io/certificates?q={q}', forTypes: ['domain'] },
    ],
  },
  {
    id: 'dns',
    label: 'DNS / Domains',
    tools: [
      { name: 'DNSDumpster', url: 'https://dnsdumpster.com/?q={q}', forTypes: ['domain'] },
      { name: 'RapidDNS', url: 'https://rapiddns.io/subdomain/{q}', forTypes: ['domain'] },
      { name: 'ViewDNS', url: 'https://viewdns.info/reversewhois/?q={q}', forTypes: ['domain'] },
      { name: 'BGPview (ASN/IP)', url: 'https://bgpview.io/search?search={q}', forTypes: ['domain', 'ip'] },
      { name: 'SecurityTrails', url: 'https://securitytrails.com/domain/{q}/dns', forTypes: ['domain'] },
    ],
  },
  {
    id: 'threatintel',
    label: 'Threat intel',
    tools: [
      { name: 'VirusTotal', url: 'https://www.virustotal.com/gui/search/{q}', forTypes: ['domain', 'ip', 'url'] },
      { name: 'AbuseIPDB', url: 'https://www.abuseipdb.com/check/{q}', forTypes: ['ip'] },
      { name: 'URLScan.io', url: 'https://urlscan.io/search/#{q}', forTypes: ['domain', 'url'] },
      { name: 'AlienVault OTX', url: 'https://otx.alienvault.com/browse/global/pulses?q={q}', forTypes: ['domain', 'ip'] },
    ],
  },
  {
    id: 'archives',
    label: 'Web history',
    tools: [
      { name: 'Wayback Machine', url: 'https://web.archive.org/web/*/{q}', forTypes: ['domain', 'url'] },
      { name: 'Archive.ph', url: 'https://archive.ph/{q}', forTypes: ['domain', 'url'] },
      { name: 'CommonCrawl Index', url: 'https://index.commoncrawl.org/#{q}', forTypes: ['domain', 'url'] },
    ],
  },
  {
    id: 'reverseimage',
    label: 'Reverse image',
    tools: [
      { name: 'Google Lens', url: 'https://lens.google.com/uploadbyurl?url={q}', forTypes: ['image', 'url'] },
      { name: 'Yandex Images', url: 'https://yandex.com/images/search?rpt=imageview&url={q}', forTypes: ['image', 'url'] },
      { name: 'TinEye', url: 'https://tineye.com/search?url={q}', forTypes: ['image', 'url'] },
      { name: 'Bing Visual Search', url: 'https://www.bing.com/images/search?q=imgurl:{q}&view=detailv2&iss=sbiupload', forTypes: ['image', 'url'] },
    ],
  },
];

/* Breach exposure check -- deliberately its own small list, separate
   from LOOKUP_CATEGORIES, because it's a different kind of tool: it
   only ever confirms whether a value has appeared in a known breach.
   Still just a link-out, same as everything above -- no API key held
   by LinkTrace, no data pulled back into the app. */
const BREACH_CHECK_TOOLS = [
  { name: 'Have I Been Pwned', url: 'https://haveibeenpwned.com/account/{q}', forTypes: ['email', 'username'] },
  { name: 'Have I Been Zuckered (Facebook)', url: 'https://haveibeenzuckered.com/', forTypes: [] },
];
