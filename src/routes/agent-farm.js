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
  'Ao listar registros, apresente em lista curta e legível (não despeje JSON).' +
  '\n\nLISTAS CLICÁVEIS: ao listar registros, NÃO mostre o Id cru numa coluna. Em vez disso, torne o nome (ou identificador) de cada ' +
  'registro clicável usando EXATAMENTE o formato [[REC:<Id real de 15 ou 18 chars>:<texto visível>]]. Ex.: numa tabela de leads, a célula ' +
  'do nome vira [[REC:00Q...:ZZ Teste Vendas]]; numa lista de contas, [[REC:001...:Agro Connect]]. Funciona em tabelas e listas. Use o Id real do registro.' +
  '\n\nAÇÕES CLICÁVEIS: ao final da resposta, quando fizer sentido, ofereça de 1 a 4 próximas ações que o usuário pode querer. ' +
  'Cada ação é um comando curto e imperativo que VOCÊ executaria se ele clicar (ex.: "Qualificar a lead teste MAP como Hot", ' +
  '"Atualizar o telefone da JJ HOMOL", "Ver detalhes da Agro Connect", "Criar uma nova lead"). Use o identificador real do registro. ' +
  'Coloque-as EXATAMENTE assim, numa única linha no fim, sem explicar: [[ACOES]]comando 1|comando 2|comando 3[[/ACOES]]. ' +
  'Se a ação precisar de um dado que você não tem (ex.: o novo telefone), tudo bem sugerir mesmo assim — ao ser clicada você pergunta o valor.';

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
  // Prateleira mostra só os agentes criados (STATIC_AGENTS desativados a pedido).
  return r.rows.map((a) => ({ ...a, farm: true }));
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
  { name: 'convert_lead', description: 'Converte uma Lead em Account + Contact + Opportunity (Database.convertLead real).',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' }, opportunityName: { type: 'string', description: 'nome da oportunidade (opcional)' }, createOpportunity: { type: 'boolean', description: 'default true' } }, required: ['leadId'] } },
  { name: 'send_email', description: 'Envia um e-mail para o contato/e-mail de uma Lead (Messaging.sendEmail real).',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' }, email: { type: 'string', description: 'opcional; se ausente usa o Email da Lead' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] } },
  { name: 'log_call', description: 'Registra uma ligação para a Lead como atividade (Task tipo Call) na org.',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' }, subject: { type: 'string' }, comments: { type: 'string' } }, required: ['leadId'] } },
];

const esc1 = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

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
  if (name === 'convert_lead') {
    if (!canWrite) return { ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` };
    let status = 'Closed - Converted';
    try { const s = await conn.query('SELECT MasterLabel FROM LeadStatus WHERE IsConverted=true LIMIT 1'); if (s.records && s.records[0]) status = s.records[0].MasterLabel; } catch (e) {}
    let apex = `Database.LeadConvert lc=new Database.LeadConvert();lc.setLeadId('${esc1(input.leadId)}');lc.setConvertedStatus('${esc1(status)}');`;
    if (input.createOpportunity === false) apex += 'lc.setDoNotCreateOpportunity(true);';
    else if (input.opportunityName) apex += `lc.setOpportunityName('${esc1(input.opportunityName)}');`;
    apex += 'Database.LeadConvertResult r=Database.convertLead(lc);System.assert(r.isSuccess());';
    const ex = await conn.tooling.executeAnonymous(apex);
    if (!(ex.compiled && ex.success)) return { ok: false, error: ex.exceptionMessage || ex.compileProblem || 'convert falhou' };
    const q = await conn.query(`SELECT ConvertedAccountId,ConvertedContactId,ConvertedOpportunityId FROM Lead WHERE Id='${esc1(input.leadId)}'`);
    const rec = (q.records && q.records[0]) || {};
    return { ok: true, accountId: rec.ConvertedAccountId, contactId: rec.ConvertedContactId, opportunityId: rec.ConvertedOpportunityId };
  }
  if (name === 'send_email') {
    if (!canWrite) return { ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` };
    let email = input.email;
    if (!email && input.leadId) { const q = await conn.query(`SELECT Email FROM Lead WHERE Id='${esc1(input.leadId)}'`); if (q.records && q.records[0]) email = q.records[0].Email; }
    if (!email) return { ok: false, error: 'lead sem e-mail cadastrado' };
    const apex = `Messaging.SingleEmailMessage m=new Messaging.SingleEmailMessage();m.setToAddresses(new String[]{'${esc1(email)}'});m.setSubject('${esc1(input.subject)}');m.setPlainTextBody('${esc1(input.body)}');Messaging.SendEmailResult[] rr=Messaging.sendEmail(new Messaging.SingleEmailMessage[]{m});System.assert(rr[0].isSuccess());`;
    const ex = await conn.tooling.executeAnonymous(apex);
    if (!(ex.compiled && ex.success)) return { ok: false, to: email, error: (ex.exceptionMessage || ex.compileProblem || 'envio falhou') + ' (verifique Email Deliverability do sandbox)' };
    return { ok: true, to: email };
  }
  if (name === 'log_call') {
    if (!canWrite) return { ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` };
    const rec = { WhoId: input.leadId, Subject: input.subject || 'Ligação', Status: 'Completed', Description: input.comments || '', ActivityDate: new Date().toISOString().slice(0, 10) };
    try {
      const r = await conn.sobject('Task').create({ ...rec, Type: 'Call' });
      return { ok: !!r.success, id: r.id, errors: r.errors };
    } catch (e) {
      const r = await conn.sobject('Task').create(rec); // org sem Task.Type
      return { ok: !!r.success, id: r.id, errors: r.errors };
    }
  }
  return { ok: false, error: 'ferramenta desconhecida: ' + name };
}

function stepSummary(name, input, out) {
  if (name === 'soql_query') return `consultou ${out.totalSize != null ? out.totalSize : (out.records ? out.records.length : 0)} registro(s)`;
  if (name === 'update_record') return out.ok ? `atualizou ${input.sobject} ${out.id}` : `falha ao atualizar (${out.error || 'erro'})`;
  if (name === 'create_record') return out.ok ? `criou ${input.sobject} ${out.id}` : `falha ao criar (${out.error || 'erro'})`;
  if (name === 'convert_lead') return out.ok ? `converteu a lead → Opp ${out.opportunityId || '—'}` : `falha ao converter (${out.error || 'erro'})`;
  if (name === 'send_email') return out.ok ? `enviou e-mail para ${out.to}` : `falha no e-mail (${out.error || 'erro'})`;
  if (name === 'log_call') return out.ok ? `registrou ligação (${out.id})` : `falha ao registrar ligação (${out.error || 'erro'})`;
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
    let clean = text, actions = [];
    const ma = text.match(/\[\[ACOES\]\]([\s\S]*?)\[\[\/ACOES\]\]/i);
    if (ma) {
      clean = text.replace(ma[0], '').trim();
      actions = ma[1].split('|').map((a) => a.trim()).filter(Boolean).slice(0, 4);
    }
    return res.json({ ok: true, agentId: agent.id, text: clean, actions, steps });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// POST /api/agent-farm/agents/clear — remove TODOS os agentes criados
router.post('/agents/clear', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const r = await pool.query('DELETE FROM farm_agents');
    return res.json({ ok: true, deleted: r.rowCount });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// DELETE /api/agent-farm/agents/:id — remove um agente criado
router.delete('/agents/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM farm_agents WHERE id=$1', [req.params.id]);
    return res.json({ ok: true, deleted: r.rowCount });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// GET /api/agent-farm/record?orgId=36&id=<recordId> — lê um registro real da org
const ID_PREFIX = { '00Q': 'Lead', '001': 'Account', '003': 'Contact', '006': 'Opportunity', '500': 'Case', '00T': 'Task', '00U': 'Event', '701': 'Campaign', '800': 'Contract' };
let _prefixCache = null;
async function objForId(conn, id) {
  const p = id.slice(0, 3);
  if (ID_PREFIX[p]) return ID_PREFIX[p];
  if (!_prefixCache) { const g = await conn.describeGlobal(); _prefixCache = {}; g.sobjects.forEach((s) => { if (s.keyPrefix) _prefixCache[s.keyPrefix] = s.name; }); }
  return _prefixCache[p] || null;
}
router.get('/record', authMiddleware, async (req, res) => {
  try {
    const orgId = req.query.orgId || 36;
    const id = req.query.id;
    if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório' });
    const org = await getOrgById(orgId);
    if (!org) return res.status(404).json({ ok: false, error: `org ${orgId} não encontrada` });
    const conn = await connToOrg(org);
    const obj = await objForId(conn, id);
    if (!obj) return res.json({ ok: false, error: 'objeto não identificado para ' + id });
    const rec = await conn.sobject(obj).retrieve(id);
    const fields = Object.entries(rec)
      .filter(([k, v]) => v != null && v !== '' && typeof v !== 'object' && k !== 'attributes')
      .slice(0, 40).map(([k, v]) => [k, String(v)]);
    const name = rec.Name || rec.CaseNumber || rec.Subject || rec.Title || id;
    return res.json({ ok: true, object: obj, id, name, fields, instanceUrl: conn.instanceUrl });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

export default router;
