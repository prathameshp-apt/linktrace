"""
Account-existence checks for the LinkTrace helper (all optional, all streamed as NDJSON):

  holehe   e-mail    -> which sites have an account for this address      (pip install holehe)
  ignorant phone     -> is this number registered on Instagram/Amazon/Snapchat (pip install ignorant)
  maigret  username  -> which sites have a profile with this name          (pip install maigret)

Each run sends the identifier to third-party sites from THIS machine's IP, so the
browser always asks for confirmation first. Stream format, one JSON object per line:
  {"type":"start","total":N}                     N = 0 when the tool can't tell in advance
  {"type":"result","name","domain","status":"found|notfound|unknown","url"?,...}
  {"type":"warn","text":"..."}
  {"type":"done","found":a,"notfound":b,"unknown":c}
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlparse

import holehe_bridge

LOCKS = {"holehe": holehe_bridge.LOCK, "ignorant": threading.Lock(), "maigret": threading.Lock()}
PIP = {"holehe": "holehe", "ignorant": "ignorant", "maigret": "maigret"}

# calling codes ignorant understands (taken from its own Snapchat table)
CODES = set("1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98 211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 248 249 250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 268 269 290 291 297 298 299 350 351 352 353 354 355 356 357 358 359 370 371 372 373 374 375 376 377 378 380 381 382 385 386 387 389 420 421 423 500 501 502 503 504 505 506 507 508 509 590 591 592 593 594 595 596 597 598 599 670 672 673 674 675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692 850 852 853 855 856 880 886 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 992 993 994 995 996 998".split())
USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{1,63}$")


def available(tool):
    try:
        if tool == "holehe":
            return holehe_bridge.available()
        if tool == "ignorant":
            import ignorant.core, httpx, trio  # noqa: F401
            return True
        if tool == "maigret":
            import maigret  # noqa: F401
            return True
    except Exception:
        pass
    return False


def split_phone(raw):
    """'+91 98765-43210' -> ('91', '9876543210'); None when the country code can't be told."""
    raw = (raw or "").strip()
    digits = re.sub(r"\D", "", raw)
    if not raw.startswith("+") or not (7 <= len(digits) <= 15):
        return None
    for n in (3, 2, 1):
        if digits[:n] in CODES and 5 <= len(digits) - n <= 12:
            return digits[:n], digits[n:]
    return None


def validate(tool, q):
    """-> (kwargs, error)"""
    get = lambda k, d="": (q.get(k) or [d])[0].strip()
    if tool == "holehe":
        email = get("email")
        if not holehe_bridge.valid_email(email):
            return None, "That is not a valid e-mail address"
        return {"email": email, "include_adult": get("adult") == "1", "include_recovery": get("recovery") == "1"}, None
    if tool == "ignorant":
        parts = split_phone(get("phone"))
        if not parts:
            return None, "Enter the number in international form, e.g. +91 98765 43210"
        return {"country": parts[0], "phone": parts[1]}, None
    if tool == "maigret":
        u = get("username")
        if not USERNAME_RE.match(u):
            return None, "Usernames can only contain letters, digits, . _ - (2-64 characters)"
        sites = get("sites", "500")
        if sites not in ("200", "500", "all"):
            return None, "sites must be 200, 500 or all"
        return {"username": u, "sites": sites}, None
    return None, "unknown tool"


def run(tool, kw, write):
    if tool == "holehe":
        return holehe_bridge.stream(kw["email"], kw["include_adult"], kw["include_recovery"], write)
    if tool == "ignorant":
        return _ignorant(kw["country"], kw["phone"], write)
    if tool == "maigret":
        return _maigret(kw["username"], kw["sites"], write)


def _ignorant(country, phone, write, timeout=10):
    import httpx
    import trio
    import ignorant.core as core

    mods = core.import_submodules("ignorant.modules")
    funcs = [mods[m].__dict__[m.split(".")[-1]] for m in mods if len(m.split(".")) > 3]
    out, done = [], threading.Event()

    def runner():
        async def main():
            client = httpx.AsyncClient(timeout=timeout)
            try:
                async with trio.open_nursery() as nursery:
                    for f in funcs:
                        nursery.start_soon(core.launch_module, f, phone, country, client, out)
            finally:
                await client.aclose()
        try:
            trio.run(main)
        except Exception:
            pass
        finally:
            done.set()

    threading.Thread(target=runner, daemon=True).start()
    write({"type": "start", "total": len(funcs), "note": "+%s %s" % (country, phone)})
    best, sent = {}, 0
    rank = {"unknown": 0, "notfound": 1, "found": 2}
    while True:
        finished = done.is_set()
        snap = list(out)
        while sent < len(snap):
            item = holehe_bridge._map(snap[sent])
            sent += 1
            prev = best.get(item["name"])
            if prev is not None and rank[item["status"]] <= rank[prev]:
                continue
            best[item["name"]] = item["status"]
            write(item)
        if finished and sent >= len(out):
            break
        time.sleep(0.2)
    c = {"found": 0, "notfound": 0, "unknown": 0}
    for s in best.values():
        c[s] += 1
    write({"type": "done", **c})


_FOUND = re.compile(r"^\[\+\]\s+(.+?):\s+(https?://\S+)\s*$")
_TOTAL = re.compile(r"search on (?:top )?(\d+) sites", re.I)


def _maigret(username, sites, write):
    work = tempfile.mkdtemp(prefix="lt-maigret-")
    cmd = [sys.executable, "-u", "-m", "maigret", username, "--no-color", "--no-progressbar",
           "--no-recursion",          # only the name that was typed, never names it discovers
           "--no-extracting",         # don't crawl found pages for extra data
           "--no-autoupdate",         # no phoning home to refresh the site list
           "--dns-resolver", "threaded", "--timeout", "10", "--retries", "1", "-n", "30",
           "--folderoutput", work]
    cmd += ["-a"] if sites == "all" else ["--top-sites", sites]
    limit = 1500 if sites == "all" else 300
    proc = subprocess.Popen(cmd, cwd=work, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    killer = threading.Timer(limit, proc.kill)
    killer.start()
    found, started, warned = 0, False, set()
    try:
        write({"type": "start", "total": 0})
        for line in proc.stdout:
            line = line.rstrip("\n")
            m = _FOUND.match(line)
            if m:
                name, url = m.group(1).strip(), m.group(2)
                if "maigret" in name.lower() and "http" not in url:
                    continue
                found += 1
                write({"type": "result", "name": name, "domain": urlparse(url).netloc.lower().replace("www.", ""),
                       "url": url, "status": "found"})
                continue
            t = _TOTAL.search(line)
            if t and not started:
                started = True
                write({"type": "start", "total": int(t.group(1))})
            elif line.startswith("[!] Too many errors") and line[:60] not in warned:
                warned.add(line[:60])
                write({"type": "warn", "text": line[4:200]})
        proc.wait()
        write({"type": "done", "found": found, "notfound": 0, "unknown": 0})
    finally:
        killer.cancel()
        if proc.poll() is None:
            proc.kill()
        shutil.rmtree(work, ignore_errors=True)
