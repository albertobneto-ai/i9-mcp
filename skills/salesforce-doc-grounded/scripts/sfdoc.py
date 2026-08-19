#!/usr/bin/env python3
"""
sfdoc.py — busca conteúdo REAL de documentação Salesforce, contornando SPA/JS.

Uso:
  python3 sfdoc.py <URL> [--links] [--html] [--max N] [--json]
  python3 sfdoc.py --toc atlas.en-us.apexcode.meta            # árvore completa de um guia developer
  python3 sfdoc.py --search "governor limits" atlas.en-us.apexcode.meta  # busca no TOC

Vias (tenta em ordem, nunca desiste sem passar por todas):
  A) developer.salesforce.com /docs/atlas.*  -> JSON API get_document_content (sem browser)
  B) developer.salesforce.com /docs/platform/*, architect.salesforce.com, resources.docs.salesforce.com/*.pdf
     -> HTTP direto (SSR) + strip HTML / pdftotext
  C) help.salesforce.com/s/articleView -> Chrome headless (Playwright), corpo via resposta Aura Content__c
     + links do TOC atravessando shadow DOM
  D) Fallback universal: Chrome headless + document.body.innerText

Saída padrão: TITLE / SOURCE_VIA / TEXT / (LINKS se --links). Exit 0 se conseguiu conteúdo, 2 se todas as vias falharam.
Cache: /tmp/sfdoc_cache/<sha1(url)>.json (24h).
"""
import sys, re, os, json, html, hashlib, time, argparse, subprocess, urllib.request, urllib.parse

CHROME = "/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome"
CACHE_DIR = "/tmp/sfdoc_cache"; os.makedirs(CACHE_DIR, exist_ok=True)
# WAF do developer.salesforce.com devolve 403 para UA de browser sem fingerprint; UA de curl passa (verificado 19/08/2026)
UA = {"User-Agent": "curl/8.5.0", "Accept": "*/*"}

def http_get(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()

def strip_html(h):
    h = re.sub(r'<(script|style|noscript)[^>]*>.*?</\1>', ' ', h, flags=re.S | re.I)
    h = re.sub(r'<br\s*/?>|</p>|</div>|</li>|</h\d>|</tr>', '\n', h, flags=re.I)
    h = re.sub(r'<[^>]+>', ' ', h)
    h = html.unescape(h)
    h = re.sub(r'[ \t]+', ' ', h)
    return re.sub(r'\n\s*\n+', '\n\n', h).strip()

def cache_get(url):
    p = os.path.join(CACHE_DIR, hashlib.sha1(url.encode()).hexdigest() + ".json")
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < 86400:
        return json.load(open(p))
def cache_put(url, obj):
    p = os.path.join(CACHE_DIR, hashlib.sha1(url.encode()).hexdigest() + ".json")
    json.dump(obj, open(p, "w"))

# ---------- VIA A: developer atlas JSON API ----------
_ver_cache = {}
def dev_version(deliv_meta):
    if deliv_meta in _ver_cache: return _ver_cache[deliv_meta]
    st, b = http_get(f"https://developer.salesforce.com/docs/get_document/{deliv_meta}")
    d = json.loads(b)
    v = d.get("version", {})
    ver = v.get("doc_version") if isinstance(v, dict) else v
    _ver_cache[deliv_meta] = (ver, d)
    return ver, d

def flatten_toc(toc, base, out, depth=0):
    for n in toc or []:
        href = n.get("a_attr", {}).get("href") or n.get("href") or ""
        out.append((depth, n.get("text", ""), href))
        flatten_toc(n.get("children"), base, out, depth + 1)

def via_dev_atlas(url):
    m = re.search(r'developer\.salesforce\.com/docs/(atlas\.([a-z]{2}-[a-z]{2})\.([^/.]+)\.meta)/([^/]+)/([^?#]+)', url)
    if not m: return None
    meta, locale, deliv, _, page = m.groups()
    ver, doc = dev_version(meta)
    api = f"https://developer.salesforce.com/docs/get_document_content/{deliv}/{page}/{locale}/{ver}"
    st, b = http_get(api)
    d = json.loads(b)
    content = d.get("content") or ""
    if not content.strip(): return None
    links = []
    for h in re.findall(r'href="([^"]+)"', content):
        if h.startswith("#") or h.startswith("http"): continue
        links.append((h, f"https://developer.salesforce.com/docs/{meta}/{deliv}/{h.split('#')[0]}"))
    return {"title": d.get("title", ""), "via": f"A:dev-json-api {api}", "html": content,
            "text": strip_html(content), "links": [{"text": t, "url": u} for t, u in links]}

# ---------- VIA B: SSR / PDF ----------
def via_ssr(url):
    host = urllib.parse.urlparse(url).netloc
    if not (host in ("developer.salesforce.com", "architect.salesforce.com", "resources.docs.salesforce.com", "docs.mulesoft.com", "trailhead.salesforce.com")):
        return None
    st, b = http_get(url)
    if url.lower().endswith(".pdf") or b[:4] == b"%PDF":
        pdf = "/tmp/sfdoc_tmp.pdf"; open(pdf, "wb").write(b)
        txt = subprocess.run(["pdftotext", "-layout", pdf, "-"], capture_output=True, text=True).stdout
        return {"title": os.path.basename(url), "via": "B:pdf", "html": "", "text": txt, "links": []} if txt.strip() else None
    h = b.decode("utf-8", "ignore")
    m = re.search(r'<(main|article)[^>]*>(.*)</\1>', h, re.S)
    body = m.group(2) if m else h
    txt = strip_html(body)
    # heurística: SPA vazio => texto curto
    if len(txt) < 400: return None
    t = re.search(r'<title>([^<]*)', h)
    base = f"https://{host}"
    links = []
    for lt, lh in re.findall(r'<a[^>]+href="([^"#]+)"[^>]*>(.*?)</a>', body, re.S):
        pass
    for lh, lt in re.findall(r'<a[^>]+href="([^"#]+)"[^>]*>(.*?)</a>', body, re.S):
        u = urllib.parse.urljoin(url, lh)
        if "salesforce.com" in u or "mulesoft.com" in u:
            links.append({"text": strip_html(lt)[:80], "url": u})
    return {"title": t.group(1).strip() if t else "", "via": "B:ssr-http", "html": body, "text": txt, "links": links}

# ---------- VIA C/D: headless ----------
def via_headless(url, is_help):
    import asyncio
    from playwright.async_api import async_playwright
    async def run():
        big = None
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
            pg = await b.new_page()
            async def on_resp(r):
                nonlocal big
                if "sfsites/aura" in r.url and r.request.resource_type in ("xhr", "fetch"):
                    try: t = await r.text()
                    except Exception: return
                    if "Content__c" in t and (big is None or len(t) > len(big)): big = t
            pg.on("response", on_resp)
            await pg.goto(url, wait_until="networkidle", timeout=120000)
            await pg.wait_for_timeout(2500)
            body_text = await pg.evaluate("document.body.innerText")
            title = await pg.title()
            links = await pg.eval_on_selector_all("a[href]", "els=>els.map(a=>[a.innerText.trim(),a.href])")
            await b.close()
        return big, body_text, title, links
    big, body_text, title, links = asyncio.run(run())
    out = {"title": title, "via": "D:headless-innerText", "html": "", "text": body_text, "links": []}
    if is_help and big:
        try:
            j = json.loads(big)
            for a in j["actions"]:
                rv = a.get("returnValue")
                rec = rv.get("returnValue", {}).get("record") if isinstance(rv, dict) and isinstance(rv.get("returnValue"), dict) else None
                if rec and rec.get("Content__c"):
                    out["html"] = rec["Content__c"]; out["text"] = strip_html(rec["Content__c"])
                    out["title"] = rec.get("Title__c") or rec.get("Name") or title
                    out["via"] = "C:help-aura-Content__c"; break
        except Exception as e:
            out["via"] += f" (aura parse fail: {e})"
    seen = set(); L = []
    for t, h in links:
        if not t or h in seen: continue
        if "articleView?id=" in h or "/docs/" in h or "architect.salesforce.com" in h:
            seen.add(h); L.append({"text": t[:80], "url": h})
    out["links"] = L
    return out if out["text"].strip() else None

def fetch(url):
    c = cache_get(url)
    if c: c["via"] += " [cache]"; return c
    tried = []
    for fn, args in ((via_dev_atlas, (url,)), (via_ssr, (url,)),
                     (via_headless, (url, "help.salesforce.com" in url))):
        try:
            r = fn(*args)
            if r: cache_put(url, r); return r
            tried.append(f"{fn.__name__}: sem conteúdo")
        except Exception as e:
            tried.append(f"{fn.__name__}: {type(e).__name__}: {str(e)[:120]}")
    return {"title": "", "via": "FALHOU em todas as vias", "text": "", "links": [], "errors": tried}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?")
    ap.add_argument("--links", action="store_true"); ap.add_argument("--html", action="store_true")
    ap.add_argument("--json", action="store_true"); ap.add_argument("--max", type=int, default=20000)
    ap.add_argument("--toc"); ap.add_argument("--search", nargs=2, metavar=("TERMO", "META"))
    a = ap.parse_args()
    if a.toc or a.search:
        meta = a.toc or a.search[1]
        ver, d = dev_version(meta)
        rows = []; flatten_toc(d.get("toc"), meta, rows)
        term = a.search[0].lower() if a.search else None
        deliv = meta.split(".")[2]
        for depth, text, href in rows:
            if term and term not in text.lower(): continue
            print(f"{'  '*depth}{text}  ->  https://developer.salesforce.com/docs/{meta}/{deliv}/{href}")
        print(f"# versão {ver} | {len(rows)} nós")
        return
    if not a.url: ap.error("URL obrigatória")
    r = fetch(a.url)
    if a.json: print(json.dumps(r, ensure_ascii=False)); sys.exit(0 if r["text"] else 2)
    print(f"TITLE: {r['title']}\nSOURCE_VIA: {r['via']}\nURL: {a.url}\n")
    if not r["text"]:
        print("ERROS:"); [print(" -", e) for e in r.get("errors", [])]; sys.exit(2)
    print(r["html"][:a.max] if a.html else r["text"][:a.max])
    if len(r["text"]) > a.max: print(f"\n[... truncado em {a.max} chars; use --max N]")
    if a.links:
        print(f"\nLINKS ({len(r['links'])}):")
        for l in r["links"]: print(f"  {l['text'][:55]:55} {l['url']}")

if __name__ == "__main__":
    import signal; signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    main()
