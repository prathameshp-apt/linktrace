# LinkTrace search backend: local SearXNG

This folder bundles a **local-only** SearXNG meta-search instance for the
OSINT VM. LinkTrace's search panel calls it directly over `localhost` --
no external server, no API keys, no per-user config.

Why local instead of a public instance or a live-embedded page:

- Public search engines (Google, Bing, Yandex, Startpage, ...) send
  headers that block being shown inside another page's iframe -- that's
  enforced by the browser, not something any front-end code can get
  around.
- Routing an investigator's queries through *your* own public server
  would mean you can see everything anyone using the VM searches for.
  Running it inside the VM itself means queries never leave the box
  except to reach the search engines being aggregated -- same as if the
  person had typed the search into a normal browser.
- Since this is *your* server, you control the response headers, so
  results can be embedded/read directly with no restriction.

## One-time setup (bake this into the VM image)

Requires Docker + Docker Compose (`sudo apt install docker.io docker-compose-plugin`
on Debian/Ubuntu-based VMs, already true for most OSINT VM bases) and
Python 3 (already present on nearly every Linux/macOS install; see the
Windows section below).

```bash
cd osint-vm
./start.sh
```

This brings up the search backend -- see "Quick start" below for
details, or run `docker compose up -d` by hand.

Check it's alive:

```bash
curl "http://127.0.0.1:8888/search?q=test&format=json" | head -c 300
```

You should see JSON, not a `403` and not an HTML page. If you get `403`,
`settings.yml` didn't mount correctly -- re-check the volume path in
`docker-compose.yml`.

### Windows

The main LinkTrace app (`index.html` + `js/`) needs no setup at all on
Windows -- it's plain HTML/CSS/JS, open the file in any browser and the
graph, evidence, and network lookup all work with no install
step, no Docker, nothing. This backend (SearXNG) is the one piece that
needs a runtime, and SearXNG's own maintainers are direct about this:
they don't support running it natively on Windows -- Docker is the
supported path there, not an OSINT-VM-specific choice.

1. Install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/)
   (uses WSL2 under the hood -- the installer sets that up if it isn't
   already enabled).
2. Open **PowerShell** in the `osint-vm` folder and run the same command
   as above:
   ```powershell
   docker compose up -d
   ```
3. Verify with the same `curl` check above (PowerShell 7+ has `curl` as
   a `curl.exe`/`Invoke-WebRequest` alias; either works), or just open
   `http://127.0.0.1:8888/search?q=test&format=json` directly in a
   browser tab and confirm you see JSON.
4. To have it start automatically: open Docker Desktop settings ->
   General -> enable "Start Docker Desktop when you sign in to your
   computer." The `restart: unless-stopped` policy already in
   `docker-compose.yml` then brings the container back up whenever
   Docker itself starts, same as the Linux auto-start section below.

If Docker Desktop is a dealbreaker for a given machine, the rest of
LinkTrace still works without this backend running at all -- the "Live
results" search tab will say the backend isn't reachable rather than
failing silently, and everything else (graph, evidence,
Network lookup's RDAP/IP geolocation, the link-out Lookup tools) is
unaffected, since none of those depend on SearXNG.

## Auto-start with the VM

So the person doesn't have to remember to run `docker compose up` every
boot, enable the systemd unit (or your VM's init system's equivalent)
so Docker itself starts on boot and the `restart: unless-stopped` policy
in the compose file brings the container back up automatically:

```bash
sudo systemctl enable docker
```

## What LinkTrace calls

`GET http://127.0.0.1:8888/search?q=<query>&format=json`

Returns JSON with a `results` array of `{title, url, content, ...}`.
LinkTrace's `js/livesearch.js` fetches this directly and renders results
inline in the search panel -- see that file for the actual wiring.

## Updating

```bash
cd osint-vm
docker compose pull
docker compose up -d
```

## Network lookup (RDAP + IP geolocation)

Separate from SearXNG, the "Network lookup" section of the search panel
(`js/netlookup.js`) queries two public, no-key infrastructure services
directly from the browser -- no local backend needed for this part:

- **RDAP** (`https://rdap.org`) -- the IANA-run, standardized successor
  to WHOIS. Returns the same registrar/registration-date/nameserver data
  a `whois example.com` terminal command prints, as structured JSON.
- **IP geolocation** (`http://ip-api.com`) -- resolves an IP to its
  network location (country/city/ISP/ASN), the same class of data a
  `traceroute` or network diagnostic tool surfaces. Free tier is
  non-commercial use only and does not require HTTPS to be reachable.

Both are deliberately a different category of tool from anything that
enumerates personal accounts (see the note on holehe-style tools in the
project history) -- they only ever return public registry/network
records for a domain or IP, never anything about a person's accounts,
credentials, or activity on third-party sites.

If a query returns nothing, it's usually one of: the domain genuinely
isn't registered, the TLD hasn't deployed a public RDAP server yet
(rare, being phased out), or your network/browser is blocking the
outbound request -- these calls go straight from the person's browser
to rdap.org / ip-api.com, so they need outbound internet access same as
any other page resource.

## Quick start (recommended)

```bash
cd osint-vm
./start.sh      # brings up the SearXNG search backend and checks it answers
./stop.sh       # stops it again when you're done with a case
```

Re-running `start.sh` is safe (it won't start a second copy). To run it
by hand instead: `docker compose up -d`.

LinkTrace does not route any traffic anonymously. If IP-level anonymity
matters for a case, handle that at the network/VM level (Tor Browser, a
VPN, or a dedicated VM network) -- see the OPSEC panel's notes.

## Security notes for VM builders

- The compose file binds `127.0.0.1:8888:8080` -- **not** `0.0.0.0`.
  Don't change this unless you specifically want the search backend
  reachable from outside the VM (you almost certainly don't).
- `server.limiter: false` in `settings.yml` is safe here specifically
  *because* it's local-only and single-user. If you ever do expose this
  beyond the VM, turn the limiter back on and put a real reverse proxy
  with TLS in front of it (see SearXNG's own docs for that setup) --
  this stripped-down config is not meant for public exposure.
- `server.secret_key` is a placeholder generated once for this image.
  If you're building your own VM image from this, regenerate it:
  `python3 -c "import secrets; print(secrets.token_hex(32))"`
- The engine list intentionally does not include credential-dump, hash-
  cracking, or breach-forum sources (e.g. Dehashed, LeakCheck, Snusbase,
  onion breach mirrors). Wiring those in would make LinkTrace surface
  other people's stolen passwords/PII on request, which isn't something
  this project will do. The one exception, "Have I Been Pwned", is
  handled separately as a plain link-out (js/config.js: BREACH_CHECK_TOOLS)
  because it only ever confirms whether a value appears in a known
  breach -- it never returns leaked data itself.


## LinkTrace helper (page previews + image extraction)

`linktrace_helper.py` is a single-file, standard-library-only Python 3 server
(no `pip install`) that `start.sh` launches next to SearXNG on
`http://127.0.0.1:8899`. It exists because browsers forbid two things no
front-end code can get around: framing sites that send `X-Frame-Options` /
CSP headers, and reading another site's HTML across origins.

What it gives LinkTrace:

- **Preview that works on (almost) any site** -- the entity preview shows a
  script-free snapshot of the page instead of a blank frame. Use **Live** in
  the preview bar to try the real page, **Open** for a new tab.
- **Image extraction** -- the **Images** button in the preview (and on every
  search result) lists every picture on the page; send one or all of them to
  the selected entity's **Image palette**. Search results also get their photo
  automatically (untick *Page thumbnails* in the search panel to turn this off).
- **Image proxy** -- thumbnails load through the helper with no Referer, which
  beats hotlink protection.

Run it by hand (also the way on Windows, no Docker needed for this part):

```bash
python3 osint-vm/linktrace_helper.py          # or: py osint-vm\linktrace_helper.py
```

Safety: listens on 127.0.0.1 only; refuses requests from other web origins and
unexpected Host headers; refuses to fetch loopback / private / link-local
addresses (on every redirect) unless started with `--allow-private`; never runs
anything it downloads. Limits: it does not execute JavaScript, so pages built
entirely client-side look sparse, and sites that bot-wall non-browser traffic
may return a block page. Fetches come from *this machine's* IP -- if that
matters for your case, run the VM behind your usual VPN/Tor setup.


## Optional: account checks (Holehe, Ignorant, Maigret)

Three open-source tools run through the local helper. Type the value into the **search panel** — it detects what it is and offers the tool as a chip under the
search box (click a chip to switch it on; it then runs on every search of that kind of value):

| Entity type | Tool | Question it answers |
|---|---|---|
| E-mail | [Holehe](https://github.com/megadose/holehe) | Which sites have an account for this address? |
| Phone (`+<country code> ...`) | [Ignorant](https://github.com/megadose/ignorant) | Is this number registered on Instagram / Amazon / Snapchat? |
| Username | [Maigret](https://github.com/soxoj/maigret) | Which sites have a profile with this exact name? |

```bash
cd osint-vm
python3 -m venv .venv                                   # needed on Kali/Debian/Ubuntu (PEP 668)
.venv/bin/pip install -r requirements-accounts.txt      # install only the ones you want if you prefer
./stop.sh && ./start.sh                                 # start.sh uses .venv automatically
curl http://127.0.0.1:8899/api/health                   # shows which of the three are ready
```

What you should know before using them:

- Each check sends the identifier to third-party sites **from this machine's IP**. You always get a
  confirmation dialog first; nothing runs in the background.
- Holehe's password-recovery modules (can e-mail the account owner) and adult-site modules are **off by
  default**, with explicit tick-boxes.
- Maigret only searches the exact username you typed (recursion and page crawling are switched off, and
  it does not download a fresh site list on start). A username is often shared by different people:
  every hit is a **lead**, stored as *unverified*.
- "Found" can occasionally be wrong; "not found" is weak evidence (blocked or failed checks can look like
  "no account", so only hits are listed and the rest are counts).
- Results can be added as **evidence** (one item per hit) and/or as **entities** linked under the original.
- Use them only on identifiers you are authorised to investigate.
