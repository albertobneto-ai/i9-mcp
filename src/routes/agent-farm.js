// src/routes/agent-farm.js — Farm de Agentes de IA (Ever i9)
// Agentes de IA criados por nós (NÃO Agentforce), conectados à org arqevery.
// Cada agente tem um contexto especializado e USA FERRAMENTAS REAIS: consulta (SOQL) e
// altera/cria (DML) registros de verdade na org via tool-use da IA.
import express from 'express';
import jsforce from 'jsforce';
import { authMiddleware } from '../middleware/auth.js';
import pool from '../config/db.js';

const router = express.Router();
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const WRITE_ORGS = new Set([36]); // só arqevery permite escrita (HOMOL/DevEvery = read-only)

async function getOrgById(id) {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return r.rows[0];
}
async function connToOrg(org) {
  const conn = new jsforce.Connection({ loginUrl: org.login_url, version: '62.0' });
  await conn.login(org.username, org.password + (org.security_token || ''));
  return conn;
}

// ───────── Prateleira: agentes pré-configurados (contexto genial por domínio) ─────────
const BEHAV =
  '\n\nCOMO VOCÊ OPERA: você é um agente OPERACIONAL conectado à org Salesforce arqevery. ' +
  'Quando o usuário pedir algo, USE AS FERRAMENTAS para fazer de verdade na org — não apenas explique. ' +
  'Responda sempre em português do Brasil, curto e objetivo. NUNCA invente Ids, números ou dados: sempre consulte a org com soql_query. ' +
  'Para alterar/criar, execute a ação e confirme o resultado real (Id + campos). Se faltar um dado obrigatório, pergunte antes de agir. ' +
  'Ao listar registros, apresente em lista curta e legível (não despeje JSON).';

const LEAD_CTX =
  'Você é {NAME}, agente de IA especialista em LEADS B2B da Algar Telecom, conectado à arqevery. ' +
  'Domínio: objeto Lead. Campos úteis: Id, Name, FirstName, LastName, Company, Title, Email, Phone, MobilePhone, ' +
  'Status, LeadSource, Rating, Industry, NumberOfEmployees, AnnualRevenue, City, State, CreatedDate, OwnerId, Owner.Name, IsConverted. ' +
  'Padrões de ação: "liste/mostre minhas leads" → soql_query SELECT Id,Name,Company,Status,Rating,Phone,Email,CreatedDate FROM Lead ' +
  'WHERE IsConverted=false ORDER BY CreatedDate DESC LIMIT 20. ' +
  '"altere o telefone/e-mail/status da lead X" → se não tiver o Id, ache com soql_query por Name/Company; depois update_record no objeto Lead. ' +
  '"crie uma lead" → create_record (LastName e Company são obrigatórios). ' +
  'Qualificação BANT (Budget, Authority, Need, Timeline); priorize Rating=Hot; alerte leads sem atividade recente. ' +
  'Foco de mercado: Triângulo Mineiro, interior de SP, Goiás e oeste de MG.';

const OPP_CTX =
  'Você é {NAME}, agente de IA especialista em OPORTUNIDADES (pipeline) B2B da Algar, conectado à arqevery. ' +
  'Domínio: objeto Opportunity. Campos: Id, Name, AccountId, Account.Name, StageName, Amount, CloseDate, Probability, ' +
  'ForecastCategoryName, OwnerId, NextStep, CreatedDate. ' +
  'Padrões: "meu pipeline" → soql_query agregando por StageName ou listando abertas (StageName NOT IN (\'Closed Won\',\'Closed Lost\')) ORDER BY CloseDate. ' +
  '"mova o estágio/atualize o valor/próximo passo da opp X" → ache o Id e update_record. Aponte riscos (close date vencida, sem next step).';

const ACCT_CTX =
  'Você é {NAME}, agente de IA especialista em CONTAS (Account) B2B da Algar, conectado à arqevery. ' +
  'Campos: Id, Name, CNPJ__c, Industry, Phone, Website, BillingCity, BillingState, OwnerId, Type, AnnualRevenue. ' +
  'Padrões: "liste/busque contas" → soql_query; "atualize telefone/site/dados da conta X" → ache Id e update_record; ' +
  '"crie uma conta" → create_record (Name obrigatório). Dê a visão 360 quando pedirem sobre uma conta.';

const SERVICE_CTX =
  'Você é {NAME}, agente de IA especialista em ATENDIMENTO (Case) da Algar, conectado à arqevery. ' +
  'Campos: Id, CaseNumber, Subject, Status, Priority, ContactId, AccountId, Origin, CreatedDate, OwnerId. ' +
  'Padrões: "liste os casos abertos" → soql_query WHERE Status != \'Closed\'; "mude o status/prioridade/dono do caso X" → update_record; ' +
  'resuma casos e sugira próximo passo.';

const STATIC_AGENTS = [
  { id: 'lead', name: 'Léo', domain: 'Lead', color: '#0176D3', emoji: '🎯', tag: 'Cria, lista, qualifica e atualiza leads', context: LEAD_CTX },
  { id: 'opp', name: 'Ótto', domain: 'Oportunidade', color: '#8B5CF6', emoji: '📈', tag: 'Pipeline, estágio e próximo passo', context: OPP_CTX },
  { id: 'acct', name: 'Ako', domain: 'Account', color: '#FFB43B', emoji: '🏢', tag: 'Contas, 360 e atualização de dados', context: ACCT_CTX },
  { id: 'case', name: 'Ciça', domain: 'Service', color: '#FF6FA5', emoji: '🎧', tag: 'Casos, status e prioridade', context: SERVICE_CTX },
];

// custom agents em DB
async function ensureTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS farm_agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT, color TEXT, emoji TEXT, tag TEXT,
    context TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
  )`);
}
async function allAgents() {
  await ensureTable();
  const r = await pool.query('SELECT id,name,domain,color,emoji,tag,context FROM farm_agents ORDER BY created_at DESC');
  return [...r.rows.map((a) => ({ ...a, farm: true })), ...STATIC_AGENTS.map((a) => ({ ...a, farm: false }))];
}
async function getAgent(id) {
  const all = await allAgents();
  return all.find((a) => a.id === id);
}

// ───────── Ferramentas reais contra a org ─────────
const TOOLS = [
  { name: 'soql_query', description: 'Executa uma consulta SOQL de leitura (SELECT) na org e retorna os registros reais.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Query SOQL SELECT completa' } }, required: ['query'] } },
  { name: 'update_record', description: 'Atualiza campos de um registro EXISTENTE na org (DML update real).',
    input_schema: { type: 'object', properties: { sobject: { type: 'string' }, recordId: { type: 'string' }, fields: { type: 'object', description: 'mapa campo→valor' } }, required: ['sobject', 'recordId', 'fields'] } },
  { name: 'create_record', description: 'Cria um NOVO registro na org (DML insert real).',
    input_schema: { type: 'object', properties: { sobject: { type: 'string' }, fields: { type: 'object' } }, required: ['sobject', 'fields'] } },
];

async function execTool(conn, orgId, name, input) {
  const canWrite = WRITE_ORGS.has(Number(orgId));
  if (name === 'soql_query') {
    const q = await conn.query(input.query);
    const recs = (q.records || []).slice(0, 50).map((r) => { const c = { ...r }; delete c.attributes; return c; });
    return { ok: true, totalSize: q.totalSize, records: recs };
  }
  if (name === 'update_record') {
    if (!canWrite) return { ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` };
    const r = await conn.sobject(input.sobject).update({ Id: input.recordId, ...input.fields });
    return { ok: !!r.success, id: r.id || input.recordId, errors: r.errors };
  }
  if (name === 'create_record') {
    if (!canWrite) return { ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` };
    const r = await conn.sobject(input.sobject).create(input.fields);
    return { ok: !!r.success, id: r.id, errors: r.errors };
  }
  return { ok: false, error: 'ferramenta desconhecida: ' + name };
}

function stepSummary(name, input, out) {
  if (name === 'soql_query') return `consultou ${out.totalSize != null ? out.totalSize : (out.records ? out.records.length : 0)} registro(s)`;
  if (name === 'update_record') return out.ok ? `atualizou ${input.sobject} ${out.id}` : `falha ao atualizar (${out.error || 'erro'})`;
  if (name === 'create_record') return out.ok ? `criou ${input.sobject} ${out.id}` : `falha ao criar (${out.error || 'erro'})`;
  return name;
}

// loop agêntico com tool-use da Anthropic
async function agenticRun(system, messages, conn, orgId) {
  const key = process.env.ANTHROPIC_KEY;
  const convo = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
  const steps = [];
  for (let i = 0; i < 6; i++) {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, tools: TOOLS, messages: convo }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    convo.push({ role: 'assistant', content: data.content });
    if (data.stop_reason === 'tool_use') {
      const results = [];
      for (const blk of data.content) {
        if (blk.type !== 'tool_use') continue;
        let out;
        try { out = await execTool(conn, orgId, blk.name, blk.input || {}); }
        catch (e) { out = { ok: false, error: String(e.message || e) }; }
        steps.push({ tool: blk.name, input: blk.input, summary: stepSummary(blk.name, blk.input || {}, out) });
        results.push({ type: 'tool_result', tool_use_id: blk.id, content: JSON.stringify(out).slice(0, 6000) });
      }
      convo.push({ role: 'user', content: results });
      continue;
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { text, steps };
  }
  return { text: 'Fiz várias etapas mas atingi o limite de iterações. Pode refinar o pedido?', steps };
}

// ───────── Rotas ─────────
// GET /api/agent-farm/agents — prateleira (custom + pré-configurados)
router.get('/agents', authMiddleware, async (req, res) => {
  try { return res.json({ ok: true, agents: await allAgents() }); }
  catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// POST /api/agent-farm/agents — cria agente de IA { name, domain, context, color, emoji }
router.post('/agents', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.context) return res.status(400).json({ ok: false, error: 'name e context são obrigatórios' });
    await ensureTable();
    const id = 'c_' + Date.now().toString(36);
    const tag = (b.tag || b.domain || 'Agente sob medida').slice(0, 60);
    await pool.query(
      'INSERT INTO farm_agents (id,name,domain,color,emoji,tag,context) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, b.name.slice(0, 60), b.domain || 'Custom', b.color || '#0176D3', b.emoji || '🤖', tag, b.context]
    );
    return res.json({ ok: true, id, name: b.name });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// POST /api/agent-farm/chat — { agentId, orgId=36, messages:[{role,content}] } → ação real na org
router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const orgId = b.orgId || 36;
    const agent = await getAgent(b.agentId);
    if (!agent) return res.status(404).json({ ok: false, error: 'agente não encontrado' });
    const messages = Array.isArray(b.messages) ? b.messages.slice(-16) : [];
    if (!messages.length) return res.status(400).json({ ok: false, error: 'messages vazio' });
    const org = await getOrgById(orgId);
    if (!org) return res.status(404).json({ ok: false, error: `org ${orgId} não encontrada` });

    const conn = await connToOrg(org);
    const system = agent.context.replace(/\{NAME\}/g, agent.name) + BEHAV;
    const { text, steps } = await agenticRun(system, messages, conn, orgId);
    return res.json({ ok: true, agentId: agent.id, text, steps });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

export default router;
