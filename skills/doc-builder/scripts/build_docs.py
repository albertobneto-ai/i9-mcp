#!/usr/bin/env python3
# build_docs.py — gera HTML dark monocromatico self-contained para os artefatos do Agente Funcional.
# Paleta monocromatica clara: fundo branco gelo #F2F3F5, superficies #FAFBFC/#ECECEC,
# texto #0D0D0D, mute #6B6B6B, borda #D9D9D9. Capa em gradiente escuro. Zero cor.

CSS = """
*{box-sizing:border-box;margin:0;padding:0}
:root{
--bg:#F2F3F5;--s1:#FAFBFC;--s2:#ECECEC;--s3:#D9D9D9;
--tx:#0D0D0D;--tx2:#3A3A3A;--mut:#6B6B6B;--bd:#D9D9D9;--bd2:#A8A8A8;
}
body{background:var(--bg);color:var(--tx);font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif;
font-size:14px;line-height:1.65;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:0 32px 80px}

/* capa */
.cover{background:linear-gradient(135deg,#0D0D0D 0%,#4A4A4A 100%);color:#FAFBFC;
padding:64px 32px 56px;margin-bottom:48px}
.cover-in{max-width:1080px;margin:0 auto}
.kicker{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#B8B8B8;margin-bottom:18px}
h1{font-size:34px;font-weight:600;line-height:1.2;letter-spacing:-.5px;margin-bottom:12px}
.sub{font-size:16px;color:#D4D4D4;font-weight:400;margin-bottom:28px;max-width:640px}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
background:rgba(250,251,252,.2);border:1px solid rgba(250,251,252,.2);margin-top:8px}
.meta div{background:rgba(250,251,252,.08);padding:12px 14px}
.meta dt{font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:#B8B8B8;margin-bottom:5px}
.meta dd{font-size:13px;color:#FAFBFC}

/* sumario */
.toc{background:var(--s1);border:1px solid var(--bd);padding:22px 26px;margin-bottom:48px}
.toc h2{font-size:11px;letter-spacing:2.2px;text-transform:uppercase;color:var(--mut);
margin-bottom:14px;font-weight:500}
.toc ol{list-style:none;columns:2;column-gap:36px}
.toc li{margin-bottom:7px;font-size:13px;break-inside:avoid}
.toc a{color:var(--tx2);text-decoration:none;border-bottom:1px solid transparent}
.toc a:hover{color:var(--tx);border-bottom-color:var(--bd2)}
.toc .n{color:var(--mut);font-variant-numeric:tabular-nums;margin-right:9px}

/* secoes */
section{margin-bottom:52px}
.sh{display:flex;align-items:center;gap:14px;padding-bottom:12px;
border-bottom:1px solid var(--bd2);margin-bottom:24px}
.sh .num{flex:0 0 34px;height:34px;border:1px solid var(--bd2);background:var(--s2);
display:flex;align-items:center;justify-content:center;font-size:13px;
font-variant-numeric:tabular-nums;color:var(--tx2)}
.sh h2{font-size:19px;font-weight:600;letter-spacing:-.2px}
h3{font-size:14px;font-weight:600;color:var(--tx);margin:26px 0 10px;
letter-spacing:.3px;text-transform:uppercase;font-size:11px;letter-spacing:2px;color:var(--mut)}
p{margin-bottom:12px;color:var(--tx2)}
strong{color:var(--tx);font-weight:600}
code{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12.5px;
background:var(--s2);border:1px solid var(--bd);padding:1px 6px;color:var(--tx)}

/* listas de passos */
ol.steps{list-style:none;counter-reset:s;margin:4px 0 8px}
ol.steps li{counter-increment:s;position:relative;padding:9px 0 9px 44px;
border-bottom:1px solid var(--bd);color:var(--tx2)}
ol.steps li:last-child{border-bottom:none}
ol.steps li::before{content:counter(s);position:absolute;left:0;top:9px;
width:26px;height:26px;border:1px solid var(--bd2);background:var(--s2);
display:flex;align-items:center;justify-content:center;
font-size:11px;color:var(--mut);font-variant-numeric:tabular-nums}

/* fluxo alternativo */
.alt{border-left:2px solid var(--bd2);background:var(--s1);padding:12px 16px;margin-bottom:10px}
.alt.fail{border-left-color:#6B6B6B;background:#ECECEC}
.alt .tag{display:inline-block;font-family:'SF Mono',Menlo,monospace;font-size:11px;
color:var(--tx);background:var(--s3);border:1px solid var(--bd2);padding:1px 7px;margin-right:9px}
.alt .ttl{font-weight:600;color:var(--tx);font-size:13.5px}
.alt p{margin:7px 0 0;font-size:13px}

/* tabelas */
table{width:100%;border-collapse:collapse;margin:14px 0 8px;font-size:12.5px}
thead th{background:#0D0D0D;color:#FAFBFC;text-align:left;padding:10px 12px;
font-size:9.5px;letter-spacing:1.4px;text-transform:uppercase;font-weight:600;
border-bottom:1px solid var(--bd2)}
tbody td{padding:9px 12px;border-bottom:1px solid var(--bd);color:var(--tx2);vertical-align:top}
tbody tr:nth-child(even) td{background:#ECECEC}
tbody tr:hover td{background:var(--s2)}
td.mono,th.mono{font-family:'SF Mono',Menlo,monospace;font-size:11.5px}

/* badges monocromaticos: peso e borda diferenciam, nunca cor */
.b{display:inline-block;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;
padding:2px 9px;border:1px solid var(--bd2);white-space:nowrap;font-weight:600}
.b-solid{background:var(--tx);color:#FAFBFC;border-color:var(--tx)}
.b-mid{background:var(--s3);color:var(--tx)}
.b-out{background:transparent;color:var(--mut);border-style:dashed}

/* kpi */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;
background:var(--bd);border:1px solid var(--bd);margin:8px 0 20px}
.kpi{background:#FAFBFC;padding:16px 14px}
.kpi .l{font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:var(--mut);margin-bottom:6px}
.kpi .v{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1}
.kpi.hi{background:#E2E2E2}

/* callout */
.call{border:1px solid var(--bd);border-left-width:3px;background:var(--s1);
padding:14px 18px;margin:16px 0}
.call .cl{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--mut);margin-bottom:6px}
.call p{margin:0;font-size:13px}
.call.strong{border-left-color:var(--tx)}
.call.mid{border-left-color:var(--bd2)}

/* diagrama */
figure{margin:22px 0;background:var(--s1);border:1px solid var(--bd);padding:24px 20px 16px}
figure svg{display:block;width:100%;height:auto}
figcaption{font-size:11px;color:var(--mut);text-align:center;margin-top:14px;
padding-top:12px;border-top:1px solid var(--bd)}

/* perguntas */
.q{border:1px solid var(--bd);background:var(--s1);padding:14px 18px;margin-bottom:10px}
.q .qi{font-family:'SF Mono',Menlo,monospace;font-size:11px;color:var(--mut);margin-bottom:5px}
.q .qt{color:var(--tx);font-weight:600;font-size:13.5px;margin-bottom:7px}
.q .qd{font-size:12.5px;color:var(--tx2)}
.q .qd b{color:var(--mut);font-weight:600;font-size:9.5px;letter-spacing:1.4px;
text-transform:uppercase;display:block;margin-bottom:3px}

/* cartao de componente — substitui tabela larga */
.comps{display:grid;gap:10px;margin:14px 0}
.comp{border:1px solid var(--bd);background:var(--s1);padding:14px 16px}
.comp.criar{border-left:3px solid var(--tx)}
.comp.estender{border-left:3px solid var(--bd2)}
.comp.reusar{border-left:3px solid #C4C4C4}
.comp-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.comp-h .id{font-family:'SF Mono',Menlo,monospace;font-size:11px;color:var(--mut);min-width:22px}
.comp-h .nm{font-size:14px;font-weight:600;color:var(--tx)}
.comp-h .tp{font-size:11px;color:var(--mut);border:1px solid var(--bd);padding:1px 7px}
.comp-h .st{margin-left:auto}
.comp dl{display:grid;grid-template-columns:104px 1fr;gap:5px 14px;font-size:12.5px}
.comp dt{color:var(--mut);font-size:9.5px;letter-spacing:1.3px;text-transform:uppercase;padding-top:2px}
.comp dd{color:var(--tx2)}
.comp .desc{font-size:13px;color:var(--tx2);margin:0 0 11px;line-height:1.6}
.links{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;padding-top:11px;border-top:1px solid var(--bd)}
.lk{font-size:11.5px;color:var(--tx);text-decoration:none;border:1px solid var(--bd2);
padding:3px 10px;background:var(--s1);white-space:nowrap}
.lk:hover{border-color:var(--tx);background:var(--s2)}
.lk.doc{border-style:dashed}
@media print{.lk{border-style:solid;background:none}}
/* navegacao fixa */
.navbar{position:sticky;top:0;z-index:20;background:rgba(242,243,245,.94);
backdrop-filter:blur(8px);border-bottom:1px solid var(--bd);margin:0 -32px 32px;padding:9px 32px;
display:flex;gap:4px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.navbar a{flex:0 0 auto;font-size:11px;color:var(--mut);text-decoration:none;
padding:5px 11px;border:1px solid transparent;white-space:nowrap}
.navbar a:hover{color:var(--tx);border-color:var(--bd2)}
.navbar a .n{font-variant-numeric:tabular-nums;margin-right:6px;opacity:.65}
section{scroll-margin-top:56px}
@media print{.navbar{display:none}}

.grp{display:flex;align-items:center;gap:12px;margin:26px 0 12px}
.grp .gl{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--mut)}
.grp .gc{font-size:11px;color:var(--tx);border:1px solid var(--bd2);padding:1px 8px}
.grp .gr{flex:1;height:1px;background:var(--bd)}
@media(max-width:700px){.comp dl{grid-template-columns:1fr}.comp dt{padding-top:8px}}

footer{border-top:1px solid var(--bd2);margin-top:60px;padding-top:20px;
display:flex;justify-content:space-between;font-size:9.5px;letter-spacing:1.6px;
text-transform:uppercase;color:var(--mut)}

@page{size:A4;margin:16mm 14mm}
@media print{
 body{background:#fff}
 .cover{page-break-after:always}
 section,figure,table,.alt,.q{page-break-inside:avoid}
 .toc{page-break-after:always}
}
"""

# ---------- SVG helpers (monocromatico) ----------
SVG_DEFS = """<defs>
<marker id="ar" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
<path d="M0,0 L9,4.5 L0,9 z" fill="#6B6B6B"/></marker>
<marker id="arw" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
<path d="M0,0 L9,4.5 L0,9 z" fill="#0D0D0D"/></marker>
</defs>"""

def actor(x, y, label, sub=""):
    """Boneco UML monocromatico."""
    s = f'<circle cx="{x}" cy="{y}" r="9" fill="none" stroke="#0D0D0D" stroke-width="1.5"/>'
    s += f'<line x1="{x}" y1="{y+9}" x2="{x}" y2="{y+32}" stroke="#0D0D0D" stroke-width="1.5"/>'
    s += f'<line x1="{x-13}" y1="{y+18}" x2="{x+13}" y2="{y+18}" stroke="#0D0D0D" stroke-width="1.5"/>'
    s += f'<line x1="{x}" y1="{y+32}" x2="{x-11}" y2="{y+50}" stroke="#0D0D0D" stroke-width="1.5"/>'
    s += f'<line x1="{x}" y1="{y+32}" x2="{x+11}" y2="{y+50}" stroke="#0D0D0D" stroke-width="1.5"/>'
    s += f'<text x="{x}" y="{y+68}" text-anchor="middle" fill="#0D0D0D" font-size="12" font-family="Inter,Arial">{label}</text>'
    if sub:
        s += f'<text x="{x}" y="{y+83}" text-anchor="middle" fill="#6B6B6B" font-size="10" font-family="Inter,Arial">{sub}</text>'
    return s

def ucase(cx, cy, rx, ry, label, lines=None):
    """Elipse de caso de uso."""
    s = f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="#FFFFFF" stroke="#6B6B6B" stroke-width="1.2"/>'
    ls = lines or [label]
    start = cy - (len(ls)-1)*7
    for i, t in enumerate(ls):
        s += f'<text x="{cx}" y="{start+i*14+4}" text-anchor="middle" fill="#0D0D0D" font-size="11.5" font-family="Inter,Arial">{t}</text>'
    return s

def box(x, y, w, h, title, rows=None, strong=False):
    """Caixa de entidade / componente."""
    fill = "#ECECEC" if strong else "#FFFFFF"
    st = "#0D0D0D" if strong else "#A8A8A8"
    s = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" stroke="{st}" stroke-width="1.2"/>'
    s += f'<rect x="{x}" y="{y}" width="{w}" height="26" fill="#F2F3F5" stroke="{st}" stroke-width="1.2"/>'
    s += f'<text x="{x+10}" y="{y+17}" fill="#0D0D0D" font-size="11.5" font-family="Inter,Arial" font-weight="600">{title}</text>'
    for i, r in enumerate(rows or []):
        s += f'<text x="{x+10}" y="{y+44+i*16}" fill="#3A3A3A" font-size="10.5" font-family="SF Mono,Menlo,monospace">{r}</text>'
    return s

def arrow(x1, y1, x2, y2, label="", dashed=False, white=False):
    d = ' stroke-dasharray="4 3"' if dashed else ''
    col = "#0D0D0D" if white else "#6B6B6B"
    mk = "arw" if white else "ar"
    s = f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{col}" stroke-width="1.2"{d} marker-end="url(#{mk})"/>'
    if label:
        mx, my = (x1+x2)/2, (y1+y2)/2
        s += f'<rect x="{mx-len(label)*3.2}" y="{my-9}" width="{len(label)*6.4}" height="16" fill="#F2F3F5"/>'
        s += f'<text x="{mx}" y="{my+3}" text-anchor="middle" fill="#6B6B6B" font-size="9.5" font-family="Inter,Arial">{label}</text>'
    return s

def lanes(x, y, w, names, row_h=110):
    """Raias horizontais rotuladas. Devolve (markup, faixa) onde faixa[i] e o
    centro vertical da raia i — use para posicionar step() e arrow()."""
    lane_label_w = 118
    out = ""
    faixa = []
    for i, n in enumerate(names):
        ty = y + i * row_h
        out += (f'<rect x="{x}" y="{ty}" width="{lane_label_w}" height="{row_h}" '
                f'fill="#F2F3F5" stroke="#A8A8A8" stroke-width="1.2"/>')
        out += (f'<rect x="{x+lane_label_w}" y="{ty}" width="{w-lane_label_w}" height="{row_h}" '
                f'fill="#FFFFFF" stroke="#A8A8A8" stroke-width="1.2"/>')
        out += (f'<text x="{x+lane_label_w/2}" y="{ty+row_h/2+4}" text-anchor="middle" '
                f'fill="#0D0D0D" font-size="11" font-family="Inter,Arial" font-weight="600">{n}</text>')
        faixa.append(ty + row_h / 2)
    return out, faixa


def step(cx, cy, label, w=132, h=44, kind="acao"):
    """Passo dentro de uma raia. kind: 'acao' (retangulo), 'decisao' (losango),
    'inicio' (arredondado) ou 'fim' (arredondado com traco grosso)."""
    half_w, half_h = w / 2, h / 2
    if kind == "decisao":
        pts = f"{cx},{cy-half_h} {cx+half_w},{cy} {cx},{cy+half_h} {cx-half_w},{cy}"
        s = f'<polygon points="{pts}" fill="#FFFFFF" stroke="#6B6B6B" stroke-width="1.2"/>'
    elif kind in ("inicio", "fim"):
        sw = "2" if kind == "fim" else "1.2"
        s = (f'<rect x="{cx-half_w}" y="{cy-half_h}" width="{w}" height="{h}" rx="{half_h}" '
             f'fill="#ECECEC" stroke="#0D0D0D" stroke-width="{sw}"/>')
    else:
        s = (f'<rect x="{cx-half_w}" y="{cy-half_h}" width="{w}" height="{h}" '
             f'fill="#FFFFFF" stroke="#6B6B6B" stroke-width="1.2"/>')
    palavras, linhas, atual = label.split(), [], ""
    for p in palavras:
        if len(atual + " " + p) > 20 and atual:
            linhas.append(atual); atual = p
        else:
            atual = (atual + " " + p).strip()
    if atual:
        linhas.append(atual)
    inicio = cy - (len(linhas) - 1) * 6
    for i, t in enumerate(linhas):
        s += (f'<text x="{cx}" y="{inicio+i*13+4}" text-anchor="middle" fill="#0D0D0D" '
              f'font-size="10.5" font-family="Inter,Arial">{t}</text>')
    return s


def svg(w, h, body):
    return (f'<svg viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg" '
            f'preserveAspectRatio="xMidYMid meet">{SVG_DEFS}{body}</svg>')

# ---------- shell ----------
def page(title, subtitle, meta, toc, body):
    m = "".join(f"<div><dt>{k}</dt><dd>{v}</dd></div>" for k, v in meta)
    t = "".join(f'<li><a href="#s{i}"><span class="n">{i:02d}</span>{n}</a></li>'
                for i, n in toc)
    nb = "".join(f'<a href="#s{i}"><span class="n">{i:02d}</span>{n}</a>' for i, n in toc)
    return f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body>
<div class="cover"><div class="cover-in">
<div class="kicker">ALGAR · CRM B2B</div>
<h1>{title}</h1><p class="sub">{subtitle}</p>
<dl class="meta">{m}</dl></div></div>
<div class="wrap">
<div class="navbar">{nb}</div>
<nav class="toc"><h2>Conteúdo</h2><ol>{t}</ol></nav>
{body}
<footer><span>ALGAR — {title}</span><span>Confidencial — Uso Interno</span></footer>
</div></body></html>"""

def section(i, name, inner):
    return (f'<section id="s{i}"><div class="sh"><div class="num">{i:02d}</div>'
            f'<h2>{name}</h2></div>{inner}</section>')

def table(headers, rows, mono_cols=()):
    th = "".join(f"<th>{h}</th>" for h in headers)
    tb = ""
    for r in rows:
        tds = "".join(
            f'<td class="mono">{c}</td>' if j in mono_cols else f"<td>{c}</td>"
            for j, c in enumerate(r))
        tb += f"<tr>{tds}</tr>"
    return f"<table><thead><tr>{th}</tr></thead><tbody>{tb}</tbody></table>"

def kpis(items):
    h = ""
    for lab, val, hi in items:
        h += f'<div class="kpi{" hi" if hi else ""}"><div class="l">{lab}</div><div class="v">{val}</div></div>'
    return f'<div class="kpis">{h}</div>'

def callout(label, text, strong=False):
    return (f'<div class="call {"strong" if strong else "mid"}">'
            f'<div class="cl">{label}</div><p>{text}</p></div>')

def fig(svg_markup, caption):
    return f"<figure>{svg_markup}<figcaption>{caption}</figcaption></figure>"

def question(qid, text, default):
    return (f'<div class="q"><div class="qi">{qid}</div><div class="qt">{text}</div>'
            f'<div class="qd"><b>Default assumido</b>{default}</div></div>')


def comp_card(cid, passo, nome, tipo, veredito, descricao, requisito,
              org_url=None, org_label=None, doc_url=None, doc_label=None):
    """Cartao de componente da especificacao funcional.
    descricao: o que o componente e, em uma ou duas frases.
    requisito: o que precisa acontecer nele para atender o caso de uso.
    """
    k = veredito.lower()
    cls = "criar" if k == "criar" else ("estender" if k in ("estender", "substituir") else "reusar")
    bcl = "b-solid" if k == "criar" else ("b-mid" if k in ("estender", "substituir") else "b-out")
    links = ""
    if org_url:
        links += f'<a class="lk" href="{org_url}" target="_blank" rel="noopener">{org_label or "Abrir na org"}</a>'
    if doc_url:
        links += f'<a class="lk doc" href="{doc_url}" target="_blank" rel="noopener">{doc_label or "Documentação oficial"}</a>'
    lk = f'<div class="links">{links}</div>' if links else ""
    return (f'<div class="comp {cls}"><div class="comp-h">'
            f'<span class="id">{cid}</span><span class="nm">{nome}</span>'
            f'<span class="tp">{tipo}</span>'
            f'<span class="st"><span class="b {bcl}">{veredito}</span></span></div>'
            f'<p class="desc">{descricao}</p>'
            f'<dl><dt>Passo</dt><dd>{passo}</dd>'
            f'<dt>Para atender</dt><dd>{requisito}</dd></dl>{lk}</div>')

def group(label, count):
    return (f'<div class="grp"><span class="gl">{label}</span>'
            f'<span class="gc">{count}</span><span class="gr"></span></div>')
