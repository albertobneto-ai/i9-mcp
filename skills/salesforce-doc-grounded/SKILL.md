---
name: salesforce-doc-grounded
description: Ground every Salesforce answer in primary documentation before replying. Use whenever the user asks a concrete technical or functional question about the Salesforce ecosystem — Sales Cloud, Service Cloud, Revenue Cloud, RLM, CPQ, Billing, Order Management (OM), MuleSoft, Data Cloud, Marketing Cloud, Experience Cloud — including standard objects (Lead, Opportunity, Account, Contact, Quote, Order, Asset, Contract), pricing/quoting concepts (cotação, precificação, price rules, decomposição/decomposition), Apex, SOQL, Flow, Lightning, LWC, metadata API, REST/SOAP API, object models, permission sets, license types, sharing model, release behavior, Sales Map, governor limits, or any platform feature. Trigger even when the user does not say "documentation" explicitly — concrete how-X-works, relationship-between-Y-and-Z, can-I-do-W, troubleshooting, or design-decision questions all qualify. Do NOT trigger for casual mentions like "I work with Salesforce" with no question attached.
---

# Salesforce Documentation-Grounded Answering

This skill exists because the user is a Salesforce architect who relies on Claude for decisions that go into real customer implementations. Wrong information has real cost: misconfigured object models, wasted dev cycles, or — worst — advice that contradicts how the platform actually behaves in a given release. The user has been explicit: never assume, never invent, never paraphrase from memory.

The user works in **Brazilian Portuguese** and their answers must be in Portuguese, but Salesforce official documentation is in English. We keep citations in their original English to preserve technical terms (e.g., "Quote Line", "Order Product", "Contract Line Item") that have no consecrated Portuguese translation and where mistranslation would mislead.

## The source hierarchy

When answering a Salesforce question, consult sources in this order:

1. **Project documents** — the user keeps curated Salesforce reference documents pre-loaded in the Claude Project. These are typically Portuguese-translated extracts of Salesforce Developer Guides, organized by module (e.g., RLM Spring '26 reference). Search these first.
2. **Official Salesforce documentation** — anything under `*.salesforce.com` (developer.salesforce.com, help.salesforce.com, architect.salesforce.com, trailhead.salesforce.com, salesforce.stackexchange is NOT official). Use the `web_search` and `web_fetch` tools.
3. **General knowledge** — only as a clearly-labeled supplement when neither of the above covers the question.

### Conflict resolution

If a project document and official Salesforce documentation disagree, **the official documentation wins**, but flag the conflict explicitly to the user. Project documents may be from an older release, may have been translated with errors, or may describe a customer-specific implementation that does not match standard platform behavior. The user wants to know when this happens — they may need to update their reference materials.

Example phrasing when conflict appears:
> "⚠️ Conflito detectado: o documento do projeto `RLM_PriceRules.md` indica X, mas a documentação oficial (Spring '26) indica Y. Estou seguindo a fonte oficial. Vale revisar o material do projeto."

### When nothing covers it

If neither project documents nor official Salesforce docs cover the question, you may complement with general knowledge — but **label it explicitly as não-documentado**. Example:

> "Não encontrei isso na documentação oficial nem nos documentos do projeto. Pelo padrão de design da plataforma, o comportamento esperado seria [...]. Trate como hipótese — recomendo validar em sandbox antes de aplicar."

This protects the user from acting on speculation while still giving them a starting point.


## ⚠️ REGRA OBRIGATÓRIA — como LER uma página Salesforce (SPA não renderiza no web_fetch)

`help.salesforce.com` e `developer.salesforce.com/docs/atlas.*` são SPAs: `web_fetch` devolve só o shell HTML (título "Salesforce Help"/"Salesforce Developers" e zero conteúdo). **NUNCA** responder "a página não renderizou" / "não consegui acessar". Para QUALQUER URL de documentação Salesforce, usar o helper da skill — ele tenta 4 vias em cascata e só falha se todas falharem:

```bash
python3 /mnt/skills/user/salesforce-doc-grounded/scripts/sfdoc.py "<URL>" --links            # texto + links da página
python3 /mnt/skills/user/salesforce-doc-grounded/scripts/sfdoc.py "<URL>" --html --max 60000 # HTML bruto (tabelas)
python3 /mnt/skills/user/salesforce-doc-grounded/scripts/sfdoc.py --toc atlas.en-us.apexcode.meta          # árvore completa de um guia developer
python3 /mnt/skills/user/salesforce-doc-grounded/scripts/sfdoc.py --search "governor" atlas.en-us.apexcode.meta  # achar a página certa pelo TOC
python3 /mnt/skills/user/salesforce-doc-grounded/scripts/sfdoc.py --trailhead "revenue cloud pricing"   # busca no catálogo Trailhead; depois ler a URL com o helper
```

Vias (verificadas em 19/08/2026):
| Via | Domínio | Mecanismo | Browser? |
|---|---|---|---|
| A | `developer.salesforce.com/docs/atlas.<loc>.<deliv>.meta/<deliv>/<pag>.htm` | JSON API pública: `GET /docs/get_document_content/<deliv>/<pag>.htm/<loc>/<versão>`; versão e TOC em `GET /docs/get_document/atlas.<loc>.<deliv>.meta` | Não |
| B | `developer.salesforce.com/docs/platform/*`, `architect.salesforce.com`, `docs.mulesoft.com`, PDFs `resources.docs.salesforce.com` | HTTP direto (SSR) + strip HTML / `pdftotext` | Não |
| C | `help.salesforce.com/s/articleView?id=...` | Chrome headless (Playwright, `/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/`), intercepta resposta Aura `/s/sfsites/aura` campo `Content__c` (HTML do artigo) + links do TOC via seletor Playwright (atravessa shadow DOM — `document.querySelectorAll` NÃO enxerga) | Sim (~30-60s) |
| D | qualquer | Chrome headless + `document.body.innerText` | Sim |
| E | `trailhead.salesforce.com` | Conteúdo de trail/módulo/unidade é **público e SSR** (não precisa login — login só conta badge/progresso) → via B lê direto. Busca no catálogo: `--trailhead "termo"` usa o GraphQL público `POST https://trailhead.salesforce.com/services/mobile/graphql` (query `indexPageSearch`) — sem browser, sem credencial. Links de um módulo listam as unidades; links de uma trail listam os módulos. Um 404 no Trailhead é conteúdo RETIRADO/URL mudada (não bloqueio) → buscar de novo com `--trailhead`. Nunca usar credenciais do usuário para automatizar Trailhead (desnecessário + viola ToS). | Não |

Armadilhas conhecidas:
- WAF do `developer.salesforce.com` devolve **403 para User-Agent de browser** vindo de script sem fingerprint; UA `curl/8.5.0` passa. O helper já usa isso — não trocar.
- IDs de artigo do help têm prefixo de deliverable: `ind.` (Industries/Revenue Cloud), `sf.`, `sales.`, `data.`, `ai.`, `platform.`, `release-notes.`; a URL `help.salesforce.com/articleView?id=X&type=5` (sem `/s/`) redireciona 301 para `/s/articleView?...&language=en_US`.
- Navegação recursiva: pegar URLs do bloco `LINKS` e chamar o helper de novo. Cache 24h em `/tmp/sfdoc_cache/`.
- Se o helper retornar `FALHOU em todas as vias` (exit 2), aí sim declarar `[NÃO VERIFICADO]` citando o erro de cada via — nunca antes disso.

Quando citar, `SOURCE_VIA` informa qual mecanismo entregou o conteúdo; a URL citada ao usuário continua sendo a URL canônica (help/developer), não a do endpoint interno.

## The workflow

For every Salesforce technical/functional question, follow these steps in order. Do not skip them, even if you "think you know" the answer — the whole point of this skill is to break that habit.

### 1. Search project documents first

The Claude Project has pre-loaded reference documents. Search them by topic keywords matching the user's question. Look at filenames first — they're typically named by module (e.g., `RLM_Bundles.md`, `CPQ_PriceRules.md`). If the user is asking about RLM bundles, the most relevant doc is probably already named for it.

Read the relevant section, not the whole file. Quote the exact passage you'll rely on.

### 2. Search official Salesforce documentation

Even if step 1 found something, **also check official docs** when:
- The project document is older than the current release (the user noted Spring '26 as the most recent processed version — anything newer must be web-checked)
- The question touches on API behavior, governor limits, or anything version-sensitive
- The project document is ambiguous or seems incomplete on the specific point

Use `web_search` with queries scoped to Salesforce — e.g., `site:developer.salesforce.com "Quote Line" object reference` or `site:help.salesforce.com Revenue Cloud bundle configuration`. When the search surfaces a relevant page, read it with `scripts/sfdoc.py` (see REGRA OBRIGATÓRIA above) — `web_fetch` returns an empty SPA shell for help/developer docs. Never trust the snippet and never report "page did not render".

Acceptable official domains:
- `developer.salesforce.com` — API references, object reference, Apex docs, Data Cloud developer guides
- `help.salesforce.com` — admin/end-user docs, setup guides, Sales Cloud / Service Cloud / OM configuration
- `architect.salesforce.com` — architecture patterns, well-architected framework, decomposition patterns
- `trailhead.salesforce.com` — modules/trails (use only when no other source applies; Trailhead is teaching content, not reference)
- `resources.docs.salesforce.com` — release notes PDFs and Developer Guides
- `docs.mulesoft.com` — MuleSoft / Anypoint Platform documentation (MuleSoft is owned by Salesforce; this is the official source for MuleSoft technical content even though it's not under `salesforce.com`)
- `salesforce.com/products/...` and `salesforce.com/news/...` — acceptable for product positioning and feature announcements, but for technical claims always prefer the developer/help/architect domains above

**Not** acceptable as primary sources: salesforce.stackexchange.com, Salesforce Ben, Apex Hours, Medium posts, blog posts. These can be useful for context but never cited as the basis for a technical claim.

### 3. Build the answer with explicit citations

Every technical claim in the answer must have a citation that points to the source. Use this format:

```
[Claim in Portuguese].

> "[Original English passage from the source]"
> — [Source name + section], [URL]
```

For project documents:
```
[Claim in Portuguese].

> "[Trecho original do documento do projeto]"
> — Documento do projeto: `nome_do_arquivo.md`, seção [...]
```

If a single answer pulls from multiple sources, cite each one separately at the point it's used — don't lump all sources at the end.

### 4. Be explicit about what you didn't find

If part of the user's question wasn't covered by any source, say so directly. Do not paper over gaps. Example:

> "Sobre a parte (a) da sua pergunta, encontrei: [resposta com citação].
> Sobre a parte (b), não localizei referência oficial nem nos documentos do projeto — posso buscar mais especificamente se você confirmar [...]"

## Output format

Structure answers like this:

```
[Resposta direta em português, com afirmações técnicas seguidas das citações.]

**Fontes consultadas:**
- [Doc do projeto X, se usado]
- [URL oficial Y, se usado]
- [Marcação clara se algo veio de conhecimento não-documentado]
```

Keep the answer focused — the user is an architect, not a beginner. Avoid restating what they already know unless it's load-bearing for the answer.

## What this skill is NOT

- It is not a license to refuse questions. If documentation exists, find it and answer. The user is frustrated by both made-up answers AND by Claude bailing out with "I'm not sure, please check the docs."
- It is not a search-everything-always rule. For trivial clarifications inside an ongoing conversation where the source was already cited, you don't need to re-fetch the same page. Use judgment.
- It is not for casual mentions. If the user says "tomorrow I have a meeting about Salesforce" — that's not a technical question. Don't trigger the workflow.

## Examples

**Example 1 — concrete RLM question:**

User: "Qual é a diferença entre Quote Line e Order Product no Revenue Cloud?"

Action: Search project docs for files matching "Quote", "Order", "RLM" → read relevant sections → cross-check with `developer.salesforce.com` object reference for both objects → answer in Portuguese with object-reference quotes for each, plus URLs.

**Example 2 — release-sensitive question:**

User: "O Pricing Procedure aceita múltiplas Price Rules em paralelo na Spring '26?"

Action: Even if the project doc covers Pricing Procedures, this is release-specific — go to release notes / official docs directly. Cite the release notes URL and the specific paragraph.

**Example 3 — gap case:**

User: "Como o RLM lida com bundle nesting de mais de 5 níveis?"

Action: Search project docs and official docs. If neither specifies a hard limit, say so explicitly: "Não encontrei limite documentado para profundidade de nesting de bundles. A documentação oficial cobre [...] mas é silente sobre o limite específico. Recomendo validar em sandbox e/ou abrir caso no Salesforce Support antes de assumir."

**Example 4 — casual mention (do NOT trigger):**

User: "Cara, comecei na Salesforce em 2018, é uma loucura como mudou."

Action: This is conversational. Just chat. No documentation lookup needed.

**Example 5 — cross-cloud question (Sales Cloud + OM + RLM):**

User: "Quando o Opportunity vira Order via decomposição no Order Management, o que acontece com os Quote Lines? Eles viram Order Products direto ou passam por algum objeto intermediário?"

Action: This crosses Sales Cloud (Opportunity), Revenue Cloud quoting (Quote/Quote Line), and Order Management (Order/Order Product) plus the decomposition concept. Search project docs for each module separately, then cross-check on `developer.salesforce.com` object reference for the relationship fields, then check `help.salesforce.com` and `architect.salesforce.com` for the decomposition flow. Answer with object-by-object citation.
