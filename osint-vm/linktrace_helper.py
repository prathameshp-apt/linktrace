#!/usr/bin/env python3
"""
LinkTrace local helper -- standard library only (Python 3.8+), no installs.

Why this exists
---------------
Browsers refuse to show most websites inside another page (the site sends
X-Frame-Options / CSP frame-ancestors) and refuse to let a page read another
site's HTML (CORS). Neither can be worked around from front-end code. This
small server runs on YOUR machine, fetches the page itself, and hands
LinkTrace three things it can use:

  GET /api/health                  -> {"ok": true}
  GET /api/page?url=<url>          -> JSON: title, description, site name,
                                      favicon, og:image and EVERY image found
                                      on the page (absolute URLs, de-duplicated,
                                      tracking pixels filtered out)
  GET /api/render?url=<url>        -> a safe, script-free snapshot of the page
                                      that CAN be framed (scripts, iframes, forms
                                      and event handlers removed, CSP applied)
  GET /api/holehe|ignorant|maigret -> OPTIONAL account checks (e-mail / phone / username),
                                      streamed; see account_checks.py (pip install each tool)
  GET /api/img?url=<url>           -> the image bytes, fetched server-side with
                                      no Referer (gets past hotlink protection)

Safety model
------------
* Binds to 127.0.0.1 only.
* Rejects requests from web pages on other origins (only file:// pages, which
  send "Origin: null", and localhost / 127.0.0.1 pages are accepted) and
  rejects unexpected Host headers (DNS-rebinding guard).
* Refuses to fetch loopback / private / link-local / reserved addresses, on
  every redirect hop, so it cannot be turned into a probe of your own network.
  Use --allow-private only if you really need that.
* Only http/https, size-capped, time-capped, never executes anything it fetches.

Limits (be honest about them)
-----------------------------
* The snapshot is the HTML the server returns WITHOUT running JavaScript.
  Pages that build themselves entirely in JS (many single-page apps) will look
  sparse; sites behind a login or bot-wall may return a block page. The image
  and metadata extraction has the same limit.
* Some sites serve different content to non-browser clients or block data-centre
  / VPN addresses. The helper identifies as a normal desktop browser.

Run:   python3 linktrace_helper.py            (default 127.0.0.1:8899)
"""
import argparse
import gzip
import ipaddress
import json
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import zlib
from html import escape
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
MAX_HTML = 3 * 1024 * 1024
MAX_IMG = 12 * 1024 * 1024
TIMEOUT = 12
MAX_IMAGES = 80
ALLOW_PRIVATE = False
PORT = 8899

SKIP_IMG_HINTS = ("pixel", "spacer", "blank.", "1x1", "tracking", "beacon", "/ads/", "doubleclick",
                  "facebook.com/tr", "analytics", "sprite")


# --------------------------------------------------------------------------
# URL safety
# --------------------------------------------------------------------------
def host_is_blocked(host):
    if ALLOW_PRIVATE:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise ValueError("Could not resolve host: " + host)
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            return True
    return False


def check_url(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError("Only http/https URLs are supported")
    if host_is_blocked(p.hostname):
        raise ValueError("Blocked: address is private, loopback or reserved")
    return url


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(SafeRedirect)


def fetch(url, limit, accept="*/*"):
    """Returns (final_url, content_type, bytes). No Referer is ever sent."""
    check_url(url)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
    })
    with OPENER.open(req, timeout=TIMEOUT) as resp:
        raw = resp.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("Response too large")
        enc = (resp.headers.get("Content-Encoding") or "").lower()
        if enc == "gzip":
            raw = gzip.decompress(raw)
        elif enc == "deflate":
            try:
                raw = zlib.decompress(raw)
            except zlib.error:
                raw = zlib.decompress(raw, -zlib.MAX_WBITS)
        return resp.geturl(), resp.headers.get("Content-Type", ""), raw


def decode_html(raw, content_type):
    m = re.search(r"charset=([\w-]+)", content_type or "", re.I)
    enc = m.group(1) if m else None
    if not enc:
        m = re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", raw[:4096], re.I)
        enc = m.group(1).decode("ascii", "ignore") if m else "utf-8"
    try:
        return raw.decode(enc, "replace")
    except LookupError:
        return raw.decode("utf-8", "replace")


# --------------------------------------------------------------------------
# Metadata + image extraction
# --------------------------------------------------------------------------
def absolutize(base, ref):
    ref = (ref or "").strip()
    if not ref or ref.startswith(("data:", "javascript:", "blob:", "about:", "#")):
        return ""
    try:
        u = urllib.parse.urljoin(base, ref)
    except ValueError:
        return ""
    return u if u.startswith(("http://", "https://")) else ""


def best_from_srcset(srcset):
    best, best_w = "", -1
    for part in (srcset or "").split(","):
        bits = part.strip().split()
        if not bits:
            continue
        w = 0
        if len(bits) > 1:
            try:
                w = int(float(bits[1].rstrip("wx")) * (1 if bits[1].endswith("w") else 1000))
            except ValueError:
                w = 0
        if w >= best_w:
            best, best_w = bits[0], w
    return best


class PageParser(HTMLParser):
    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.title = ""
        self._in_title = False
        self.meta = {}
        self.icons = []
        self.images = []          # (url, alt, w, h, source)
        self.text = []
        self._skip = 0
        self.base_href = None

    def add_image(self, ref, alt="", w=0, h=0, source="img"):
        u = absolutize(self.base_href or self.base, ref)
        if u:
            self.images.append((u, alt or "", w, h, source))

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        if tag == "base" and a.get("href") and self.base_href is None:
            self.base_href = absolutize(self.base, a["href"]) or None
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
            if key and a.get("content"):
                self.meta.setdefault(key, a["content"].strip())
                if key in ("og:image", "og:image:url", "og:image:secure_url", "twitter:image",
                           "twitter:image:src", "image"):
                    self.add_image(a["content"], source="meta")
        elif tag == "link":
            rel = a.get("rel", "").lower()
            if "icon" in rel and a.get("href"):
                self.icons.append(absolutize(self.base_href or self.base, a["href"]))
            if rel in ("image_src", "apple-touch-icon") and a.get("href"):
                self.add_image(a["href"], source="link")
        elif tag == "img":
            def num(v):
                m = re.match(r"\d+", v or "")
                return int(m.group()) if m else 0
            src = (a.get("src") or a.get("data-src") or a.get("data-lazy-src")
                   or a.get("data-original") or a.get("data-lazy") or "")
            ss = a.get("srcset") or a.get("data-srcset")
            if ss:
                src = best_from_srcset(ss) or src
            self.add_image(src, a.get("alt", ""), num(a.get("width")), num(a.get("height")))
        elif tag == "source":
            ss = a.get("srcset") or a.get("data-srcset")
            if ss:
                self.add_image(best_from_srcset(ss), source="picture")
        elif tag == "video" and a.get("poster"):
            self.add_image(a["poster"], source="poster")
        if tag in ("script", "style", "noscript", "svg", "template"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in ("script", "style", "noscript", "svg", "template") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            t = data.strip()
            if t:
                self.text.append(t)


def extract_page(url):
    final, ctype, raw = fetch(url, MAX_HTML, "text/html,application/xhtml+xml,*/*;q=0.8")
    if ctype.lower().startswith("image/"):
        return {"url": url, "finalUrl": final, "kind": "image", "title": url.rsplit("/", 1)[-1],
                "description": "", "siteName": "", "favicon": "", "ogImage": final,
                "images": [{"url": final, "alt": "", "source": "direct"}], "excerpt": ""}
    html = decode_html(raw, ctype)
    p = PageParser(final)
    try:
        p.feed(html)
    except Exception:
        pass
    seen, images = set(), []
    for (u, alt, w, h, source) in p.images:
        key = u.split("#")[0]
        if key in seen:
            continue
        low = u.lower()
        if any(s in low for s in SKIP_IMG_HINTS):
            continue
        if (w and w < 48) or (h and h < 48):
            continue
        if low.split("?")[0].endswith((".ico",)):
            continue
        seen.add(key)
        images.append({"url": u, "alt": alt[:200], "source": source, "w": w, "h": h})
        if len(images) >= MAX_IMAGES:
            break
    # Meta images first (they are the page's own chosen preview), then the rest in page order.
    images.sort(key=lambda i: 0 if i["source"] == "meta" else 1)
    og = next((i["url"] for i in images if i["source"] == "meta"), "")
    favicon = p.icons[0] if p.icons else absolutize(final, "/favicon.ico")
    desc = p.meta.get("og:description") or p.meta.get("description") or p.meta.get("twitter:description") or ""
    title = (p.meta.get("og:title") or p.title or "").strip()
    return {
        "url": url, "finalUrl": final, "kind": "page",
        "title": re.sub(r"\s+", " ", title)[:300],
        "description": re.sub(r"\s+", " ", desc)[:600],
        "siteName": p.meta.get("og:site_name", ""),
        "favicon": favicon, "ogImage": og, "images": images,
        "excerpt": re.sub(r"\s+", " ", " ".join(p.text))[:1200],
    }


# --------------------------------------------------------------------------
# Safe snapshot
# --------------------------------------------------------------------------
DROP_TAGS = {"script", "svg", "iframe", "frame", "frameset", "object", "embed", "noscript",
             "template", "applet", "audio", "video", "canvas", "dialog", "meta", "base"}
UNWRAP_TAGS = {"html", "body", "form", "button", "select", "textarea", "label", "fieldset"}  # keep their text, drop the tag
VOID = {"img", "br", "hr", "input", "link", "source", "wbr", "col", "area", "track", "embed", "meta",
        "base", "param", "keygen"}
URL_ATTRS = {"href", "src", "poster"}


class Sanitizer(HTMLParser):
    def __init__(self, base, proxy_img):
        super().__init__(convert_charrefs=False)
        self.base = base
        self.proxy_img = proxy_img
        self.out = []
        self._drop = 0
        self.base_href = None

    def _clean_attrs(self, tag, attrs):
        res = []
        a = {k: (v or "") for k, v in attrs}
        if tag == "img":
            src = (a.get("src") or a.get("data-src") or a.get("data-lazy-src") or a.get("data-original") or "")
            ss = a.get("srcset") or a.get("data-srcset")
            if ss:
                src = best_from_srcset(ss) or src
            u = absolutize(self.base_href or self.base, src)
            if not u:
                return None
            res.append(("src", self.proxy_img(u)))
            if a.get("alt"):
                res.append(("alt", a["alt"]))
            res.append(("loading", "lazy"))
            return res
        for k, v in attrs:
            k = k.lower()
            if k.startswith("on") or k in ("srcset", "style", "formaction", "action", "target", "ping"):
                continue
            v = v or ""
            if k == "href":
                u = absolutize(self.base_href or self.base, v)
                if not u:
                    continue
                res.append((k, u))
                res.append(("target", "_blank"))
                res.append(("rel", "noopener noreferrer nofollow"))
            elif k in URL_ATTRS:
                continue
            elif k in ("class", "id", "alt", "title", "colspan", "rowspan", "lang", "dir", "role",
                       "datetime", "width", "height", "align"):
                res.append((k, v))
        return res

    def handle_starttag(self, tag, attrs):
        if tag == "base":
            for k, v in attrs:
                if k == "href" and v and self.base_href is None:
                    self.base_href = absolutize(self.base, v) or None
            return
        if tag in DROP_TAGS or tag in ("style", "head"):
            if tag not in VOID:
                self._drop += 1
            return
        if self._drop or tag in UNWRAP_TAGS or tag == "input":
            return
        attrs2 = self._clean_attrs(tag, attrs)
        if attrs2 is None:
            return
        s = "<" + tag + "".join(' %s="%s"' % (k, escape(v, quote=True)) for k, v in attrs2) + ">"
        self.out.append(s)

    def handle_endtag(self, tag):
        if tag in DROP_TAGS or tag in ("style", "head"):
            if tag not in VOID and self._drop:
                self._drop -= 1
            return
        if self._drop or tag in VOID or tag in UNWRAP_TAGS:
            return
        self.out.append("</" + tag + ">")

    def handle_data(self, data):
        if not self._drop:
            self.out.append(escape(data, quote=False))

    def handle_entityref(self, name):
        if not self._drop:
            self.out.append("&" + name + ";")

    def handle_charref(self, name):
        if not self._drop:
            self.out.append("&#" + name + ";")


SNAPSHOT_CSS = """
:root{color-scheme:light}
html{background:#fff}
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c2630;
  max-width:860px;margin:0 auto;padding:18px 20px 40px;overflow-wrap:anywhere}
img{max-width:100%;height:auto;border-radius:4px}
a{color:#0a6c7a}
table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}
td,th{border:1px solid #d8dee4;padding:4px 8px}
pre,code{background:#f3f5f7;padding:2px 4px;border-radius:4px;white-space:pre-wrap}
nav,header nav,footer{opacity:.7}
.lt-banner{position:sticky;top:0;margin:-18px -20px 16px;padding:7px 20px;background:#0e151c;color:#8fa3b5;
  font:12px/1.4 -apple-system,Segoe UI,sans-serif;border-bottom:2px solid #22c7d6;z-index:9}
.lt-banner b{color:#e6eef5}
"""


def render_snapshot(url, img_base):
    final, ctype, raw = fetch(url, MAX_HTML, "text/html,application/xhtml+xml,*/*;q=0.8")
    if ctype.lower().startswith("image/"):
        body = '<img src="%s" alt="">' % escape(img_base + urllib.parse.quote(final, safe=""))
    else:
        html = decode_html(raw, ctype)
        s = Sanitizer(final, lambda u: img_base + urllib.parse.quote(u, safe=""))
        try:
            s.feed(html)
            s.close()
        except Exception:
            pass
        body = "".join(s.out)
        if not body.strip():
            body = "<p>The server returned no readable HTML. The page probably builds itself with JavaScript.</p>"
    banner = ('<div class="lt-banner"><b>Snapshot</b> &middot; scripts removed, fetched by the local helper &middot; '
              + escape(urllib.parse.urlsplit(final).netloc) + '</div>')
    return ("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\">"
            "<style>" + SNAPSHOT_CSS + "</style></head><body>" + banner + body + "</body></html>").encode("utf-8")


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------
_HOLEHE_OK = None
def _holehe_ready():
    """Is the optional Holehe bridge usable? (cached; needs `pip install holehe`)"""
    global _HOLEHE_OK
    if _HOLEHE_OK is None:
        try:
            import holehe_bridge
            _HOLEHE_OK = holehe_bridge.available()
        except Exception:
            _HOLEHE_OK = False
    return _HOLEHE_OK


_TOOLS_OK = {}
def _tool_ready(tool):
    if tool not in _TOOLS_OK:
        try:
            import account_checks
            _TOOLS_OK[tool] = account_checks.available(tool)
        except Exception:
            _TOOLS_OK[tool] = False
    return _TOOLS_OK[tool]


class Handler(BaseHTTPRequestHandler):
    server_version = "LinkTraceHelper/1.0"

    def _account_check(self, q, tool):
        """GET /api/<holehe|ignorant|maigret>?...  -> NDJSON stream (see account_checks.py)"""
        import account_checks as ac
        if not ac.available(tool):
            return self._json(501, {"error": "%s is not installed. Run: pip install %s  (inside osint-vm/.venv), then restart the helper" % (tool, ac.PIP[tool])})
        kw, err = ac.validate(tool, q)
        if err:
            return self._json(400, {"error": err})
        if not ac.LOCKS[tool].acquire(blocking=False):
            return self._json(429, {"error": "A %s check is already running -- wait for it to finish" % tool})
        try:
            origin = self.headers.get("Origin")
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", origin if origin else "*")
            self.send_header("Vary", "Origin")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.close_connection = True

            def write(obj):
                self.wfile.write((json.dumps(obj, default=str) + "\n").encode("utf-8"))
                self.wfile.flush()
            ac.run(tool, kw, write)
        except (BrokenPipeError, ConnectionResetError):
            pass                      # the browser closed the stream (Cancel): just stop
        finally:
            ac.LOCKS[tool].release()

    def log_message(self, fmt, *args):  # keep the console quiet: URLs are investigative data
        pass

    def _origin_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        if host not in ("127.0.0.1", "localhost", "[::1]"):
            return False
        origin = self.headers.get("Origin")
        if origin is None or origin == "null":
            return True
        o = urllib.parse.urlsplit(origin)
        return o.hostname in ("127.0.0.1", "localhost", "::1")

    def _send(self, code, body, ctype, extra=None):
        origin = self.headers.get("Origin")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", origin if origin else "*")
        self.send_header("Vary", "Origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "private, max-age=300")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def do_OPTIONS(self):
        if not self._origin_ok():
            return self._json(403, {"error": "origin not allowed"})
        self._send(204, b"", "text/plain")

    def do_GET(self):
        if not self._origin_ok():
            return self._json(403, {"error": "origin not allowed"})
        parts = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(parts.query)
        url = (q.get("url") or [""])[0]
        try:
            if parts.path == "/api/health":
                return self._json(200, {"ok": True, "version": 1, "holehe": _holehe_ready(), "ignorant": _tool_ready("ignorant"), "maigret": _tool_ready("maigret")})
            if parts.path in ("/api/holehe", "/api/ignorant", "/api/maigret"):
                return self._account_check(q, parts.path.rsplit("/", 1)[1])
            if parts.path == "/api/page":
                return self._json(200, extract_page(url))
            if parts.path == "/api/render":
                img_base = "http://%s/api/img?url=" % self.headers.get("Host")
                body = render_snapshot(url, img_base)
                csp = ("default-src 'none'; img-src http://127.0.0.1:* http://localhost:* data:; "
                       "style-src 'unsafe-inline'; sandbox allow-popups")
                return self._send(200, body, "text/html; charset=utf-8", {"Content-Security-Policy": csp})
            if parts.path == "/api/img":
                final, ctype, raw = fetch(url, MAX_IMG, "image/*,*/*;q=0.5")
                ctype = ctype.split(";")[0].strip().lower()
                if not ctype.startswith("image/"):
                    return self._json(415, {"error": "not an image"})
                extra = {}
                if ctype == "image/svg+xml":  # SVG can carry script: lock it down
                    extra["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
                return self._send(200, raw, ctype, extra)
            return self._json(404, {"error": "unknown endpoint"})
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except urllib.error.HTTPError as e:
            return self._json(502, {"error": "Site answered HTTP %d" % e.code})
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as e:
            return self._json(502, {"error": "Could not reach site: %s" % getattr(e, "reason", e)})
        except Exception as e:  # never crash the server on one bad page
            return self._json(500, {"error": "Helper error: %s" % e})


def main():
    global ALLOW_PRIVATE, PORT
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--allow-private", action="store_true",
                    help="allow fetching private/loopback addresses (off by default)")
    args = ap.parse_args()
    ALLOW_PRIVATE, PORT = args.allow_private, args.port
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("LinkTrace helper listening on http://127.0.0.1:%d (Ctrl+C to stop)" % PORT, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
