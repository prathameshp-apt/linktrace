"""
Optional bridge between the LinkTrace helper and Holehe (pip install holehe).

Holehe asks ~110 websites whether an e-mail address already has an account
there (sign-up / password-reset forms answer differently for known and
unknown addresses). It does not log in, does not read mail and does not touch
any breach data -- but it DOES send the address to those sites, from this
machine's IP.  Two groups of modules are therefore OFF unless asked for:

  * password-recovery modules (adobe, mail_ru, odnoklassniki, samsung): they
    start a real password-reset flow, which can e-mail the account owner
  * adult-site modules: a hit reveals something sensitive about a person

The helper streams one JSON object per line (NDJSON):
  {"type":"start","total":N}
  {"type":"result","name":..,"domain":..,"status":"found|notfound|unknown",...}
  {"type":"done","found":a,"notfound":b,"unknown":c}
"""
import re
import threading
import time

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9\-]{1,63}(\.[A-Za-z0-9\-]{1,63}){0,5}\.[A-Za-z]{2,24}$")
ADULT = {"pornhub", "xnxx", "xvideos", "redtube"}
RECOVERY = {"adobe", "mail_ru", "odnoklassniki", "samsung"}
LOCK = threading.Lock()          # one run at a time: every run fans out ~110 requests


def valid_email(s):
    return bool(s) and len(s) <= 254 and bool(EMAIL_RE.match(s))


def available():
    try:
        import holehe.core  # noqa: F401
        import httpx        # noqa: F401
        import trio         # noqa: F401
        return True
    except Exception:
        return False


def _functions(include_adult, include_recovery):
    import holehe.core as core
    mods = core.import_submodules("holehe.modules")
    funcs = []
    for m in mods:
        if len(m.split(".")) > 3:
            site = m.split(".")[-1]
            if site in ADULT and not include_adult:
                continue
            if site in RECOVERY and not include_recovery:
                continue
            funcs.append(mods[m].__dict__[site])
    return funcs


def _map(r):
    if r.get("rateLimit"):
        status = "unknown"            # blocked / errored / timed out: NOT the same as "no account"
    elif r.get("exists"):
        status = "found"
    else:
        status = "notfound"
    return {
        "type": "result", "name": r.get("name"), "domain": r.get("domain"), "status": status,
        "recovery_email": r.get("emailrecovery"), "phone": r.get("phoneNumber"),
    }


def stream(email, include_adult, include_recovery, write, timeout=10):
    """Run the checks, calling write(obj) for each result as it arrives."""
    import holehe.core as core
    import httpx
    import trio

    funcs = _functions(include_adult, include_recovery)
    out, done = [], threading.Event()

    def runner():
        async def main():
            client = httpx.AsyncClient(timeout=timeout)
            try:
                async with trio.open_nursery() as nursery:
                    for f in funcs:
                        nursery.start_soon(core.launch_module, f, email, client, out)
            finally:
                await client.aclose()
        try:
            trio.run(main)
        except Exception:
            pass
        finally:
            done.set()

    threading.Thread(target=runner, daemon=True).start()
    write({"type": "start", "total": len(funcs)})
    best, sent = {}, 0               # best status per site (a few modules report twice)
    rank = {"unknown": 0, "notfound": 1, "found": 2}
    while True:
        finished = done.is_set()
        snapshot = list(out)
        while sent < len(snapshot):
            item = _map(snapshot[sent])
            sent += 1
            prev = best.get(item["name"])
            if prev is not None and rank[item["status"]] <= rank[prev]:
                continue             # duplicate or weaker report for a site we already have
            best[item["name"]] = item["status"]
            write(item)
        if finished and sent >= len(out):
            break
        time.sleep(0.2)
    counts = {"found": 0, "notfound": 0, "unknown": 0}
    for st in best.values():
        counts[st] += 1
    write({"type": "done", **counts})
