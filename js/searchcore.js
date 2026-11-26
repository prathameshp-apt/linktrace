'use strict';
/* ---------------------------------------------------------------------
   Search core: pure helpers (no DOM) so they can be unit-tested.
   - parseQuery:   understands "phrases", words, -exclusions, site:, filetype:, intitle: ...
   - tier:         how well ONE result matches what was typed
                     3 = the typed phrase appears as typed (title / url / snippet)
                     2 = every typed word appears (any order)
                     1 = only some of the words        0 = no / wrong site / excluded
   - normUrl:      one key per page, so the same page from 5 engines is ONE card
   - quoteFreeWords / dorkEngineSet: send engines a precise query
   --------------------------------------------------------------------- */
const SC = (() => {
  const strip = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const norm = (s) => ' ' + strip(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
  const OPS = 'site|filetype|ext|intitle|inurl|intext|inbody';
  const TOKEN = new RegExp('(-?)(?:(' + OPS + '):)?"([^"]+)"|(\\S+)', 'gi');

  function parseQuery(q) {
    const out = { phrases: [], words: [], exclude: [], site: '', filetype: '', hasOps: false };
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(String(q || '')))) {
      if (m[3] !== undefined) {                                   // "quoted", maybe with op: or a leading -
        if (m[1]) { out.exclude.push(m[3]); continue; }
        if (m[2]) { out.hasOps = true; out.words.push(m[3]); continue; }
        out.phrases.push(m[3]); continue;
      }
      const t = m[4];
      const op = t.match(new RegExp('^(-?)(' + OPS + '):(.*)$', 'i'));
      if (op) {
        out.hasOps = true;
        if (op[1]) continue;
        const k = op[2].toLowerCase(), v = op[3];
        if (k === 'site') out.site = strip(v).replace(/^www\./, '');
        else if (k === 'filetype' || k === 'ext') out.filetype = strip(v).replace(/^\./, '');
        else if (v) out.words.push(v);
        continue;
      }
      if (t.length > 1 && t[0] === '-') { out.exclude.push(t.slice(1)); continue; }
      if (/^(OR|AND|\|)$/.test(t)) continue;
      out.words.push(t);
    }
    return out;
  }

  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

  function haystack(r) {
    let u = r.url || '';
    try { u = decodeURIComponent(u); } catch {}
    return norm((r.title || '') + ' ' + u + ' ' + (r.content || ''));
  }

  function tier(r, pq) {
    if (pq.site) { const h = hostOf(r.url); if (!(h === pq.site || h.endsWith('.' + pq.site))) return 0; }
    if (pq.filetype) {
      let p = ''; try { p = new URL(r.url).pathname.toLowerCase(); } catch {}
      if (!p.endsWith('.' + pq.filetype)) return 0;
    }
    const h = haystack(r);
    if (pq.exclude.some((x) => norm(x).trim() && h.includes(norm(x)))) return 0;
    const needs = [...pq.phrases, ...pq.words].map(norm).filter((x) => x.trim());
    if (!needs.length) return 3;
    const hits = needs.filter((w) => h.includes(w)).length;
    if (hits === needs.length) {
      if (pq.words.length < 2) return 3;
      return h.includes(norm(pq.words.join(' '))) ? 3 : 2;
    }
    return hits > 0 && hits * 2 >= needs.length ? 1 : 0;
  }

  const TRACKING = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'si'];
  function normUrl(u) {
    try {
      const x = new URL(u);
      TRACKING.forEach((k) => x.searchParams.delete(k));
      const host = x.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
      const path = x.pathname.replace(/\/index\.(html?|php)$/i, '').replace(/\/+$/, '');
      const q = x.searchParams.toString();
      return host + path + (q ? '?' + q : '');
    } catch { return String(u || '').trim().toLowerCase(); }
  }

  /* wrap the plain (unquoted, operator-free) words as ONE exact phrase:
     Jane Doe intitle:London  ->  "Jane Doe" intitle:London */
  function quoteFreeWords(q) {
    const free = [], rest = [];
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(String(q || '')))) {
      const t = m[0];
      const isFree = m[3] === undefined && !new RegExp('^-?(' + OPS + '):', 'i').test(t) && t[0] !== '-' && !/^(OR|AND|\|)$/.test(t);
      (isFree ? free : rest).push(t);
    }
    if (free.length < 2) return String(q || '').trim();
    return ['"' + free.join(' ') + '"', ...rest].join(' ');
  }

  /* engines that actually understand site:/filetype:/intitle: */
  const DORK_ENGINES = 'google,bing,duckduckgo,brave';

  return { parseQuery, tier, normUrl, quoteFreeWords, hostOf, DORK_ENGINES, norm };
})();
if (typeof module !== 'undefined') module.exports = SC;
