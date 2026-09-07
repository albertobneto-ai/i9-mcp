---
name: doc-builder
description: "Identidade visual dos documentos do Agente Funcional — história funcional (/uc) e especificação funcional (/map). Use SEMPRE que for gerar o HTML de um desses dois artefatos, ou quando o usuário pedir 'documento formatado do agente funcional', 'gerar o HTML da história funcional', 'gerar o HTML da especificação funcional'. Fornece o builder Python com paleta monocromática branco gelo, capa em gradiente escuro, diagramas SVG (ator UML, fluxo em raias, modelo de dados, pilha de componentes), cartões de componente agrupados por veredito e navegação fixa. NÃO use para documento Word (use formatacao-word-every) nem para dossiê de evidências (template próprio)."
---

# Identidade visual — documentos do Agente Funcional

## Regra

Todo HTML de história funcional e de especificação funcional é gerado pelo `scripts/build_docs.py` desta skill. Não escreva CSS à mão, não invente paleta, não mude a marca.

```python
import sys
sys.path.insert(0, '/mnt/skills/user/doc-builder/scripts')   # ou onde a skill estiver
from build_docs import page, section, table, kpis, callout, fig, question, \
                       comp_card, group, actor, ucase, box, arrow, svg
```

Se o arquivo não estiver disponível, baixe do repo antes de gerar qualquer coisa:

```bash
TOK=$(cat /tmp/gh_token.txt)
mkdir -p /home/claude/doc-builder
curl -s -H "Authorization: token $TOK" \
 "https://api.github.com/repos/albertobneto-ai/i9-mcp/contents/skills/doc-builder/scripts/build_docs.py" \
 | python3 -c "import sys,json,base64; d=json.load(sys.stdin); \
   open('/home/claude/doc-builder/build_docs.py','wb').write(base64.b64decode(d['content'])); print('ok')"
```

## Paleta — monocromática, branco gelo, zero cor

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#F2F3F5` | fundo do documento — **branco gelo** |
| `--s1` | `#FAFBFC` | superfície de cartão e sumário |
| `--s2` | `#ECECEC` | superfície secundária, zebra de tabela |
| `--s3` | `#D9D9D9` | preenchimento de selo |
| `--tx` | `#0D0D0D` | texto principal |
| `--tx2` | `#3A3A3A` | corpo de parágrafo |
| `--mut` | `#6B6B6B` | rótulo, legenda, número de seção |
| `--bd` | `#D9D9D9` | borda |
| `--bd2` | `#A8A8A8` | borda de destaque |

Capa: gradiente `#0D0D0D → #4A4A4A`, texto `#FAFBFC`. É a única área escura do documento.

**Nenhuma cor.** Nada de azul, roxo, verde ou vermelho — nem em selo, nem em callout, nem em diagrama. A hierarquia vem de peso, tom de cinza e estilo de borda.

## Marca

- Kicker da capa: `ALGAR · CRM B2B`
- Rodapé: `ALGAR — <título>` à esquerda, `Confidencial — Uso Interno` à direita

**Proibido:** "Ever i9", "Everymind", "Algar Telecom". É **ALGAR**, sem sobrenome.

## Diagramas

Todos em SVG inline, monocromáticos, gerados pelos helpers:

- `actor(x, y, label, sub)` — boneco UML
- `ucase(cx, cy, rx, ry, label, lines)` — elipse de caso de uso
- `box(x, y, w, h, title, rows, strong)` — entidade ou componente
- `arrow(x1, y1, x2, y2, label, dashed, white)` — associação
- `svg(w, h, body)` — envelope com os markers de seta

**História funcional** leva diagrama de casos de uso (ator, fronteira tracejada, `<<include>>` e `<<extend>>`) e fluxo em raias.
**Especificação funcional** leva modelo de dados e pilha de componentes em camadas.

Na pilha, o preenchimento marca o veredito: sólido `#0D0D0D` = criar, `#ECECEC` = estender, branco = reusar.

## Componentes de layout

- `page(title, subtitle, meta, toc, body)` — capa, navegação fixa, sumário em duas colunas, rodapé
- `section(i, name, inner)` — seção numerada com cabeçalho
- `table(headers, rows, mono_cols)` — tabela com cabeçalho preto
- `kpis([(label, valor, destaque)])` — faixa de números
- `callout(label, texto, strong)` — bloco com borda-esquerda
- `fig(svg, legenda)` — diagrama com legenda
- `question(id, texto, default)` — pergunta em aberto
- `comp_card(...)` + `group(label, n)` — cartão de componente agrupado por veredito

**Nunca use tabela larga para o mapa de componentes.** Nove colunas não cabem em tela nem em papel. Use `comp_card` agrupado por `group`, na ordem Criar → Estender → Reusar → Descartar.

## Impressão

`@page A4`, margem 16mm × 14mm. A capa quebra página, o sumário quebra página, e seção, figura, tabela, fluxo alternativo e pergunta não quebram no meio. A navegação fixa some na impressão.

## Léxico

Diga **"requer validação do componente"**, nunca "exige validação humana".
