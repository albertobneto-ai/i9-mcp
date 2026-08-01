// src/routes/agent-farm.js — Farm de Agentes Agentforce (Ever i9)
// Provisiona um agente REAL (Bot + GenAiPlanner) via Metadata API v63 e ativa via ConnectApi.
// Receita validada empiricamente contra arqevery (org 36): GenAiPlanner é válido em v60-63;
// v64 exige GenAiPlannerBundle. Deploy em v63 + ativação ConnectApi.BotVersionActivation.
import express from 'express';
import AdmZip from 'adm-zip';
import jsforce from 'jsforce';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { authMiddleware } from '../middleware/auth.js';
import pool from '../config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_TPL = readFileSync(join(__dirname, '../services/agent-farm-template.xml'), 'utf8');

const router = express.Router();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getOrgById(id) {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return r.rows[0];
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// DeveloperName seguro: letras/dígitos/_ , começa com letra
function slugify(name) {
  let s = String(name || 'Agente')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = 'Agente';
  if (!/^[a-zA-Z]/.test(s)) s = 'A_' + s;
  return s.slice(0, 60);
}

const CAP_ACT = {
  'Criar registro': 'Create Record', 'Consultar dados': 'Query Records',
  'Resumir': 'Summarize Record', 'Recomendar': 'recomendacao (NBA) via prompt',
  'Buscar conhecimento (RAG)': 'Retriever/RAG sobre Data 360', 'Atualizar registro': 'Update Record',
  'Integrar externo (MCP)': 'MCP tool', 'Enviar e-mail': 'Send Email',
};

function composePersona({ name, domain, job, tone, caps, rules }) {
  const acts = (caps && caps.length ? caps : ['Consultar dados']).map((c) => CAP_ACT[c] || c).join(', ');
  return (
    `Voce e ${name}, um agente Agentforce criado sob medida pela farm de agentes do Ever i9 na org sandbox arqevery` +
    (domain ? `, no dominio de ${domain}` : '') + '. ' +
    `Seu trabalho: ${job || 'ajudar o usuario no que for pedido dentro do seu dominio'}. ` +
    `Tom de voz: ${tone || 'Amigavel'}. ` +
    `Capacidades (actions que voce pode acionar): ${acts}. ` +
    `Regras que voce SEMPRE respeita: ${rules || 'ser transparente e pedir os dados que faltam antes de agir'}. ` +
    `Responda sempre em portugues do Brasil, de forma curta e objetiva; use vocabulario Salesforce correto; ` +
    `nunca invente dados e consulte o registro antes de afirmar algo.`
  );
}

function buildBotXml(o) {
  const persona = composePersona(o);
  const shortDesc = `Agente ${o.domain || 'IA'} (farm Ever i9): ${(o.job || 'assistente').slice(0, 160)}`.slice(0, 240);
  const role = `Voce e ${o.name}, agente de IA de ${o.domain || 'apoio'}. ${(o.job || '').slice(0, 400)}`.slice(0, 950);
  let xml = BOT_TPL
    .replace(/__DEV__/g, o.dev)
    .replace(/__LABEL__/g, esc(o.label))
    .replace(/__COMPANY__/g, esc(o.company || 'Algar Telecom'))
    .replace(/__WELCOME__/g, esc(o.welcome || `Oi! Sou ${o.name}. Como posso ajudar?`))
    .replace(/__ERRORMSG__/g, esc('Ops, tive um problema aqui. Vamos tentar de novo.'))
    .replace(/__ROLE__/g, esc(role))
    .replace(/__DESC__/g, esc(shortDesc));
  xml = xml.replace(/__UUID__/g, () => randomUUID());
  return { xml, persona };
}

function buildPlannerXml(o, persona) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPlanner xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>${esc(persona)}</description>
    <masterLabel>${esc(o.label)}</masterLabel>
    <plannerType>AiCopilot__ReAct</plannerType>
</GenAiPlanner>`;
}

function buildPackageXml(dev) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types><members>${dev}</members><name>Bot</name></types>
    <types><members>${dev}</members><name>GenAiPlanner</name></types>
    <version>63.0</version>
</Package>`;
}

function buildZipBase64(dev, botXml, plannerXml, pkgXml) {
  const zip = new AdmZip();
  zip.addFile('package.xml', Buffer.from(pkgXml, 'utf8'));
  zip.addFile(`bots/${dev}.bot`, Buffer.from(botXml, 'utf8'));
  zip.addFile(`genAiPlanners/${dev}.genAiPlanner`, Buffer.from(plannerXml, 'utf8'));
  return zip.toBuffer().toString('base64');
}

// Conexão dedicada em v63 (GenAiPlanner só é válido em v60-63; conexão padrão do i9 é v62)
async function connV63(org) {
  const conn = new jsforce.Connection({ loginUrl: org.login_url, version: '63.0' });
  await conn.login(org.username, org.password + (org.security_token || ''));
  return conn;
}

async function activateAgent(conn, dev) {
  const q = await conn.query(
    `SELECT Id, Status FROM BotVersion WHERE BotDefinition.DeveloperName='${dev}' AND VersionNumber=1 LIMIT 1`
  );
  if (!q.records || !q.records.length) return { activated: false, reason: 'BotVersion não encontrada' };
  const bvId = q.records[0].Id;
  const apex =
    `Id bvId='${bvId}'; ConnectApi.BotVersionActivation.updateVersionStatus(` +
    `bvId, ConnectApi.BotVersionActivationStatus.Active, null);`;
  const r = await conn.tooling.executeAnonymous(apex);
  const ok = r.compiled && r.success;
  return { activated: ok, botVersionId: bvId, compileProblem: r.compileProblem, exceptionMessage: r.exceptionMessage };
}

function problemsOf(status) {
  const d = status.details || {};
  let comp = d.componentFailures || [];
  if (!Array.isArray(comp)) comp = [comp];
  return comp.map((c) => `${c.fullName || c.fileName}: ${c.problem}`);
}

// POST /api/agent-farm/build  { orgId=36, name, domain, job, tone, caps[], rules, company, welcome }
router.post('/build', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const orgId = b.orgId || 36;
    if (!b.name) return res.status(400).json({ ok: false, error: 'name é obrigatório' });
    const org = await getOrgById(orgId);
    if (!org) return res.status(404).json({ ok: false, error: `org ${orgId} não encontrada` });

    const dev = 'Agente_i9_' + slugify(b.name);
    const label = String(b.name).slice(0, 80);
    const o = { ...b, dev, label, domain: b.domain || 'Custom' };

    const { xml: botXml, persona } = buildBotXml(o);
    const plannerXml = buildPlannerXml(o, persona);
    const zipB64 = buildZipBase64(dev, botXml, plannerXml, buildPackageXml(dev));

    const conn = await connV63(org);
    const buf = Buffer.from(zipB64, 'base64');
    const dep = await conn.metadata.deploy(buf, { rollbackOnError: true, singlePackage: true });

    let status, tries = 0;
    do {
      await sleep(2200);
      status = await conn.metadata.checkDeployStatus(dep.id, true);
      tries++;
    } while (!status.done && tries < 10);

    if (!status.done) {
      return res.json({ ok: false, pending: true, deployId: dep.id, orgId, developerName: dev, masterLabel: label,
        message: 'deploy ainda em andamento — chame POST /api/agent-farm/activate' });
    }
    if (status.status !== 'Succeeded') {
      return res.status(422).json({ ok: false, error: 'deploy falhou', status: status.status, problems: problemsOf(status) });
    }

    const act = await activateAgent(conn, dev);
    return res.json({
      ok: true, orgId, developerName: dev, masterLabel: label,
      deployId: dep.id, deployed: status.numberComponentsDeployed,
      activated: act.activated, botVersionId: act.botVersionId,
      note: act.activated ? 'Agente criado e ATIVADO na org.' : 'Agente criado; ativação pendente.',
      activationDetail: act,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// POST /api/agent-farm/activate  { orgId=36, developerName }
router.post('/activate', authMiddleware, async (req, res) => {
  try {
    const orgId = (req.body && req.body.orgId) || 36;
    const dev = req.body && req.body.developerName;
    if (!dev) return res.status(400).json({ ok: false, error: 'developerName é obrigatório' });
    const org = await getOrgById(orgId);
    if (!org) return res.status(404).json({ ok: false, error: `org ${orgId} não encontrada` });
    const conn = await connV63(org);
    const act = await activateAgent(conn, dev);
    return res.json({ ok: act.activated, developerName: dev, ...act });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// GET /api/agent-farm/list?orgId=36
router.get('/list', authMiddleware, async (req, res) => {
  try {
    const orgId = req.query.orgId || 36;
    const org = await getOrgById(orgId);
    if (!org) return res.status(404).json({ ok: false, error: `org ${orgId} não encontrada` });
    const conn = await connV63(org);
    const q = await conn.query(
      `SELECT Id, DeveloperName, MasterLabel, Type FROM BotDefinition WHERE DeveloperName LIKE 'Agente_i9_%' ORDER BY DeveloperName`
    );
    return res.json({ ok: true, orgId, count: q.totalSize, agents: q.records });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

export default router;
