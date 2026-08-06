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
const MODEL = 'claude-haiku-4-5-20251001';
const WRITE_ORGS = new Set([36]); // só arqevery permite escrita (HOMOL/DevEvery = read-only)

async function getOrgById(id) {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return r.rows[0];
}
const _conns = {};
async function connToOrg(org) {
  const key = org.id || org.username;
  if (_conns[key]) { try { await _conns[key].identity(); return _conns[key]; } catch (e) { delete _conns[key]; } }
  const conn = new jsforce.Connection({ loginUrl: org.login_url, version: '62.0' });
  await conn.login(org.username, org.password + (org.security_token || ''));
  _conns[key] = conn;
  return conn;
}

// ───────── Prateleira: agentes pré-configurados (contexto genial por domínio) ─────────
const BEHAV =
  '\n\nCOMO VOCÊ OPERA: você é um agente OPERACIONAL conectado à org Salesforce arqevery. ' +
  'Quando o usuário pedir algo, USE AS FERRAMENTAS para fazer de verdade na org — não apenas explique. ' +
  'Responda sempre em português do Brasil, curto e objetivo. NUNCA invente Ids, números ou dados: sempre consulte a org com soql_query. ' +
  'Para alterar/criar, execute a ação e confirme o resultado real (Id + campos). Se faltar um dado obrigatório, pergunte antes de agir. ' +
  'Ao listar registros, apresente em lista curta e legível (não despeje JSON).' +
  '\n\nLISTAS GRANDES: mostre no MÁXIMO 15 registros por resposta (tabela enxuta, poucas colunas). Se houver mais, diga o total e ofereça continuar (ex.: "mostrando 15 de 40 — quer ver as próximas?"). Nunca deixe uma linha de tabela pela metade.' +
  '\n\nLISTAS CLICÁVEIS: ao listar registros, NÃO mostre o Id cru numa coluna. Em vez disso, torne o nome (ou identificador) de cada ' +
  'registro clicável usando EXATAMENTE o formato [[REC:<Id real de 15 ou 18 chars>:<texto visível>]]. Ex.: numa tabela de leads, a célula ' +
  'do nome vira [[REC:00Q...:ZZ Teste Vendas]]; numa lista de contas, [[REC:001...:Agro Connect]]. Funciona em tabelas e listas. Use o Id real do registro.' +
  '\n\nAÇÕES CLICÁVEIS: ao final da resposta, quando fizer sentido, ofereça de 1 a 4 próximas ações que o usuário pode querer. ' +
  'Cada ação é um comando curto e imperativo que VOCÊ executaria se ele clicar (ex.: "Qualificar a lead teste MAP como Hot", ' +
  '"Atualizar o telefone da JJ HOMOL", "Ver detalhes da Agro Connect", "Criar uma nova lead"). Use o identificador real do registro. ' +
  'Coloque-as EXATAMENTE assim, numa única linha no fim, sem explicar: [[ACOES]]comando 1|comando 2|comando 3[[/ACOES]]. ' +
  'Se a ação precisar de um dado que você não tem (ex.: o novo telefone), tudo bem sugerir mesmo assim — ao ser clicada você pergunta o valor.' +
  '\n\nABRIR REGISTRO: quando o usuário pedir para ABRIR/VER/MOSTRAR um registro ou atividade específica ("abra a tarefa da ligação", "abre a lead X", "mostra o evento de visita"), localize o Id com soql_query ou get_activities se necessário e termine a resposta com o token [[OPEN:<Id>]] — o sistema abre o registro num modal para o usuário ver e editar. Responda com 1 linha curta antes do token.' +
  '\n\nINTEGRAÇÕES MULESOFT: enrich_lead consulta a Neoway pelo CNPJ e grava porte/faixa/ticket/situação/segmento/endereço na lead (com status de enriquecimento). check_coverage verifica viabilidade de rede GPON e Metro para o endereço da lead. Depois de usar, resuma o resultado de forma vendedora (ex.: ticket potencial, cobertura disponível = oportunidade).' +
  '\n\nPESQUISA DE EMPRESA: quando o usuário pedir "pesquise esta empresa", "analise esta empresa", "me fale sobre esta empresa" ou similar, use web_search para buscar informações sobre a empresa (Company da lead aberta ou o nome que o usuário informar). Pesquise em múltiplas buscas se necessário. Monte um briefing de prospecção completo contendo:' +
  '\n1. **Sobre a empresa**: ramo de atuação, porte, número de funcionários, o que entrega/vende, principais clientes se disponível' +
  '\n2. **Presença digital**: site, redes sociais, notícias recentes' +
  '\n3. **Concorrentes/fornecedores atuais**: quais empresas de telecom/TI atendem ou podem atender essa empresa (concorrentes da Algar)' +
  '\n4. **Oportunidade Algar**: com base no perfil, recomende quais produtos/serviços da Algar seriam ideais (Fibra corporativa, MPLS, SD-WAN, Cloud, Dados, IoT, Contact Center, Colaboração/UcaaS, Segurança, Gestão de TI)' +
  '\n5. **Abordagem sugerida**: tom, gancho comercial, argumentos com base no que descobriu' +
  '\nSeja vendedor e proativo. Use emojis. Termine com próximos passos concretos (ex.: "agende uma visita", "aplique a cadência").' +
  '\n\nCALENDÁRIO VISUAL: quando o usuário pedir para VER/ABRIR o calendário ou a agenda ("abre meu calendário", "mostra a agenda", "calendário de visitas"), responda 1 linha curta e inclua o token [[CALENDAR]] — o sistema abre a tela de calendário com os agendamentos.' +
  '\n\nLIGAÇÃO GRAVADA / TRANSCRIÇÃO: gravações de chamadas ficam na Task de Subject EXATAMENTE "Ligação (gravada)" — a Description contém a transcrição e o áudio vai anexado. Quando pedirem "a ligação gravada", "a transcrição", "o registro da chamada", busque: SELECT Id,CreatedDate FROM Task WHERE Subject = \'Ligação (gravada)\' AND WhoId = \'<leadId>\' ORDER BY CreatedDate DESC LIMIT 1 e abra com [[OPEN:<Id>]]. NUNCA confunda com as tarefas de cadência ("Cadência x/5 · Ligação..."), que são passos futuros, não gravações. Se não houver nenhuma "Ligação (gravada)" na lead, diga que ainda não há chamada gravada.' +
  '\n\nCRIAR VIA FORMULÁRIO: quando o usuário quiser CRIAR um registro (ex.: "quero criar uma lead", "criar uma conta"), NÃO peça os campos no chat nem use a ferramenta de criar. ' +
  'Responda com UMA linha curta (ex.: "Beleza, abrindo o formulário de nova lead 👇") e inclua no fim o token [[NEWRECORD:<Objeto>]] (ex.: [[NEWRECORD:Lead]], [[NEWRECORD:Account]]). ' +
  'O sistema abrirá um formulário com os campos certos pra ele preencher. Se o usuário já tiver dito alguns valores, inclua-os como JSON: [[NEWRECORD:Lead:{"LastName":"Silva","Company":"ACME"}]]. ' +
  'Só use a ferramenta create_record diretamente se o usuário pedir explicitamente "cria você mesmo" e já fornecer todos os dados.' +
  '\n\nAUTO-CRIAR EM MASSA: se o usuário quiser gerar VÁRIAS leads de uma vez informando quantidade + cidade + UF (ex.: "auto criar 20 leads em Uberlândia MG", "gera 50 leads em SP"), ' +
  'responda uma linha curta e inclua o token [[AUTOCREATE:Lead]] — ou já com os dados: [[AUTOCREATE:Lead:{"count":20,"uf":"MG","city":"Uberlândia"}]]. Isso abre um formulário de geração em massa.' +
  '\n\nLIGAR: quando o usuário disser "ligue/ligar para a lead", use a ferramenta call_lead — ela pega o telefone da lead, registra a ligação e ABRE O DISCADOR do aparelho do usuário com o número. Use log_call só para "registrar uma ligação" sem discar.' +
  '\n\nATIVIDADES: você também cria Eventos de calendário (create_event — visitas, reuniões; pergunte data/hora se faltar), Tarefas (create_task — follow-ups com vencimento), Notas (create_note) e posts no Chatter (post_chatter), e consulta a agenda (get_calendar). Interprete datas relativas ("amanhã", "sexta às 14h") usando a data atual informada, fuso de Brasília (-03:00). ' +
  'IMPORTANTE: ao listar tarefas, eventos ou agenda, marque cada item como clicável com [[REC:<Id>:<assunto>]] (Ids 00T = tarefa, 00U = evento) — o usuário clica para abrir e EDITAR a atividade.' +
  '\n\nCADÊNCIA (Sales Engagement): cadência é a sequência estruturada de toques (ligação, e-mail, social, visita) com intervalos definidos para engajar uma lead — conceito do Sales Engagement do Salesforce. ' +
  'Quando pedirem "aplique a cadência" numa lead, use apply_cadence (padrão: 5 toques em 9 dias — Ligação D0, E-mail D+1, Ligação D+3, E-mail D+5, Break-up D+8; aceite passos customizados). ' +
  'Quando pedirem "mostre a cadência/atividades/timeline" da lead, use get_activities e apresente em timeline cronológica com status (✅ concluído, 🔵 aberto, 🔴 atrasado vs hoje), cada item clicável com [[REC:...]]. ' +
  'Dica de coach: se a lead não tem toques futuros, sugira aplicar a cadência.';

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
  { id: 'lead', name: 'Algar AI', domain: 'Lead', color: '#0176D3', emoji: '🎯', tag: 'Cria, lista, qualifica e atualiza leads', context: LEAD_CTX },
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
  { name: 'call_lead', description: 'LIGAR para uma Lead: pega o telefone da lead, registra a ligação e ABRE O DISCADOR do aparelho do usuário com o número. Use sempre que pedirem "ligue/ligar para a lead".',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'create_event', description: 'Cria um Evento no calendário (visita, reunião, demo) ligado a um registro. Datas em ISO com fuso de Brasília, ex.: 2026-08-05T14:00:00-03:00. Se o usuário não der horário, pergunte. Duração padrão 1h.',
    input_schema: { type: 'object', properties: { whoId: { type: 'string', description: 'Id de Lead/Contact (opcional)' }, whatId: { type: 'string', description: 'Id de Account/Opportunity/Case (opcional)' }, subject: { type: 'string' }, startDateTime: { type: 'string' }, endDateTime: { type: 'string', description: 'opcional; default start+1h' }, location: { type: 'string' }, description: { type: 'string' } }, required: ['subject', 'startDateTime'] } },
  { name: 'create_task', description: 'Cria uma Tarefa (to-do, follow-up) ligada a um registro, com data de vencimento.',
    input_schema: { type: 'object', properties: { whoId: { type: 'string' }, whatId: { type: 'string' }, subject: { type: 'string' }, dueDate: { type: 'string', description: 'YYYY-MM-DD' }, comments: { type: 'string' }, status: { type: 'string', description: 'default Not Started / aberto' }, priority: { type: 'string' } }, required: ['subject'] } },
  { name: 'create_note', description: 'Cria uma Nota (ContentNote) anexada a um registro (lead, conta, opp...).',
    input_schema: { type: 'object', properties: { recordId: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['recordId', 'title', 'body'] } },
  { name: 'post_chatter', description: 'Publica um post no Chatter no feed de um registro (lead, conta, opp...).',
    input_schema: { type: 'object', properties: { recordId: { type: 'string' }, text: { type: 'string' } }, required: ['recordId', 'text'] } },
  { name: 'get_calendar', description: 'Consulta o calendário: eventos do usuário num intervalo de datas (default: próximos 7 dias). Use para "o que tenho na agenda", "eventos de amanhã", "minha semana".',
    input_schema: { type: 'object', properties: { fromDate: { type: 'string', description: 'YYYY-MM-DD (default hoje)' }, toDate: { type: 'string', description: 'YYYY-MM-DD (default +7d)' }, whoId: { type: 'string', description: 'filtrar por lead/contato (opcional)' } }, required: [] } },
  { name: 'get_activities', description: 'Timeline de um registro: todas as Tarefas e Eventos (abertos e concluídos) de uma lead/conta/opp em ordem cronológica. Use para "mostre a cadência", "atividades da lead", "histórico de toques".',
    input_schema: { type: 'object', properties: { recordId: { type: 'string' } }, required: ['recordId'] } },
  { name: 'enrich_lead', description: 'Enriquecimento Neoway via MuleSoft: consulta o CNPJ da lead e grava porte, faixa de funcionários, ticket potencial, situação cadastral, segmento e endereço fiscal nos campos de enriquecimento da Lead. Use quando pedirem "enriquece a lead", "consulta o CNPJ", "dados da Neoway".',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'check_coverage', description: 'Cobertura de rede via MuleSoft: verifica viabilidade GPON e Metro (estações reais) para o endereço/cidade da lead. Use quando pedirem "tem cobertura?", "viabilidade", "GPON/Metro disponível?".',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] } },
  { name: 'apply_cadence', description: 'Aplica uma CADÊNCIA de sales engagement na lead: cria a sequência de toques (tarefas com datas escalonadas a partir de startDate). Se steps não for informado, usa a cadência padrão B2B de 5 toques em 9 dias (Ligação D0, E-mail D+1, Ligação D+3, E-mail D+5, Ligação break-up D+8).',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' }, startDate: { type: 'string', description: 'YYYY-MM-DD (default hoje)' }, steps: { type: 'array', items: { type: 'object', properties: { dayOffset: { type: 'number' }, kind: { type: 'string', description: 'call | email | task | visita' }, subject: { type: 'string' } }, required: ['dayOffset', 'subject'] } } }, required: ['leadId'] } },
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
  if (name === 'call_lead') {
    if (!canWrite) return { ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` };
    const q = await conn.query(`SELECT Name,Phone,MobilePhone FROM Lead WHERE Id='${esc1(input.leadId)}'`);
    const rec = (q.records && q.records[0]) || {};
    const raw = rec.Phone || rec.MobilePhone;
    if (!raw) return { ok: false, error: 'lead sem telefone cadastrado' };
    let taskId = null;
    const base = { WhoId: input.leadId, Subject: 'Ligação', Status: 'Completed', Description: 'Ligação iniciada pelo agente', ActivityDate: new Date().toISOString().slice(0, 10) };
    try { const t = await conn.sobject('Task').create({ ...base, Type: 'Call' }); taskId = t.id; }
    catch (e) { try { const t = await conn.sobject('Task').create(base); taskId = t.id; } catch (e2) {} }
    let digits = String(raw).replace(/\D/g, '');
    if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = '55' + digits;
    return { ok: true, id: taskId, phone: raw, name: rec.Name, dial: digits, leadId: input.leadId };
  }
  if (name === 'create_event') {
    if (!canWrite) return { ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` };
    const start = new Date(input.startDateTime);
    if (isNaN(start)) return { ok: false, error: 'startDateTime inválido' };
    const end = input.endDateTime ? new Date(input.endDateTime) : new Date(start.getTime() + 60 * 60 * 1000);
    const ev = { Subject: input.subject, StartDateTime: start.toISOString(), EndDateTime: end.toISOString() };
    if (input.whoId) ev.WhoId = input.whoId;
    if (input.whatId) ev.WhatId = input.whatId;
    if (input.location) ev.Location = input.location;
    if (input.description) ev.Description = input.description;
    const r = await conn.sobject('Event').create(ev);
    return { ok: !!r.success, id: r.id, errors: r.errors, start: start.toISOString(), end: end.toISOString() };
  }
  if (name === 'create_task') {
    if (!canWrite) return { ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` };
    const t = { Subject: input.subject, Status: input.status || 'Not Started' };
    if (input.whoId) t.WhoId = input.whoId;
    if (input.whatId) t.WhatId = input.whatId;
    if (input.dueDate) t.ActivityDate = input.dueDate;
    if (input.comments) t.Description = input.comments;
    if (input.priority) t.Priority = input.priority;
    let r;
    try { r = await conn.sobject('Task').create(t); }
    catch (e) { delete t.Status; r = await conn.sobject('Task').create(t); }
    if (!r.success && r.errors && /Status/i.test(JSON.stringify(r.errors))) { delete t.Status; r = await conn.sobject('Task').create(t); }
    return { ok: !!r.success, id: r.id, errors: r.errors };
  }
  if (name === 'create_note') {
    if (!canWrite) return { ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` };
    const html = String(input.body || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
    const r = await conn.sobject('ContentNote').create({ Title: input.title, Content: Buffer.from(html, 'utf8').toString('base64') });
    if (!r.success) return { ok: false, errors: r.errors };
    try { await conn.sobject('ContentDocumentLink').create({ ContentDocumentId: r.id, LinkedEntityId: input.recordId, ShareType: 'V' }); }
    catch (e) { return { ok: true, id: r.id, warn: 'nota criada mas não linkada: ' + String(e.message || e) }; }
    return { ok: true, id: r.id };
  }
  if (name === 'post_chatter') {
    if (!canWrite) return { ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` };
    const r = await conn.sobject('FeedItem').create({ ParentId: input.recordId, Body: input.text, Type: 'TextPost' });
    return { ok: !!r.success, id: r.id, errors: r.errors };
  }
  if (name === 'get_calendar') {
    const from = input.fromDate ? new Date(input.fromDate + 'T00:00:00-03:00') : new Date();
    const to = input.toDate ? new Date(input.toDate + 'T23:59:59-03:00') : new Date(from.getTime() + 7 * 24 * 3600 * 1000);
    let q = `SELECT Id,Subject,StartDateTime,EndDateTime,Location,Who.Name,What.Name FROM Event WHERE StartDateTime >= ${from.toISOString()} AND StartDateTime <= ${to.toISOString()}`;
    if (input.whoId) q += ` AND WhoId='${esc1(input.whoId)}'`;
    q += ' ORDER BY StartDateTime LIMIT 50';
    const res2 = await conn.query(q);
    const evs = (res2.records || []).map((e) => ({ id: e.Id, subject: e.Subject, start: e.StartDateTime, end: e.EndDateTime, location: e.Location, who: e.Who && e.Who.Name, what: e.What && e.What.Name }));
    return { ok: true, count: evs.length, events: evs };
  }
  if (name === 'get_activities') {
    const rid = esc1(input.recordId);
    const tq = await conn.query(`SELECT Id,Subject,Status,ActivityDate FROM Task WHERE WhoId='${rid}' OR WhatId='${rid}' ORDER BY ActivityDate NULLS LAST LIMIT 60`);
    const eq = await conn.query(`SELECT Id,Subject,StartDateTime,Location FROM Event WHERE WhoId='${rid}' OR WhatId='${rid}' ORDER BY StartDateTime LIMIT 40`);
    const tasks = (tq.records || []).map((t) => ({ id: t.Id, type: 'Task', subject: t.Subject, status: t.Status, date: t.ActivityDate }));
    const events = (eq.records || []).map((e) => ({ id: e.Id, type: 'Event', subject: e.Subject, start: e.StartDateTime, location: e.Location }));
    return { ok: true, tasks, events, total: tasks.length + events.length };
  }
  if (name === 'apply_cadence') {
    if (!canWrite) return { ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` };
    const start = input.startDate ? new Date(input.startDate + 'T12:00:00-03:00') : new Date();
    const DEF = [
      { dayOffset: 0, kind: 'call', subject: 'Cadência 1/5 · Ligação de apresentação' },
      { dayOffset: 1, kind: 'email', subject: 'Cadência 2/5 · E-mail proposta de valor' },
      { dayOffset: 3, kind: 'call', subject: 'Cadência 3/5 · Ligação de follow-up' },
      { dayOffset: 5, kind: 'email', subject: 'Cadência 4/5 · E-mail case de sucesso' },
      { dayOffset: 8, kind: 'call', subject: 'Cadência 5/5 · Ligação final (break-up)' },
    ];
    const steps = (Array.isArray(input.steps) && input.steps.length) ? input.steps : DEF;
    const created = [];
    for (const s of steps.slice(0, 12)) {
      const d = new Date(start.getTime() + (Number(s.dayOffset) || 0) * 24 * 3600 * 1000);
      const t = { WhoId: input.leadId, Subject: s.subject, Status: 'Not Started', ActivityDate: d.toISOString().slice(0, 10), Description: 'Passo de cadência de vendas (' + (s.kind || 'toque') + ')' };
      let r;
      try { r = await conn.sobject('Task').create({ ...t, Type: /call|liga/i.test(s.kind || '') ? 'Call' : (/mail/i.test(s.kind || '') ? 'Email' : undefined) }); }
      catch (e) { r = await conn.sobject('Task').create(t); }
      if (!(r && r.success)) { try { delete t.Status; r = await conn.sobject('Task').create(t); } catch (e2) {} }
      if (r && r.success) created.push({ id: r.id, subject: s.subject, date: t.ActivityDate });
    }
    return { ok: created.length > 0, created, count: created.length };
  }
  if (name === 'enrich_lead') {
    if (!canWrite) return { ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` };
    return await neowayEnrich(conn, input.leadId);
  }
  if (name === 'check_coverage') {
    return await coverageCheck(conn, input.leadId);
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
  if (name === 'call_lead') return out.ok ? `abrindo discador → ${out.phone}` : `falha ao ligar (${out.error || 'erro'})`;
  if (name === 'create_event') return out.ok ? `criou evento ${out.id}` : `falha no evento (${out.error || JSON.stringify(out.errors || '')})`;
  if (name === 'create_task') return out.ok ? `criou tarefa ${out.id}` : `falha na tarefa (${out.error || JSON.stringify(out.errors || '')})`;
  if (name === 'create_note') return out.ok ? `criou nota ${out.id}` : `falha na nota (${out.error || JSON.stringify(out.errors || '')})`;
  if (name === 'post_chatter') return out.ok ? `postou no Chatter (${out.id})` : `falha no Chatter (${out.error || JSON.stringify(out.errors || '')})`;
  if (name === 'get_calendar') return `consultou agenda: ${out.count != null ? out.count : 0} evento(s)`;
  if (name === 'get_activities') return `timeline: ${out.total != null ? out.total : 0} atividade(s)`;
  if (name === 'enrich_lead') return out.ok ? 'enriqueceu via Neoway (porte ' + ((out.data && out.data.porte) || '—') + ')' : `falha no enriquecimento (${out.error || 'erro'})`;
  if (name === 'check_coverage') return out.ok ? ('cobertura: GPON ' + (out.gpon && out.gpon.available ? 'OK' : 'não') + ' · Metro ' + (out.metro && out.metro.available ? 'OK' : 'não')) : `falha na cobertura (${out.error || 'erro'})`;
  if (name === 'apply_cadence') return out.ok ? `aplicou cadência: ${out.count} toque(s) criados` : `falha na cadência (${out.error || 'erro'})`;
  return name;
}

// loop agêntico com tool-use da Anthropic
async function agenticRun(system, messages, conn, orgId) {
  const key = process.env.ANTHROPIC_KEY;
  const convo = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
  const steps = [];
  let dial = null;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, system, tools: [...TOOLS, { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }], messages: convo }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    convo.push({ role: 'assistant', content: data.content });
    if (data.stop_reason === 'tool_use') {
      const results = [];
      for (const blk of data.content) {
        if (blk.type === 'tool_use' && blk.name === 'web_search') {
          steps.push({ tool: 'web_search', input: blk.input, summary: 'pesquisou: ' + (blk.input.query || '').slice(0, 60) });
          continue;
        }
        if (blk.type !== 'tool_use') continue;
        let out;
        try { out = await execTool(conn, orgId, blk.name, blk.input || {}); }
        catch (e) { out = { ok: false, error: String(e.message || e) }; }
        if (out && out.dial) dial = { number: out.dial, display: out.phone, name: out.name, leadId: out.leadId };
        steps.push({ tool: blk.name, input: blk.input, summary: stepSummary(blk.name, blk.input || {}, out) });
        results.push({ type: 'tool_result', tool_use_id: blk.id, content: JSON.stringify(out).slice(0, 6000) });
      }
      convo.push({ role: 'user', content: results });
      continue;
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { text, steps, dial };
  }
  return { text: 'Fiz várias etapas mas atingi o limite de iterações. Pode refinar o pedido?', steps, dial };
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

// PATCH /api/agent-farm/agents/:id — atualiza agente
router.patch('/agents/:id', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = []; const vals = []; let n = 1;
    if (b.name) { sets.push('name=$' + n); vals.push(b.name); n++; }
    if (b.emoji) { sets.push('emoji=$' + n); vals.push(b.emoji); n++; }
    if (b.tag) { sets.push('tag=$' + n); vals.push(b.tag); n++; }
    if (b.context) { sets.push('context=$' + n); vals.push(b.context); n++; }
    if (!sets.length) return res.json({ ok: false, error: 'nada pra atualizar' });
    vals.push(req.params.id);
    await pool.query('UPDATE farm_agents SET ' + sets.join(',') + ' WHERE id=$' + n, vals);
    return res.json({ ok: true });
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
    const nowBr = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' });
    const system = agent.context.replace(/\{NAME\}/g, agent.name) + BEHAV + `\n\nDATA/HORA ATUAL (Brasília): ${nowBr}.`;
    const { text, steps, dial } = await agenticRun(system, messages, conn, orgId);
    let clean = text, actions = [];
    const ma = text.match(/\[\[ACOES\]\]([\s\S]*?)\[\[\/ACOES\]\]/i);
    if (ma) {
      clean = text.replace(ma[0], '').trim();
      actions = ma[1].split('|').map((a) => a.trim()).filter(Boolean).slice(0, 4);
    }
    let newRecord = null;
    const mn = clean.match(/\[\[NEWRECORD:([A-Za-z_0-9]+)(?::([\s\S]*?))?\]\]/i);
    if (mn) {
      clean = clean.replace(mn[0], '').trim();
      let prefill = {};
      if (mn[2]) { try { prefill = JSON.parse(mn[2]); } catch (e) { prefill = {}; } }
      newRecord = { object: mn[1], prefill };
    }
    let autoCreate = null;
    const mac = clean.match(/\[\[AUTOCREATE:([A-Za-z_0-9]+)(?::([\s\S]*?))?\]\]/i);
    if (mac) {
      clean = clean.replace(mac[0], '').trim();
      let pf = {};
      if (mac[2]) { try { pf = JSON.parse(mac[2]); } catch (e) { pf = {}; } }
      autoCreate = { object: mac[1], count: pf.count, uf: pf.uf, city: pf.city };
    }
    let openCalendar = false;
    if (/\[\[CALENDAR\]\]/i.test(clean)) { clean = clean.replace(/\[\[CALENDAR\]\]/ig, '').trim(); openCalendar = true; }
    let openRecordId = null;
    const mo = clean.match(/\[\[OPEN:([A-Za-z0-9]{15,18})\]\]/i);
    if (mo) { clean = clean.replace(mo[0], '').trim(); openRecordId = mo[1]; }
    // resposta truncada: remove tokens órfãos (sem fechamento) e linha de tabela pela metade
    clean = clean.replace(/\[\[(?:REC|OPEN|NEWRECORD|AUTOCREATE|ACOES)[^\]]*$/i, '').trimEnd();
    const lines = clean.split('\n');
    const last = lines[lines.length - 1] || '';
    if (/^\s*\|/.test(last) && !/\|\s*$/.test(last)) { lines.pop(); clean = lines.join('\n').trimEnd(); }
    return res.json({ ok: true, agentId: agent.id, text: clean, actions, steps, newRecord, autoCreate, dial, openRecordId, openCalendar });
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
const _desc = {};
async function describeCached(conn, obj, orgId) {
  const k = orgId + ':' + obj;
  if (_desc[k]) return _desc[k];
  const d = await conn.sobject(obj).describe();
  _desc[k] = d;
  return d;
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
    const desc = await describeCached(conn, obj, orgId);
    const fmap = {}; (desc.fields || []).forEach((f) => { fmap[f.name] = f; });
    const SKIP = new Set(['attributes', 'IsDeleted', 'SystemModstamp', 'LastReferencedDate', 'LastViewedDate', 'PhotoUrl', 'IsUnreadByOwner', 'ActiveTrackerCount', 'IsPriorityRecord', 'RecordTypeId', 'MasterRecordId', 'JigsawContactId', 'IndividualId', 'CleanStatus', 'EmailBouncedReason', 'EmailBouncedDate']);
    const makeField = (k, v) => {
      const f = fmap[k] || {};
      const type = f.type || 'string';
      const editable = !!f.updateable && type !== 'reference';
      const o = { name: k, label: f.label || k, value: String(v), type, editable };
      if (type === 'picklist' || type === 'multipicklist') o.options = (f.picklistValues || []).filter((p) => p.active).map((p) => p.value);
      return o;
    };
    const allFields = Object.entries(rec)
      .filter(([k, v]) => v != null && v !== '' && typeof v !== 'object' && !SKIP.has(k) && !k.endsWith('__pc'))
      .map(([k, v]) => makeField(k, v));
    // --- seções do layout (Lead) ---
    const LEAD_SECTIONS = [
      { heading: 'Informações da Lead', keys: ['Rating', 'Status', 'CNPJ__c', 'Company', 'Website', 'OwnerId', 'PercentualPreenchimento__c', 'Motivo_cancelamento__c', 'RelacionamentoLead__c'] },
      { heading: 'Dados do contato', keys: ['FirstName', 'LastName', 'Name', 'Title', 'Email', 'LinkedIn__c'] },
      { heading: 'Telefones para contato', keys: ['Phone', 'MobilePhone', 'Telefone3__c', 'Telefone4__c', 'Telefone5__c', 'Telefone6__c', 'Telefone7__c', 'TelefoneBlacklist__c', 'MobilePhoneBlacklist__c', 'Telefone3Blacklist__c', 'Telefone4Blacklist__c', 'Telefone5Blacklist__c', 'Telefone6Blacklist__c', 'Telefone7Blacklist__c'] },
      { heading: 'Endereço', keys: ['Street', 'City', 'State', 'PostalCode', 'Country', 'Regional__c', 'Diretoria__c', 'Numero__c', 'Bairro__c', 'Complemento__c'] },
      { heading: 'Endereço de visita', keys: ['EnderecoVisitaRua__c', 'EnderecoVisitaCidade__c', 'EnderecoVisitaEstado__c', 'EnderecoVisitaCEP__c', 'EnderecoMapRua__c'] },
      { heading: 'Dados de marketing', keys: ['Segmento__c', 'Campaign__c', 'TipoLead__c', 'LeadSource', 'OrigemCanal__c', 'NomeAssociado__c', 'MatriculaAssociado__c', 'EtapaCarrinho__c'] },
      { heading: 'Enriquecimento', keys: ['PorteEmpresa__c', 'FaixaFuncionarios__c', 'TicketPotencial__c', 'SituacaoCadastral__c', 'PorteEmpresaEnrichStatus__c', 'FaixaFuncionariosEnrichStatus__c', 'TicketPotencialEnrichStatus__c', 'SituacaoCadastralEnrichStatus__c', 'Industry'] },
      { heading: 'Qualificação (BANT)', keys: ['OrcamentoDisponivel__c', 'NivelDecisaoContrato__c', 'NecessidadeIdentificada__c', 'PrazoContratacao__c', 'ProdutosEmpresa__c', 'FornecedoresEmpresa__c'] },
      { heading: 'Informações de sistema', keys: ['CreatedById', 'CreatedDate', 'LastModifiedById', 'LastModifiedDate', 'Id'] },
    ];
    let sections = null;
    if (obj === 'Lead') {
      const fieldMap = {}; allFields.forEach((f) => { fieldMap[f.name] = f; });
      sections = LEAD_SECTIONS.map((s) => {
        const sFields = s.keys.map((k) => fieldMap[k]).filter(Boolean);
        return sFields.length ? { heading: s.heading, fields: sFields } : null;
      }).filter(Boolean);
      const usedKeys = new Set(LEAD_SECTIONS.flatMap((s) => s.keys));
      const extra = allFields.filter((f) => !usedKeys.has(f.name));
      if (extra.length) sections.push({ heading: 'Outros campos', fields: extra });
    }
    // --- status path (Lead) ---
    let statusPath = null;
    if (obj === 'Lead') {
      const PATH = ['Novo', 'Qualificacao', 'Conversao', 'Convertido'];
      const CANCEL = 'Cancelado';
      const cur = rec.Status || '';
      const isCancelled = cur === CANCEL;
      statusPath = { steps: PATH, current: cur, cancelled: isCancelled, cancelStep: CANCEL };
    }
    // --- regras de qualificação (Lead, mandadas pro front p/ validar) ---
    let qualRules = null;
    if (obj === 'Lead') {
      qualRules = {
        cancelledNoReopen: 'Lead cancelado não pode ter o status alterado.',
        newOnCreate: 'Na criação, o status do Lead deve ser "Novo".',
        conversionFields: {
          message: 'Para alterar o status para "Em conversão", preencha todos os campos de qualificação.',
          required: ['OrcamentoDisponivel__c', 'NivelDecisaoContrato__c', 'NecessidadeIdentificada__c', 'PrazoContratacao__c', 'ProdutosEmpresa__c'],
          conditionalRequired: { field: 'FornecedoresEmpresa__c', unlessSegmento: 'Operadoras' },
        },
      };
    }
    const name = rec.Name || rec.CaseNumber || rec.Subject || rec.Title || id;
    let headerInfo = null;
    if (obj === 'Lead') {
      headerInfo = { phone: rec.Phone, mobile: rec.MobilePhone, email: rec.Email, rating: rec.Rating, city: rec.City, state: rec.State, company: rec.Company };
    }
    const cancelMotivos = obj === 'Lead' ? (fmap['Motivo_cancelamento__c'] || {}).picklistValues ? ((fmap['Motivo_cancelamento__c'] || {}).picklistValues || []).filter(p => p.active).map(p => p.value) : [] : null;
    return res.json({ ok: true, object: obj, id, name, fields: allFields, sections, statusPath, qualRules, headerInfo, cancelMotivos, instanceUrl: conn.instanceUrl });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// POST /api/agent-farm/record-update — salva alterações de campos do registro
router.post('/record-update', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const orgId = b.orgId || 36;
    if (!b.id || !b.object || !b.fields || typeof b.fields !== 'object') return res.status(400).json({ ok: false, error: 'id, object e fields são obrigatórios' });
    if (!WRITE_ORGS.has(Number(orgId))) return res.json({ ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` });
    const org = await getOrgById(orgId);
    if (!org) return res.status(404).json({ ok: false, error: `org ${orgId} não encontrada` });
    const conn = await connToOrg(org);
    const r = await conn.sobject(b.object).update({ Id: b.id, ...b.fields });
    return res.json({ ok: !!r.success, id: r.id || b.id, errors: r.errors });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── Criação RT-aware (replica o modal "New") ──
async function describeLayoutsRaw(conn, object) {
  return await conn.request(`/services/data/v62.0/sobjects/${object}/describe/layouts/`);
}

// GET /create-meta?object=Lead — record types disponíveis
router.get('/create-meta', authMiddleware, async (req, res) => {
  try {
    const orgId = req.query.orgId || 36, object = req.query.object;
    if (!object) return res.status(400).json({ ok: false, error: 'object obrigatório' });
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    const dl = await describeLayoutsRaw(conn, object);
    let sel = dl.recordTypeSelectorRequired; if (Array.isArray(sel)) sel = sel[0];
    const rts = (dl.recordTypeMappings || []).filter((m) => m.active && m.available && !m.master)
      .map((m) => ({ recordTypeId: m.recordTypeId, name: m.name, isDefault: !!m.defaultRecordTypeMapping }));
    const desc = await describeCached(conn, object, orgId);
    return res.json({ ok: true, object, label: desc.label, selectorRequired: !!sel && rts.length > 1, recordTypes: rts });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// GET /create-layout?object=Lead&recordTypeId=... — campos do layout daquele RT
router.get('/create-layout', authMiddleware, async (req, res) => {
  try {
    const orgId = req.query.orgId || 36, object = req.query.object, rtId = req.query.recordTypeId;
    if (!object) return res.status(400).json({ ok: false, error: 'object obrigatório' });
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    const dl = await describeLayoutsRaw(conn, object);
    const maps = dl.recordTypeMappings || [];
    const mapping = maps.find((m) => m.recordTypeId === rtId) || maps.find((m) => m.defaultRecordTypeMapping) || maps.find((m) => m.master) || maps[0];
    const layout = await conn.request(mapping.urls.layout);
    const secs = layout.editLayoutSections || [];
    const desc = await describeCached(conn, object, orgId);
    const fmap = {}, compounds = {};
    (desc.fields || []).forEach((f) => { fmap[f.name] = f; if (f.compoundFieldName) { (compounds[f.compoundFieldName] = compounds[f.compoundFieldName] || []).push(f); } });
    const mk = (f, reqLayout) => {
      const o = { name: f.name, label: f.label, type: f.type, required: !!reqLayout || (!f.nillable && !f.defaultedOnCreate && f.createable) };
      if (f.type === 'picklist' || f.type === 'multipicklist') o.options = (f.picklistValues || []).filter((p) => p.active).map((p) => p.value);
      if (f.type === 'textarea') o.type = 'textarea';
      return o;
    };
    const seen = new Set(), outSecs = [];
    for (const s of secs) {
      const items = [];
      for (const row of (s.layoutRows || [])) {
        for (const it of (row.layoutItems || [])) {
          if (it.editableForNew === false) continue;
          const comp = (it.layoutComponents || []).find((c) => c.type === 'Field');
          if (!comp) continue;
          const f = fmap[comp.value];
          if (!f) continue;
          const isCompound = (f.type === 'address' || f.type === 'location' || f.type === 'name' || (compounds[f.name] && !f.createable));
          if (isCompound) {
            (compounds[f.name] || []).filter((p) => p.createable && p.type !== 'reference' && p.type !== 'double' && p.type !== 'address' && p.type !== 'location')
              .forEach((p) => { if (!seen.has(p.name)) { seen.add(p.name); items.push(mk(p, p.name === 'LastName')); } });
            continue;
          }
          if (!f.createable || seen.has(f.name)) continue;
          seen.add(f.name);
          items.push(mk(f, it.required));
        }
      }
      if (items.length) outSecs.push({ heading: s.heading || '', fields: items });
    }
    return res.json({ ok: true, object, recordTypeId: mapping.recordTypeId, recordTypeName: mapping.name, label: desc.label, sections: outSecs });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// POST /record-create — cria o registro
router.post('/record-create', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {}; const orgId = b.orgId || 36;
    if (!b.object || !b.fields || typeof b.fields !== 'object') return res.status(400).json({ ok: false, error: 'object e fields obrigatórios' });
    if (!WRITE_ORGS.has(Number(orgId))) return res.json({ ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` });
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    const r = await conn.sobject(b.object).create(b.fields);
    return res.json({ ok: !!r.success, id: r.id, errors: r.errors });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── Auto-create em massa (quantidade + UF + cidade, cidade dependente via IBGE) ──
let _ufs = null; const _cidades = {};
router.get('/ibge/ufs', authMiddleware, async (req, res) => {
  try {
    if (!_ufs) { const r = await fetch('https://servicodados.ibge.gov.br/api/v1/localidades/estados?orderBy=nome'); _ufs = (await r.json()).map((u) => ({ sigla: u.sigla, nome: u.nome })); }
    return res.json({ ok: true, ufs: _ufs });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
router.get('/ibge/cidades', authMiddleware, async (req, res) => {
  try {
    const uf = (req.query.uf || '').toUpperCase();
    if (!uf) return res.status(400).json({ ok: false, error: 'uf obrigatório' });
    if (!_cidades[uf]) { const r = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios`); _cidades[uf] = (await r.json()).map((c) => c.nome); }
    return res.json({ ok: true, uf, cidades: _cidades[uf] });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

function genCNPJ() {
  const rnd = () => Math.floor(Math.random() * 10);
  const b = []; for (let i = 0; i < 8; i++) b.push(rnd()); b.push(0, 0, 0, 1);
  const calc = (arr) => { let pos = arr.length - 7, sum = 0; for (let i = 0; i < arr.length; i++) { sum += arr[i] * pos--; if (pos < 2) pos = 9; } const r = sum % 11; return r < 2 ? 0 : 11 - r; };
  b.push(calc(b)); b.push(calc(b)); return b.join('');
}
const _FIRST = ['Ana', 'Bruno', 'Carlos', 'Daniela', 'Eduardo', 'Fernanda', 'Gustavo', 'Helena', 'Igor', 'Juliana', 'Lucas', 'Marina', 'Nathan', 'Olivia', 'Paulo', 'Rafaela', 'Thiago', 'Vanessa', 'Wagner', 'Yara'];
const _LAST = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Pereira', 'Lima', 'Costa', 'Almeida', 'Nunes', 'Rocha', 'Carvalho', 'Gomes', 'Martins', 'Araujo', 'Ribeiro', 'Barbosa'];
const _SECTOR = ['Comércio', 'Serviços', 'Tecnologia', 'Logística', 'Indústria', 'Consultoria', 'Telecom', 'Varejo', 'Agro', 'Saúde'];
const _DDD = { AC: '68', AL: '82', AP: '96', AM: '92', BA: '71', CE: '85', DF: '61', ES: '27', GO: '62', MA: '98', MT: '65', MS: '67', MG: '31', PA: '91', PB: '83', PR: '41', PE: '81', PI: '86', RJ: '21', RN: '84', RS: '51', RO: '69', RR: '95', SC: '48', SP: '11', SE: '79', TO: '63' };

router.post('/auto-create', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {}; const orgId = b.orgId || 36; const object = b.object || 'Lead';
    const count = Math.max(1, Math.min(100, parseInt(b.count, 10) || 0));
    const uf = (b.uf || '').toUpperCase(); const city = b.city || '';
    if (!count || !uf || !city) return res.status(400).json({ ok: false, error: 'count, uf e city são obrigatórios' });
    if (!WRITE_ORGS.has(Number(orgId))) return res.json({ ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` });
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    const dl = await describeLayoutsRaw(conn, object);
    const nac = (dl.recordTypeMappings || []).find((m) => m.defaultRecordTypeMapping) || (dl.recordTypeMappings || []).find((m) => /^nacional$/i.test(m.name));
    const rtId = b.recordTypeId || (nac && nac.recordTypeId);
    const desc = await describeCached(conn, object, orgId);
    const fld = (n) => (desc.fields || []).find((f) => f.name === n);
    const pv = (n, prefer) => { const f = fld(n); if (!f || !f.picklistValues) return prefer; const vals = f.picklistValues.filter((p) => p.active).map((p) => p.value); if (prefer && vals.includes(prefer)) return prefer; return vals[0] || prefer; };
    const status = pv('Status', 'Novo'); const source = pv('LeadSource', 'Outros');
    const ddd = _DDD[uf] || '11';
    const hasCNPJ = !!fld('CNPJ__c'), hasCity = !!fld('City'), hasState = !!fld('State'), hasCountry = !!fld('Country');
    const recs = [];
    for (let i = 0; i < count; i++) {
      const fn = _FIRST[Math.floor(Math.random() * _FIRST.length)], ln = _LAST[Math.floor(Math.random() * _LAST.length)];
      const r = {
        FirstName: fn, LastName: ln,
        Company: `${ln} ${_SECTOR[Math.floor(Math.random() * _SECTOR.length)]} ${1000 + Math.floor(Math.random() * 9000)} Ltda`,
        Status: status, LeadSource: source,
        Email: `${fn}.${ln}${i}@exemplo.com.br`.toLowerCase(),
        Phone: `(${ddd}) 9${Math.floor(10000000 + Math.random() * 89999999)}`,
      };
      if (hasCity) r.City = city;
      if (hasState) r.State = uf;
      if (hasCountry) r.Country = 'Brasil';
      if (hasCNPJ) r.CNPJ__c = genCNPJ();
      if (rtId) r.RecordTypeId = rtId;
      recs.push(r);
    }
    const out = await conn.sobject(object).create(recs, { allOrNone: false });
    const arr = Array.isArray(out) ? out : [out];
    const okIds = arr.filter((x) => x.success).map((x) => x.id);
    const errs = arr.filter((x) => !x.success).map((x) => x.errors);
    return res.json({ ok: true, created: okIds.length, failed: arr.length - okIds.length, ids: okIds.slice(0, 50), sampleErrors: errs.slice(0, 3), city, uf, recordTypeId: rtId });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// POST /api/agent-farm/call-log — salva transcrição da ligação na Task e anexa o áudio
router.post('/call-log', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {}; const orgId = b.orgId || 36;
    if (!b.leadId) return res.status(400).json({ ok: false, error: 'leadId obrigatório' });
    if (!WRITE_ORGS.has(Number(orgId))) return res.json({ ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` });
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    const dur = b.durationSec ? ` · duração ${Math.floor(b.durationSec / 60)}m${String(b.durationSec % 60).padStart(2, '0')}s` : '';
    const transcript = (b.transcript || '').trim();
    const desc = ('TRANSCRIÇÃO DA LIGAÇÃO' + dur + '\n' + (transcript || '(sem fala reconhecida)')).slice(0, 31000);
    const base = { WhoId: b.leadId, Subject: 'Ligação (gravada)', Status: 'Completed', Description: desc, ActivityDate: new Date().toISOString().slice(0, 10) };
    let task;
    try { task = await conn.sobject('Task').create({ ...base, Type: 'Call' }); }
    catch (e) { task = await conn.sobject('Task').create(base); }
    if (!task.success) return res.json({ ok: false, error: JSON.stringify(task.errors) });
    let fileId = null;
    if (b.audio) {
      try {
        const ext = /ogg/.test(b.mime || '') ? 'ogg' : (/mp4|aac/.test(b.mime || '') ? 'm4a' : 'webm');
        const cv = await conn.sobject('ContentVersion').create({
          Title: 'Ligacao_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'),
          PathOnClient: 'ligacao.' + ext,
          VersionData: b.audio,
          FirstPublishLocationId: task.id,
        });
        if (cv.success) {
          fileId = cv.id;
          try {
            const q = await conn.query(`SELECT ContentDocumentId FROM ContentVersion WHERE Id='${cv.id}'`);
            const docId = q.records && q.records[0] && q.records[0].ContentDocumentId;
            if (docId) await conn.sobject('ContentDocumentLink').create({ ContentDocumentId: docId, LinkedEntityId: b.leadId, ShareType: 'V' });
          } catch (e2) {}
        }
      } catch (e) {}
    }
    return res.json({ ok: true, taskId: task.id, fileId, chars: transcript.length });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── Farm Maps: camadas no mapa + ações de visita (check-in/out nos campos do épico Visitas) ──
const GPON_TERR = [
  { city: 'Uberlândia', uf: 'MG', lat: -18.9186, lng: -48.2772, km: 14 }, { city: 'Uberaba', uf: 'MG', lat: -19.7472, lng: -47.9381, km: 10 },
  { city: 'Araguari', uf: 'MG', lat: -18.6489, lng: -48.1930, km: 7 }, { city: 'Patos de Minas', uf: 'MG', lat: -18.5789, lng: -46.5181, km: 7 },
  { city: 'Ituiutaba', uf: 'MG', lat: -18.9772, lng: -49.4639, km: 6 }, { city: 'Araxá', uf: 'MG', lat: -19.5902, lng: -46.9438, km: 6 },
  { city: 'Patrocínio', uf: 'MG', lat: -18.9436, lng: -46.9925, km: 5 }, { city: 'Franca', uf: 'SP', lat: -20.5386, lng: -47.4008, km: 8 },
  { city: 'Ribeirão Preto', uf: 'SP', lat: -21.1775, lng: -47.8103, km: 12 }, { city: 'Campinas', uf: 'SP', lat: -22.9099, lng: -47.0626, km: 12 },
  { city: 'São José do Rio Preto', uf: 'SP', lat: -20.8113, lng: -49.3758, km: 8 }, { city: 'Goiânia', uf: 'GO', lat: -16.6869, lng: -49.2648, km: 12 },
  { city: 'Anápolis', uf: 'GO', lat: -16.3281, lng: -48.9530, km: 7 }, { city: 'Rio Verde', uf: 'GO', lat: -17.7923, lng: -50.9192, km: 6 },
  { city: 'Itumbiara', uf: 'GO', lat: -18.4192, lng: -49.2150, km: 5 }, { city: 'Divinópolis', uf: 'MG', lat: -20.1446, lng: -44.8912, km: 6 },
];
function havKm(a, b) { const R = 6371, dLa = (b[0] - a[0]) * Math.PI / 180, dLo = (b[1] - a[1]) * Math.PI / 180; const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
const UF_CENTER = { AC: [-9.02, -70.81], AL: [-9.57, -36.78], AP: [1.41, -51.77], AM: [-4.15, -63.15], BA: [-12.58, -41.7], CE: [-5.2, -39.53], DF: [-15.78, -47.93], ES: [-19.19, -40.34], GO: [-15.98, -49.86], MA: [-5.42, -45.44], MT: [-12.95, -55.51], MS: [-20.51, -54.54], MG: [-18.51, -44.55], PA: [-3.79, -52.48], PB: [-7.12, -36.72], PR: [-24.89, -51.55], PE: [-8.38, -37.86], PI: [-7.72, -42.97], RJ: [-22.25, -42.66], RN: [-5.81, -36.59], RS: [-29.75, -53.32], RO: [-10.83, -63.34], RR: [2.05, -61.4], SC: [-27.45, -50.95], SP: [-22.19, -48.79], SE: [-10.57, -37.44], TO: [-9.46, -48.26] };
const _geo = {};
async function geocodeText(q) {
  const key = ('txt|' + q).toLowerCase();
  if (_geo[key]) return _geo[key];
  try {
    const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=' + encodeURIComponent(q + ', Brasil');
    const r = await fetch(u, { headers: { 'User-Agent': 'everi9-farm/1.0 (contato@everi9.com)' } });
    const j = await r.json();
    if (j && j[0]) { _geo[key] = [parseFloat(j[0].lat), parseFloat(j[0].lon)]; return _geo[key]; }
  } catch (e) {}
  return null;
}
async function geocodeCity(city, uf) {
  const key = (city + '|' + uf).toLowerCase();
  if (_geo[key]) return _geo[key];
  try {
    const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=' + encodeURIComponent(city + ', ' + uf + ', Brasil');
    const r = await fetch(u, { headers: { 'User-Agent': 'everi9-farm/1.0 (contato@everi9.com)' } });
    const j = await r.json();
    if (j && j[0]) { _geo[key] = [parseFloat(j[0].lat), parseFloat(j[0].lon)]; return _geo[key]; }
  } catch (e) {}
  return null;
}
function jitter(id, base) {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const dx = ((h % 1000) / 1000 - 0.5) * 0.06, dy = (((h >> 10) % 1000) / 1000 - 0.5) * 0.06;
  return [base[0] + dx, base[1] + dy];
}
async function coordsFor(recs, cityF, stateF, latF, lngF, budget) {
  let newGeo = 0; const MAXG = budget || 8;
  const out = [];
  for (const r of recs) {
    let pos = null;
    if (latF && r[latF] != null && r[lngF] != null) pos = [r[latF], r[lngF]];
    else {
      const city = r[cityF], uf = (r[stateF] || '').toUpperCase().slice(0, 2);
      if (city && uf) {
        const key = (city + '|' + uf).toLowerCase();
        if (_geo[key]) pos = jitter(r.Id, _geo[key]);
        else if (newGeo < MAXG) { newGeo++; const g = await geocodeCity(city, uf); if (g) pos = jitter(r.Id, g); }
        if (!pos && UF_CENTER[uf]) pos = jitter(r.Id, UF_CENTER[uf]);
      } else if (UF_CENTER[uf]) pos = jitter(r.Id, UF_CENTER[uf]);
    }
    if (pos) out.push({ ...r, _lat: pos[0], _lng: pos[1] });
  }
  return out;
}
router.get('/map-data', authMiddleware, async (req, res) => {
  try {
    const orgId = req.query.orgId || 36;
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    const boost = req.query.boost === '1';
    // Prioriza leads com coordenadas reais (plotam sem gastar geocode). Ordena por lat preenchida primeiro.
    const lq = await conn.query("SELECT Id,Name,FirstName,LastName,Company,City,State,Street,PostalCode,Latitude,Longitude,Status,Rating,Phone,MobilePhone,Email,CNPJ__c,Segmento__c,Industry,LeadSource FROM Lead WHERE IsConverted=false AND (Latitude != null OR City != null OR State != null) ORDER BY Latitude NULLS LAST, CreatedDate DESC LIMIT 800");
    const aq = await conn.query("SELECT Id,Name,BillingCity,BillingState,BillingLatitude,BillingLongitude,Phone,Industry FROM Account WHERE BillingLatitude != null OR BillingCity != null OR BillingState != null ORDER BY BillingLatitude NULLS LAST, LastModifiedDate DESC LIMIT 300");
    const now = new Date(); const past = new Date(now.getTime() - 7 * 864e5).toISOString(); const fut = new Date(now.getTime() + 30 * 864e5).toISOString();
    const eq = await conn.query(`SELECT Id,Subject,StartDateTime,Location,WhoId,Who.Name,CheckInDateTime__c,CheckOutDateTime__c,CheckInLatitude__c,CheckInLongitude__c,EhRelatorioVisita__c FROM Event WHERE StartDateTime >= ${past} AND StartDateTime <= ${fut} ORDER BY StartDateTime LIMIT 100`);
    const leads = await coordsFor((lq.records || []).map((r) => { delete r.attributes; return r; }), 'City', 'State', 'Latitude', 'Longitude', boost ? 25 : 8);
    const accounts = await coordsFor((aq.records || []).map((r) => { delete r.attributes; return r; }), 'BillingCity', 'BillingState', 'BillingLatitude', 'BillingLongitude', boost ? 15 : 8);
    const leadPos = {}; leads.forEach((l) => { leadPos[l.Id] = [l._lat, l._lng]; });
    let geoBudget = boost ? 15 : 5;
    const events = [];
    for (const e of (eq.records || [])) {
      let pos = null;
      if (e.CheckInLatitude__c != null) pos = [e.CheckInLatitude__c, e.CheckInLongitude__c];
      else if (e.Location && e.Location.length > 5 && !/^-?\d+\.\d+,/.test(e.Location)) {
        const key = ('txt|' + e.Location).toLowerCase();
        if (_geo[key]) pos = _geo[key];
        else if (geoBudget > 0) { geoBudget--; const g = await geocodeText(e.Location); if (g) pos = g; }
      }
      if (!pos && e.WhoId && leadPos[e.WhoId]) pos = leadPos[e.WhoId];
      if (!pos) continue;
      events.push({ Id: e.Id, Subject: e.Subject, Start: e.StartDateTime, Location: e.Location, WhoId: e.WhoId, WhoName: e.Who && e.Who.Name, CheckIn: e.CheckInDateTime__c, CheckOut: e.CheckOutDateTime__c, Report: e.EhRelatorioVisita__c, _lat: pos[0], _lng: pos[1] });
    }
    let metro = [];
    try {
      const mq = await conn.query('SELECT Id,Name,Anel_Associado__c,Neighborhood__c,Latitude__c,Longitude__c FROM Metro_Station__c WHERE Latitude__c != null LIMIT 200');
      metro = (mq.records || []).map((m) => ({ Id: m.Id, Name: m.Name, Anel: m.Anel_Associado__c, Bairro: m.Neighborhood__c, _lat: m.Latitude__c, _lng: m.Longitude__c }));
    } catch (e) {}
    // Cobertura GPON — cidades de referência do território Algar (Triângulo/interior SP/GO/oeste MG)
    const gpon = GPON_TERR;
    return res.json({ ok: true, leads, accounts, events, metro, gpon });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// POST /visit-action — checkin | checkout | schedule | task (grava nos campos do épico Visitas)
router.post('/visit-action', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {}; const orgId = b.orgId || 36;
    if (!WRITE_ORGS.has(Number(orgId))) return res.json({ ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` });
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    const nowIso = new Date().toISOString();
    if (b.kind === 'checkin') {
      let evId = b.eventId;
      if (!evId && b.recordId) {
        const q = await conn.query(`SELECT Id FROM Event WHERE WhoId='${esc1(b.recordId)}' AND CheckInDateTime__c = null AND StartDateTime >= ${new Date(Date.now() - 864e5).toISOString()} ORDER BY StartDateTime LIMIT 1`);
        if (q.records && q.records[0]) evId = q.records[0].Id;
      }
      if (!evId) {
        const nr = await conn.sobject('Event').create({ Subject: 'Visita — check-in', WhoId: b.recordId || null, StartDateTime: nowIso, EndDateTime: new Date(Date.now() + 36e5).toISOString(), Location: b.lat ? (b.lat + ',' + b.lng) : undefined });
        if (!nr.success) return res.json({ ok: false, error: JSON.stringify(nr.errors) });
        evId = nr.id;
      }
      const upd = { Id: evId, CheckInDateTime__c: nowIso };
      if (b.lat != null) { upd.CheckInLatitude__c = b.lat; upd.CheckInLongitude__c = b.lng; }
      const r = await conn.sobject('Event').update(upd);
      return res.json({ ok: !!r.success, eventId: evId, at: nowIso, errors: r.errors });
    }
    if (b.kind === 'checkout') {
      let evId = b.eventId;
      if (!evId && b.recordId) {
        const q = await conn.query(`SELECT Id,CheckInDateTime__c FROM Event WHERE WhoId='${esc1(b.recordId)}' AND CheckInDateTime__c != null AND CheckOutDateTime__c = null ORDER BY CheckInDateTime__c DESC LIMIT 1`);
        if (q.records && q.records[0]) evId = q.records[0].Id;
      }
      if (!evId) return res.json({ ok: false, error: 'nenhum check-in aberto para este registro — faça o check-in primeiro' });
      const q2 = await conn.query(`SELECT CheckInDateTime__c,EhRelatorioVisita__c FROM Event WHERE Id='${esc1(evId)}'`);
      const rec2 = (q2.records && q2.records[0]) || {};
      if (rec2.EhRelatorioVisita__c !== 'Sim') return res.json({ ok: false, needReport: true, eventId: evId, error: 'Preencha o relatório de visita antes do check-out 📋' });
      const ci = rec2.CheckInDateTime__c;
      const durMin = ci ? Math.round((Date.now() - new Date(ci).getTime()) / 60000) : null;
      const upd = { Id: evId, CheckOutDateTime__c: nowIso };
      if (b.lat != null) { upd.CheckOutLatitude__c = b.lat; upd.CheckOutLongitude__c = b.lng; }
      if (durMin != null) upd.VisitDuration__c = durMin;
      if (b.notes) upd.Observacoes_Visita__c = b.notes;
      const r = await conn.sobject('Event').update(upd);
      return res.json({ ok: !!r.success, eventId: evId, at: nowIso, durationMin: durMin, errors: r.errors });
    }
    if (b.kind === 'address') {
      if (!b.eventId || !b.address) return res.json({ ok: false, error: 'eventId e address obrigatórios' });
      const r = await conn.sobject('Event').update({ Id: b.eventId, Location: b.address });
      const g = await geocodeText(b.address);
      return res.json({ ok: !!r.success, eventId: b.eventId, geocoded: !!g, lat: g && g[0], lng: g && g[1], errors: r.errors });
    }
    if (b.kind === 'schedule') {
      if (!b.startDateTime) return res.json({ ok: false, error: 'startDateTime obrigatório' });
      const st = new Date(b.startDateTime);
      const ev = { Subject: b.subject || 'Visita', WhoId: b.recordId || null, StartDateTime: st.toISOString(), EndDateTime: new Date(st.getTime() + 36e5).toISOString(), Location: b.location };
      const r = await conn.sobject('Event').create(ev);
      return res.json({ ok: !!r.success, eventId: r.id, errors: r.errors });
    }
    if (b.kind === 'task') {
      const t = { WhoId: b.recordId || null, Subject: b.subject || 'Follow-up da visita', Status: 'Not Started', ActivityDate: (b.dueDate || new Date(Date.now() + 864e5).toISOString().slice(0, 10)) };
      let r; try { r = await conn.sobject('Task').create(t); } catch (e) { delete t.Status; r = await conn.sobject('Task').create(t); }
      return res.json({ ok: !!(r && r.success), taskId: r && r.id, errors: r && r.errors });
    }
    return res.status(400).json({ ok: false, error: 'kind inválido' });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// GET /api/agent-farm/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — agendamentos do período
router.get('/calendar', authMiddleware, async (req, res) => {
  try {
    const orgId = req.query.orgId || 36;
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    const from = new Date((req.query.from || new Date().toISOString().slice(0, 10)) + 'T00:00:00-03:00').toISOString();
    const to = new Date((req.query.to || new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)) + 'T23:59:59-03:00').toISOString();
    const q = await conn.query(`SELECT Id,Subject,StartDateTime,EndDateTime,Location,Who.Name,What.Name,CheckInDateTime__c,CheckOutDateTime__c FROM Event WHERE StartDateTime >= ${from} AND StartDateTime <= ${to} ORDER BY StartDateTime LIMIT 400`);
    const events = (q.records || []).map((e) => ({ id: e.Id, subject: e.Subject, start: e.StartDateTime, end: e.EndDateTime, location: e.Location, who: e.Who && e.Who.Name, what: e.What && e.What.Name, checkin: e.CheckInDateTime__c, checkout: e.CheckOutDateTime__c }));
    return res.json({ ok: true, events });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── Relatório de Visita (disponível só após check-in; obrigatório p/ check-out) ──
router.get('/visit-report-meta', authMiddleware, async (req, res) => {
  try {
    const orgId = req.query.orgId || 36; const eventId = req.query.eventId;
    if (!eventId) return res.status(400).json({ ok: false, error: 'eventId obrigatório' });
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    const q = await conn.query(`SELECT Id,Subject,WhoId,Who.Name,Location,CheckInDateTime__c,CheckOutDateTime__c,Motivo_Visita__c,Observacoes_Visita__c,EhRelatorioVisita__c FROM Event WHERE Id='${esc1(eventId)}'`);
    const ev = q.records && q.records[0];
    if (!ev) return res.json({ ok: false, error: 'evento não encontrado' });
    const preCheckin = !ev.CheckInDateTime__c;
    const desc = await describeCached(conn, 'Event', orgId);
    const mot = (desc.fields || []).find((f) => f.name === 'Motivo_Visita__c');
    const motivos = mot ? (mot.picklistValues || []).filter((p) => p.active).map((p) => p.value) : [];
    let addr = { rua: '', cidade: '', estado: '', cep: '' }; let isLead = false;
    if (ev.WhoId && ev.WhoId.startsWith('00Q')) {
      isLead = true;
      const lq = await conn.query(`SELECT EnderecoVisitaRua__c,EnderecoVisitaCidade__c,EnderecoVisitaEstado__c,EnderecoVisitaCEP__c,City,State,Street,PostalCode FROM Lead WHERE Id='${esc1(ev.WhoId)}'`);
      const l = lq.records && lq.records[0];
      if (l) addr = { rua: l.EnderecoVisitaRua__c || l.Street || '', cidade: l.EnderecoVisitaCidade__c || l.City || '', estado: l.EnderecoVisitaEstado__c || l.State || '', cep: l.EnderecoVisitaCEP__c || l.PostalCode || '' };
    }
    return res.json({ ok: true, preCheckin, event: { id: ev.Id, subject: ev.Subject, whoId: ev.WhoId, whoName: ev.Who && ev.Who.Name, checkin: ev.CheckInDateTime__c, checkout: ev.CheckOutDateTime__c, motivo: ev.Motivo_Visita__c, observacoes: ev.Observacoes_Visita__c, done: ev.EhRelatorioVisita__c === 'Sim' }, motivos, addr, isLead });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post('/visit-report', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {}; const orgId = b.orgId || 36;
    if (!WRITE_ORGS.has(Number(orgId))) return res.json({ ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` });
    if (!b.eventId || !b.motivo || !b.observacoes) return res.json({ ok: false, error: 'motivo e observações são obrigatórios' });
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    const q = await conn.query(`SELECT WhoId,CheckInDateTime__c FROM Event WHERE Id='${esc1(b.eventId)}'`);
    const ev = q.records && q.records[0];
    if (!ev) return res.json({ ok: false, error: 'evento não encontrado' });
    if (!ev.CheckInDateTime__c) return res.json({ ok: false, error: 'faça o check-in antes de preencher o relatório 📍' });
    const a = b.endereco || {};
    const locStr = [a.rua, a.cidade, a.estado].filter(Boolean).join(', ');
    const updEv = { Id: b.eventId, Motivo_Visita__c: b.motivo, Observacoes_Visita__c: b.observacoes, EhRelatorioVisita__c: 'Sim' };
    if (locStr) updEv.Location = locStr;
    const r = await conn.sobject('Event').update(updEv);
    let geocoded = false;
    if (ev.WhoId && ev.WhoId.startsWith('00Q') && (a.rua || a.cidade)) {
      const updLd = { Id: ev.WhoId };
      if (a.rua != null) updLd.EnderecoVisitaRua__c = a.rua;
      if (a.cidade != null) updLd.EnderecoVisitaCidade__c = a.cidade;
      if (a.estado != null) updLd.EnderecoVisitaEstado__c = a.estado;
      if (a.cep != null) updLd.EnderecoVisitaCEP__c = a.cep;
      const g = await geocodeText(locStr || (a.cidade + ', ' + a.estado));
      if (g) { updLd.EnderecoVisitaLatitude__c = g[0]; updLd.EnderecoVisitaLongitude__c = g[1]; geocoded = true; }
      try { await conn.sobject('Lead').update(updLd); } catch (e) {}
    }
    return res.json({ ok: !!r.success, eventId: b.eventId, geocoded, errors: r.errors });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── Integrações MuleSoft: enriquecimento Neoway + cobertura de rede ──
const NEOWAY_URL = process.env.MULESOFT_NEOWAY_URL || 'https://i9-mcp-da48589780b2.herokuapp.com/api/mock/neoway/empresa/';
const COVERAGE_URL = process.env.MULESOFT_COVERAGE_URL || null;
async function neowayEnrich(conn, leadId) {
  const q = await conn.query(`SELECT Id,Name,Company,CNPJ__c,RecordType.DeveloperName,Street,City,State,PostalCode FROM Lead WHERE Id='${esc1(leadId)}'`);
  const l = q.records && q.records[0];
  if (!l) return { ok: false, error: 'lead não encontrada' };
  if (l.RecordType && l.RecordType.DeveloperName && l.RecordType.DeveloperName !== 'Nacional') {
    return { ok: false, error: 'regra da org: enriquecimento só para leads Nacional (RT atual: ' + l.RecordType.DeveloperName + ')' };
  }
  const cnpj = String(l.CNPJ__c || '').replace(/\D/g, '');
  if (!cnpj) return { ok: false, error: 'lead sem CNPJ preenchido' };
  const enderecoVazio = !l.Street && !l.City && !l.State && !l.PostalCode;
  // Regra da org (Flow Enriquecimento): 1º busca cliente na base por CNPJ
  let acc = null;
  try {
    const aq = await conn.query(`SELECT Id,Name,Industry,PorteEmpresa__c,FaixaFuncionarios__c,TicketPotencial__c,BillingStreet,BillingCity,BillingState,BillingPostalCode,BillingCountry,Bairro__c,Numero__c,Complemento__c FROM Account WHERE CNPJSemPontuacao__c='${esc1(cnpj)}' OR CNPJ__c='${esc1(l.CNPJ__c)}' LIMIT 1`);
    acc = aq.records && aq.records[0];
  } catch (e) {}
  if (acc) {
    const upd = { Id: leadId, Company: acc.Name, RelacionamentoLead__c: 'Base Existente',
      PorteEmpresa__c: acc.PorteEmpresa__c || null, PorteEmpresaEnrichStatus__c: acc.PorteEmpresa__c ? 'OK' : 'VAZIO',
      FaixaFuncionarios__c: acc.FaixaFuncionarios__c || null, FaixaFuncionariosEnrichStatus__c: acc.FaixaFuncionarios__c ? 'OK' : 'VAZIO',
      TicketPotencial__c: acc.TicketPotencial__c != null ? acc.TicketPotencial__c : null, TicketPotencialEnrichStatus__c: acc.TicketPotencial__c != null ? 'OK' : 'VAZIO' };
    if (acc.Industry) upd.Industry = acc.Industry;
    if (enderecoVazio) {
      if (acc.BillingStreet) upd.Street = acc.BillingStreet;
      if (acc.BillingCity) upd.City = acc.BillingCity;
      if (acc.BillingState) upd.State = acc.BillingState;
      if (acc.BillingPostalCode) upd.PostalCode = acc.BillingPostalCode;
      if (acc.BillingCountry) upd.Country = acc.BillingCountry;
      if (acc.Bairro__c) upd.Bairro__c = acc.Bairro__c;
      if (acc.Numero__c) upd.Numero__c = acc.Numero__c;
      if (acc.Complemento__c) upd.Complemento__c = acc.Complemento__c;
    }
    try { await conn.sobject('Lead').update(upd); }
    catch (e) { delete upd.FaixaFuncionarios__c; delete upd.PorteEmpresa__c; try { await conn.sobject('Lead').update(upd); } catch (e2) { return { ok: false, error: String(e2.message || e2) }; } }
    try { await conn.sobject('FeedItem').create({ ParentId: leadId, Type: 'TextPost', Body: `⚡ Enriquecimento (regra da org): cliente da BASE EXISTENTE → ${acc.Name} · porte ${acc.PorteEmpresa__c || '—'} · ticket R$ ${(acc.TicketPotencial__c || 0).toLocaleString('pt-BR')}` }); } catch (e) {}
    return { ok: true, relacionamento: 'Base Existente', accountId: acc.Id, data: { porte: acc.PorteEmpresa__c, faixa_funcionarios: acc.FaixaFuncionarios__c, ticket_potencial: acc.TicketPotencial__c, segmento: null, situacao_cadastral: null, company: acc.Name } };
  }
  // Não é da base → API externa (Neoway) e Novo Cliente
  let resp = null, status = 0;
  try { const r = await fetch(NEOWAY_URL + cnpj, { headers: { Accept: 'application/json' } }); status = r.status; if (r.ok) resp = (await r.json()).data; } catch (e) {}
  const st = (v) => (v != null && v !== '' ? 'OK' : 'VAZIO');
  if (!resp) {
    try { await conn.sobject('Lead').update({ Id: leadId, RelacionamentoLead__c: 'Novo Cliente', PorteEmpresaEnrichStatus__c: 'ERRO', FaixaFuncionariosEnrichStatus__c: 'ERRO', TicketPotencialEnrichStatus__c: 'ERRO', SituacaoCadastralEnrichStatus__c: 'ERRO' }); } catch (e) {}
    return { ok: false, error: status === 404 ? 'CNPJ não encontrado na base Neoway' : ('falha na consulta Neoway (' + status + ')') };
  }
  const segMap = { EMPRESARIAL: 'Empresarial', CORPORATIVO: 'Corporativo', OPERADORAS: 'Operadoras' };
  const seg = segMap[String(resp.segmento || '').toUpperCase()] || resp.segmento || null;
  const upd = { Id: leadId, RelacionamentoLead__c: 'Novo Cliente',
    PorteEmpresa__c: resp.porte || null, PorteEmpresaEnrichStatus__c: st(resp.porte),
    FaixaFuncionarios__c: resp.faixa_funcionarios || null, FaixaFuncionariosEnrichStatus__c: st(resp.faixa_funcionarios),
    TicketPotencial__c: resp.ticket_potencial != null ? resp.ticket_potencial : null, TicketPotencialEnrichStatus__c: st(resp.ticket_potencial),
    SituacaoCadastral__c: resp.situacao_cadastral || null, SituacaoCadastralEnrichStatus__c: st(resp.situacao_cadastral) };
  if (seg) upd.Segmento__c = seg;
  if (enderecoVazio) {
    if (resp.logradouro) upd.Street = [resp.logradouro, resp.numero, resp.complemento].filter(Boolean).join(', ');
    if (resp.cidade) upd.City = resp.cidade;
    if (resp.estado) upd.State = resp.estado;
    if (resp.cep) upd.PostalCode = resp.cep;
    if (resp.bairro) upd.Bairro__c = resp.bairro;
  }
  try { await conn.sobject('Lead').update(upd); }
  catch (e) {
    for (const k of ['FaixaFuncionarios__c', 'Segmento__c', 'PorteEmpresa__c', 'SituacaoCadastral__c']) delete upd[k];
    try { await conn.sobject('Lead').update(upd); } catch (e2) { return { ok: false, error: String(e2.message || e2) }; }
  }
  try { await conn.sobject('FeedItem').create({ ParentId: leadId, Type: 'TextPost', Body: `⚡ Enriquecimento Neoway (regra da org): NOVO CLIENTE · porte ${resp.porte || '—'} · ${resp.faixa_funcionarios || '—'} · ticket R$ ${(resp.ticket_potencial || 0).toLocaleString('pt-BR')} · situação ${resp.situacao_cadastral || '—'} · segmento ${seg || '—'}${enderecoVazio ? ' · endereço preenchido' : ' · endereço preservado (já preenchido)'}` }); } catch (e) {}
  return { ok: true, relacionamento: 'Novo Cliente', data: { ...resp, segmento: seg } };
}
async function coverageCheck(conn, leadId) {
  const q = await conn.query(`SELECT Id,Name,Street,City,State,Bairro__c,EnderecoVisitaCidade__c,EnderecoVisitaEstado__c,EnderecoVisitaLatitude__c,EnderecoVisitaLongitude__c FROM Lead WHERE Id='${esc1(leadId)}'`);
  const l = q.records && q.records[0];
  if (!l) return { ok: false, error: 'lead não encontrada' };
  // Regra da org (Flow Cobertura Rede): endereço completo obrigatório
  const faltam = [];
  if (!l.Street) faltam.push('rua');
  if (!l.Bairro__c) faltam.push('bairro');
  if (!l.City) faltam.push('cidade');
  if (!l.State) faltam.push('UF');
  if (faltam.length) return { ok: false, error: 'regra da org: endereço completo obrigatório para consultar cobertura — falta ' + faltam.join(', ') };
  let pos = null;
  if (l.EnderecoVisitaLatitude__c != null) pos = [l.EnderecoVisitaLatitude__c, l.EnderecoVisitaLongitude__c];
  if (!pos) pos = await geocodeText([l.Street, l.Bairro__c, l.City, l.State].filter(Boolean).join(', '));
  if (!pos) { const city = l.EnderecoVisitaCidade__c || l.City, uf = l.EnderecoVisitaEstado__c || l.State; if (city && uf) pos = await geocodeCity(city, String(uf).slice(0, 2).toUpperCase()); }
  if (!pos) return { ok: false, error: 'não consegui geocodificar o endereço da lead' };
  if (COVERAGE_URL) {
    try { const r = await fetch(COVERAGE_URL + '?lat=' + pos[0] + '&lng=' + pos[1]); if (r.ok) { const d = await r.json(); return { ok: true, source: 'mulesoft', hasViability: !!(d.summary && d.summary.hasViability), ...d }; } } catch (e) {}
  }
  let bg = null; for (const g of GPON_TERR) { const d = havKm(pos, [g.lat, g.lng]); if (!bg || d < bg.distKm) bg = { city: g.city, uf: g.uf, distKm: d, km: g.km }; }
  const gpon = { available: bg ? bg.distKm <= bg.km : false, city: bg && bg.city, distKm: bg && Math.round(bg.distKm * 10) / 10 };
  let bm = null;
  try {
    const mq = await conn.query('SELECT Name,Anel_Associado__c,Latitude__c,Longitude__c FROM Metro_Station__c WHERE Latitude__c != null');
    for (const m of (mq.records || [])) { const d = havKm(pos, [m.Latitude__c, m.Longitude__c]); if (!bm || d < bm.distKm) bm = { station: m.Name, anel: m.Anel_Associado__c, distKm: d }; }
  } catch (e) {}
  const metro = { available: bm ? bm.distKm <= 2.5 : false, station: bm && bm.station, anel: bm && bm.anel, distKm: bm && Math.round(bm.distKm * 10) / 10 };
  const hasViability = !!(gpon.available || metro.available);
  const parecer = `📡 Cobertura de rede (endereço completo ✓): hasViability ${hasViability ? '✅' : '❌'} · GPON ${gpon.available ? '✅ disponível' : '❌ fora da mancha'} (${gpon.city || '—'}, ${gpon.distKm != null ? gpon.distKm + ' km' : '—'}) · Metro ${metro.available ? '✅ ' + metro.station + ' / ' + (metro.anel || '') : '❌ sem estação próxima'}${metro.distKm != null ? ' (' + metro.distKm + ' km)' : ''}`;
  try { await conn.sobject('FeedItem').create({ ParentId: leadId, Type: 'TextPost', Body: parecer }); } catch (e) {}
  return { ok: true, source: 'territorio', hasViability, gpon, metro, parecer, pos };
}
router.post('/enrich', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {}; const orgId = b.orgId || 36;
    if (!WRITE_ORGS.has(Number(orgId))) return res.json({ ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` });
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    return res.json(await neowayEnrich(conn, b.leadId));
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
router.post('/coverage', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {}; const orgId = b.orgId || 36;
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    return res.json(await coverageCheck(conn, b.leadId));
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// GET /api/agent-farm/whoami — usuário Salesforce da org conectada
router.get('/whoami', authMiddleware, async (req, res) => {
  try {
    const orgId = req.query.orgId || 36;
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    const id = await conn.identity();
    const name = id.display_name || id.username || '';
    return res.json({ ok: true, name, firstName: name.split(' ')[0] || name });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// POST /api/agent-farm/advance-status — avança/retrocede status da Lead respeitando regras
router.post('/advance-status', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {}; const orgId = b.orgId || 36;
    if (!WRITE_ORGS.has(Number(orgId))) return res.json({ ok: false, error: `escrita bloqueada na org ${orgId} (read-only)` });
    if (!b.leadId || !b.newStatus) return res.json({ ok: false, error: 'leadId e newStatus obrigatórios' });
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false, error: 'org' });
    const conn = await connToOrg(org);
    const q = await conn.query(`SELECT Id,Status,Segmento__c,OrcamentoDisponivel__c,NivelDecisaoContrato__c,NecessidadeIdentificada__c,PrazoContratacao__c,ProdutosEmpresa__c,FornecedoresEmpresa__c,Motivo_cancelamento__c FROM Lead WHERE Id='${esc1(b.leadId)}'`);
    const lead = q.records && q.records[0];
    if (!lead) return res.json({ ok: false, error: 'lead não encontrada' });
    const cur = lead.Status;
    const next = b.newStatus;
    // regra: cancelado não reabre
    if (cur === 'Cancelado') return res.json({ ok: false, error: 'Lead cancelado não pode ter o status alterado.', rule: 'cancelledNoReopen' });
    // regra: cancelamento exige motivo
    if (next === 'Cancelado') {
      if (!b.motivo) return res.json({ ok: false, needMotivo: true, error: 'Informe o motivo do cancelamento.' });
      const r = await conn.sobject('Lead').update({ Id: b.leadId, Status: 'Cancelado', Motivo_cancelamento__c: b.motivo });
      return res.json({ ok: !!r.success, errors: r.errors });
    }
    // regra: avançar pra Conversao exige BANT
    if (next === 'Conversao' && cur === 'Qualificacao') {
      const falta = [];
      if (!lead.OrcamentoDisponivel__c) falta.push('Orçamento Disponível');
      if (!lead.NivelDecisaoContrato__c) falta.push('Nível de Decisão');
      if (!lead.NecessidadeIdentificada__c) falta.push('Necessidade Identificada');
      if (!lead.PrazoContratacao__c) falta.push('Prazo de Contratação');
      if (!lead.ProdutosEmpresa__c) falta.push('Produtos da Empresa');
      if (lead.Segmento__c !== 'Operadoras' && !lead.FornecedoresEmpresa__c) falta.push('Fornecedores');
      if (falta.length) return res.json({ ok: false, needBANT: true, missing: falta, error: 'Para avançar para Conversão, preencha: ' + falta.join(', ') });
    }
    const r = await conn.sobject('Lead').update({ Id: b.leadId, Status: next });
    return res.json({ ok: !!r.success, errors: r.errors });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── Listagens diretas (sem IA — zero crédito) ──
router.get('/list-leads', authMiddleware, async (req, res) => {
  try {
    const orgId = req.query.orgId || 36;
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false });
    const conn = await connToOrg(org);
    const limit = Math.min(Number(req.query.limit) || 15, 50);
    const offset = Number(req.query.offset) || 0;
    const q = await conn.query(`SELECT Id,Name,Company,Status,Rating,Phone,Email,City,CreatedDate FROM Lead WHERE IsConverted=false ORDER BY CreatedDate DESC LIMIT ${limit} OFFSET ${offset}`);
    const total = await conn.query('SELECT COUNT() FROM Lead WHERE IsConverted=false');
    return res.json({ ok: true, records: (q.records||[]).map(r=>{delete r.attributes;return r;}), total: total.totalSize, limit, offset });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message||e) }); }
});
router.get('/list-tasks', authMiddleware, async (req, res) => {
  try {
    const orgId = req.query.orgId || 36;
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false });
    const conn = await connToOrg(org);
    const q = await conn.query("SELECT Id,Subject,Status,ActivityDate,Who.Name,Priority FROM Task WHERE Status != 'Completed' ORDER BY ActivityDate NULLS LAST LIMIT 20");
    return res.json({ ok: true, records: (q.records||[]).map(r=>{const o={Id:r.Id,Subject:r.Subject,Status:r.Status,Date:r.ActivityDate,Who:r.Who&&r.Who.Name,Priority:r.Priority};return o;}) });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message||e) }); }
});
router.get('/list-events', authMiddleware, async (req, res) => {
  try {
    const orgId = req.query.orgId || 36;
    const org = await getOrgById(orgId); if (!org) return res.status(404).json({ ok: false });
    const conn = await connToOrg(org);
    const q = await conn.query("SELECT Id,Subject,StartDateTime,Location,Who.Name FROM Event WHERE StartDateTime >= TODAY ORDER BY StartDateTime LIMIT 20");
    return res.json({ ok: true, records: (q.records||[]).map(r=>({Id:r.Id,Subject:r.Subject,Start:r.StartDateTime,Location:r.Location,Who:r.Who&&r.Who.Name})) });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message||e) }); }
});

export default router;
