---
name: arch-design
description: "Gerador de Desenho de Arquitetura Salesforce, terceira etapa do Agente Funcional, produzido depois da especificação funcional aprovada. Use SEMPRE que o usuário digitar '/arq' — trigger PRIMÁRIO. Também ativa com: 'desenho de arquitetura', 'documento de arquitetura', 'solution architecture', 'arquitetura da solução', 'ADR salesforce', ou quando uma sessão do Agente Funcional estiver em APROVADO_MAPA. Produz documento fundamentado no Well-Architected Framework (Trusted, Easy, Adaptable) e no manual do projeto, com diagramas de contexto e componentes, modelagem de dados, mapeamento de integrações, análise de governor limits, desempenho e volumetria, modelo de segurança e sharing, ADRs numeradas, estratégia de ambientes e riscos arquiteturais. NÃO use para história funcional (uc-generator) nem para mapa de componentes (component-map)."
---

# Desenho de Arquitetura — Salesforce

## Posição no fluxo

```
requisito → história funcional → especificação funcional → DESENHO DE ARQUITETURA
             (/uc, jornada)        (/map, o como)            (/arq, por quê e a que custo)
```

A história diz **o que** acontece. A especificação diz **quais componentes**. O desenho de arquitetura diz **por que assim**, **a que custo** e **o que quebra em escala**.

Não repita o conteúdo dos dois anteriores. Referencie e avance.

## Fundamento

Duas fontes, nesta ordem:

1. **Manual do projeto** — `/mnt/project/sfarchitect-manual-genio.html`. Leia antes de escrever. Traz os pilares Well-Architected, a hierarquia de decisão, LDV e índices, árvore de automação, padrões de integração, governor limits como restrição de desenho, e anti-padrões.
2. **architect.salesforce.com** e a documentação oficial, via `sfdoc.py`. Nunca cite URL que não abriu.

O algoritmo de decisão do manual, na ordem:

| # | Pergunta |
|---|---|
| 1 | Qual valor de negócio e qual risco, nos três pilares? |
| 2 | Já existe OOTB? Configuro? Só então construo? |
| 3 | Quem é o system of record deste dado? |
| 4 | O modelo escala em LDV, índices e sharing skew? |
| 5 | Qual ferramenta de automação e por quê? |
| 6 | O acesso é intencional e fechável? |
| 7 | Qual padrão de integração — direção, sincronismo, volume? Idempotente? |
| 8 | Se for código, cabe nos governor limits no volume real? |
| 9 | Como isso vive em ambientes, CI/CD e ADR? Que dívida cria? |

## Estrutura — 12 seções

### 01. Contexto e escopo
O problema em três parágrafos, o que está dentro e fora, e o diagrama de contexto: atores, sistemas externos e a fronteira da solução.

### 02. Princípios e critérios de decisão
Os três pilares aplicados a este caso, não em abstrato. Para cada pilar, o que ele exige aqui e o que se sacrifica.

### 03. Visão de componentes
Diagrama em camadas do que compõe a solução. Distinga o que é nativo, o que é configuração e o que é código. Marque a fronteira de cada produto envolvido.

### 04. Modelo de dados
Diagrama de entidades com cardinalidade. Para cada objeto: quem é o system of record, o volume esperado, os campos usados em filtro e se eles são indexáveis. Declare junction objects, master-detail e as consequências de sharing de cada escolha.

### 05. Automação
Para cada comportamento, a ferramenta escolhida e a justificativa pela árvore de decisão. Declare a ordem de execução quando houver mais de um mecanismo no mesmo objeto.

### 06. Segurança e sharing
Modelo de acesso: OWD, papéis, sharing rules, permission sets. Onde o código roda `with sharing` e onde não. FLS e o que acontece quando falta.

### 07. Integrações
Uma linha por integração: sistema, direção, padrão, sincronismo, volume, formato, autenticação, idempotência e tratamento de erro. Se não houver integração, diga que não há em vez de omitir a seção.

### 08. Desempenho e volumetria
Volume atual e projetado por objeto. Onde a seletividade de consulta importa. O que muda a partir de LDV. Índices necessários e por quê.

### 09. Governor limits
Tabela dos limites que este desenho toca, com o orçamento por transação. Não liste limites que não são atingidos.

### 10. Decisões de arquitetura
ADRs numeradas. Cada uma: contexto, opções consideradas, decisão, consequência aceita. **Mínimo de três opções por decisão**, com o motivo do descarte. Sem alternativa avaliada não é decisão, é preferência.

### 11. Ambientes e entrega
Caminho da mudança entre orgs, o que exige janela, o que é reversível e como. Rollback declarado antes da execução.

### 12. Riscos e dívida assumida
Risco com probabilidade, impacto e mitigação. Dívida técnica que este desenho cria de propósito, e a condição que a torna pagável.

## Pisos

Riscos arquiteturais 8 · ADRs 3, cada uma com 3 opções · Governor limits avaliados 4 · Integrações mapeadas, todas · Anti-padrões evitados, declarados.

## Identidade visual

Gerado pela skill `doc-builder`, mesma paleta branco gelo, marca ALGAR. Diagramas SVG monocromáticos: contexto, camadas de componentes, entidades e fluxo de integração.

## Registro

Tom corporativo com nuance técnica, escrito por um arquiteto para quem vai construir e para quem vai aprovar o investimento.

- Decisão antes de justificativa. "Automação em Flow after-save. Apex só na consulta, por causa de X."
- Quantifique quando puder. "Cabe em 12 das 100 consultas por transação" vale mais que "cabe nos limites".
- Nomeie o trade-off aceito. Arquitetura sem trade-off declarado é propaganda.
- Sem hedge, sem entusiasmo, sem enumerar benefício.
- Uma ideia por frase.

## Proibido

Repetir o mapa de componentes · listar limites não atingidos · ADR com uma única opção · diagrama sem legenda · "melhores práticas" sem dizer qual · risco sem mitigação.
