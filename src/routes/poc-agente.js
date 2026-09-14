// src/routes/poc-agente.js — cérebro do Agentforce do protótipo.
// Recebe a pergunta do usuário e um resumo do estado da sessão; responde com Claude Opus
// (raciocínio estendido, com queda para Sonnet), ancorado no UC-VPN-001 Revisão 1, nas
// regras do produto e no mapa de objetos do Salesforce. O modelo não executa nada: ele
// devolve texto e, no máximo, três ações escolhidas de uma lista fechada que o protótipo
// sabe executar. Assim o raciocínio é livre e o efeito colateral é controlado.
import express from 'express';

const router = express.Router();
const API = 'https://api.anthropic.com/v1/messages';
const OPUS = 'claude-opus-4-6';
const SONNET = 'claude-sonnet-4-6';

// Ações que o protótipo sabe executar. O modelo só pode escolher entre estas.
export const ACOES = [
  'criar_cotacao', 'configurar_produto', 'abrir_configurador', 'continuar_configuracao',
  'gerar_proposta', 'aceite_proposta', 'criar_contrato', 'criar_pedido', 'ativar_pedido',
  'submeter_pedido', 'andamento_plano', 'concluir_plano', 'ver_assets', 'abrir_procedencia',
  'abrir_cotacao', 'abrir_pedido', 'abrir_contrato', 'abrir_lead', 'converter_lead',
  'abrir_relatorios', 'abrir_dashboard', 'nada'
];

const REGRAS_UC = process.env.POC_UC_BRIEF || '';

const SISTEMA = `Você é o Agentforce dentro de um protótipo navegável do Salesforce Revenue Cloud,
usado para validar com a área de negócio o caso de uso UC-VPN-001 (produto VPN Node) da Algar Telecom.
Fale português do Brasil, em tom direto e curto — no máximo 5 frases, sem listas longas, sem markdown pesado.

COMO PENSAR
- Raciocine sobre o estado real da sessão que vem em ESTADO: o que já existe, o que falta, o que uma regra bloqueia.
- Quando a pergunta for sobre configuração, cite a regra pelo identificador (R01…R22) e diga o efeito dela em palavras.
- Quando for sobre o Salesforce, use o nome de API correto do objeto. Se não tiver certeza do nome, diga que não tem certeza.
- Se a pergunta pedir algo já concluído, diga que já está feito e ofereça o passo seguinte. Nunca proponha refazer.
- Se a resposta depender de decisão de negócio que a Revisão 1 não define (ordem entre proposta, aceite e contrato; preço;
  pós-venda de amend/renew/cancel), diga isso claramente em vez de inventar.

HONESTIDADE
- Marque como [inferido] tudo que for proposta do projeto e não esteja no UC nem na documentação oficial:
  produtos técnicos da decomposição, etapas do plano de orquestração, correspondência de regra para ExpressionSet.
- Nunca afirme que o protótipo fez algo que não está no ESTADO. Não invente números, nomes de API, campos ou telas.

FORMATO DA RESPOSTA — responda SOMENTE com um JSON válido, sem cercas de código:
{"resposta":"texto curto em pt-BR","fonte":"origem em poucas palavras ou vazio","acoes":[{"acao":"<uma das permitidas>","rotulo":"texto curto do botão"}]}
No máximo 3 ações, e só ações que façam sentido no estado atual. Se nenhuma fizer sentido, mande "acoes": [].
Ações permitidas: ${ACOES.join(', ')}.

CONTEXTO DO PRODUTO (UC-VPN-001 Revisão 1)
${REGRAS_UC}

MAPA DE OBJETOS DO SALESFORCE USADO PELO PROTÓTIPO
Lead/Account/Contact/Opportunity na conversão; Quote, QuoteLineItem, QuoteLineGroup, QuoteLineRelationship;
QuoteDocument na proposta; Contract e ContractDocument; Order, OrderItem, OrderAction, OrderItemRelationship,
OrderDeliveryGroup; FulfillmentOrder e FulfillmentOrderLineItem na decomposição [inferido para este produto];
Asset, AssetAttribute, AssetAction, AssetActionSource, AssetStatePeriod, AssetContractRelationship;
no catálogo, Product2, ProductRelatedComponent, ProductComponentGroup, ProductCategory, ProductSellingModel,
AttributeDefinition, AttributePicklist, ProductAttributeSet; preço em Pricebook2 e PricebookEntry.`;

async function chamar(model, mensagens, pensar) {
  const body = {
    model,
    max_tokens: pensar ? 3000 : 1200,
    system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
    messages: mensagens,
  };
  if (pensar) body.thinking = { type: 'enabled', budget_tokens: 1600 };
  const r = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${model} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const texto = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const pensamento = (d.content || []).filter(b => b.type === 'thinking').map(b => b.thinking || '').join('\n').trim();
  return { texto, pensamento, modelo: model };
}

function extrairJson(t) {
  if (!t) return null;
  const limpo = t.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(limpo); } catch (e) {}
  const i = limpo.indexOf('{'), j = limpo.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(limpo.slice(i, j + 1)); } catch (e) {} }
  return null;
}

router.post('/agente', async (req, res) => {
  const { pergunta, estado, historico } = req.body || {};
  if (!pergunta || String(pergunta).length > 2000) return res.status(400).json({ error: 'pergunta inválida' });
  if (!process.env.ANTHROPIC_KEY) return res.status(503).json({ error: 'sem chave de modelo configurada' });

  const conversa = (Array.isArray(historico) ? historico.slice(-6) : []).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 1200),
  }));
  conversa.push({
    role: 'user',
    content: `ESTADO DA SESSÃO (JSON):\n${JSON.stringify(estado || {}).slice(0, 6000)}\n\nPERGUNTA DO USUÁRIO:\n${pergunta}`,
  });

  try {
    let r;
    try { r = await chamar(OPUS, conversa, true); }
    catch (e) { console.error('[poc-agente] Opus falhou, indo de Sonnet:', e.message); r = await chamar(SONNET, conversa, false); }
    const j = extrairJson(r.texto);
    if (!j || !j.resposta) return res.json({ resposta: r.texto || 'Não consegui formular a resposta.', acoes: [], modelo: r.modelo });
    const acoes = (Array.isArray(j.acoes) ? j.acoes : [])
      .filter(a => a && ACOES.includes(a.acao) && a.acao !== 'nada')
      .slice(0, 3)
      .map(a => ({ acao: a.acao, rotulo: String(a.rotulo || '').slice(0, 40) || a.acao }));
    res.json({
      resposta: String(j.resposta).slice(0, 1500),
      fonte: j.fonte ? String(j.fonte).slice(0, 120) : '',
      acoes,
      modelo: r.modelo,
      raciocinio: r.pensamento ? r.pensamento.slice(0, 1200) : '',
    });
  } catch (e) {
    console.error('[poc-agente] falhou:', e.message);
    res.status(502).json({ error: e.message });
  }
});

export default router;
