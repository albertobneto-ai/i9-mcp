import express from 'express';
import * as claude from '../services/claude.js';
import * as grok from '../services/grok.js';
import * as sfMulti from '../services/sf-multi.js';
import pool from '../config/db.js';

const router = express.Router();

function formatStepPreview(step) {
  let text = '';
  if (step.action === 'create-field') {
    text += `**Ação:** Criar Campo\n`;
    text += `- **Objeto:** ${step.object}\n`;
    text += `- **Campo:** ${step.field}\n`;
    if (step.label) text += `- **Label:** ${step.label}\n`;
    text += `- **Tipo:** ${step.type || 'Text'}`;
    if (step.length) text += ` (${step.length})`;
    text += `\n`;
    if (step.values) text += `- **Valores:** ${step.values.join(', ')}\n`;
    if (step.referenceTo) text += `- **Referência:** ${step.referenceTo}\n`;
  } else if (step.action === 'create-object') {
    text += `**Ação:** Criar Objeto\n`;
    text += `- **Objeto:** ${step.object}\n`;
    text += `- **Label:** ${step.label || step.object.replace('__c','')}\n`;
  } else if (step.action === 'apex') {
    text += `**Ação:** Executar Apex\n`;
    text += `\`\`\`\n${(step.code || '').substring(0, 500)}\n\`\`\`\n`;
  } else if (step.action === 'soql') {
    text += `**Ação:** SOQL Query\n`;
    text += `\`\`\`\n${step.query}\n\`\`\`\n`;
  } else if (step.action === 'metadata-create') {
    text += `**Ação:** Criar Metadado\n`;
    text += `- **Tipo:** ${step.type}\n`;
    if (step.description) text += `- **Descrição:** ${step.description}\n`;
    const b = step.body || {};
    if (b.fullName) text += `- **Full Name:** ${b.fullName}\n`;
    if (b.label) text += `- **Label:** ${b.label}\n`;
    const details = Object.keys(b).filter(k => !['fullName','label'].includes(k));
    if (details.length > 0) {
      text += `- **Detalhes:**\n`;
      for (const k of details) {
        const v = b[k];
        const display = typeof v === 'object' ? JSON.stringify(v) : v;
        text += `  - ${k}: ${String(display).substring(0, 120)}\n`;
      }
    }
  } else if (step.action === 'validate') {
    text += `**🔍 Validação Automática**\n`;
    if (step.description) text += `- **Verificação:** ${step.description}\n`;
    if (step.query) text += `- **Query:** \`${step.query.substring(0, 120)}\`\n`;
    if (step.condition) text += `- **Condição:** ${step.condition}\n`;
  } else if (step.action === 'manual-step') {
    text += `**⚠️ Ação Manual Necessária**\n\n`;
    text += `${step.description || 'Passo manual — verifique na org.'}\n`;
  } else {
    text += `**Ação:** ${step.action}\n`;
    text += `\`\`\`json\n${JSON.stringify(step, null, 2).substring(0, 500)}\n\`\`\`\n`;
  }
  return text;
}

async function executeRunbookStep(step, org) {
  if (step.action === 'create-field') {
    const fullName = step.object + '.' + step.field;
    const body = { fullName, label: step.label || step.field.replace('__c','').replace(/_/g,' '), type: step.type || 'Text' };
    if (['Text'].includes(body.type)) body.length = step.length || 255;
    if (body.type === 'LongTextArea') { body.length = step.length || 32768; body.visibleLines = 4; }
    if (['Number','Currency','Percent'].includes(body.type)) { body.precision = step.precision || 18; body.scale = step.scale ?? 2; }
    if (body.type === 'Lookup' && step.referenceTo) { body.referenceTo = step.referenceTo; body.relationshipLabel = body.label; }
    if (['Picklist','MultiselectPicklist'].includes(body.type) && step.values) { body.picklist = step.values; }
    const result = await sfMulti.metadataCreate(org, 'CustomField', body);
    const item = Array.isArray(result) ? result[0] : result;
    const ok = item?.success !== false;
    const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
    return { ok, message: ok ? `✅ Campo criado: ${fullName}` : `❌ Erro: ${errs.map(e=>e.message||JSON.stringify(e)).join(', ')}` };
  }
  if (step.action === 'apex') {
    const r = await sfMulti.executeApex(org, step.code);
    const ok = r.success !== false && !r.compileProblem;
    return { ok, message: ok ? '✅ Apex executado' : `❌ ${r.compileProblem || r.exceptionMessage || 'Erro'}` };
  }
  if (step.action === 'soql') {
    const r = await sfMulti.runSoql(org, step.query);
    if (r.error) return { ok: false, message: `❌ SOQL: ${r.error}` };
    const records = r.records || [];
    let msg = `✅ SOQL: ${r.totalSize || 0} registro(s)`;
    if (records.length > 0) {
      const keys = Object.keys(records[0]).filter(k => k !== 'attributes');
      msg += `\n\n| ${keys.join(' | ')} |\n|${keys.map(() => '---').join('|')}|\n`;
      for (const rec of records.slice(0, 20)) {
        msg += `| ${keys.map(k => { const v = rec[k]; return v && typeof v === 'object' ? JSON.stringify(v).substring(0,50) : (v ?? ''); }).join(' | ')} |\n`;
      }
    }
    if (step.description) msg += `\n${step.description}`;
    return { ok: true, message: msg };
  }
  if (step.action === 'metadata-create') {
    const mtype = step.type;
    const body = step.body;
    if (!mtype || !body) return { ok: false, message: '❌ metadata-create requer type e body' };
    const result = await sfMulti.metadataCreate(org, mtype, body);
    const item = Array.isArray(result) ? result[0] : result;
    const ok = item?.success !== false;
    const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
    const name = body.fullName || body.label || mtype;
    return { ok, message: ok ? `✅ ${mtype} criado: ${name}` : `❌ Erro em ${name}: ${errs.map(e => e.message || JSON.stringify(e)).join(', ')}` };
  }
  if (step.action === 'metadata-update') {
    const mtype = step.type;
    const body = step.body;
    if (!mtype || !body) return { ok: false, message: '❌ metadata-update requer type e body' };
    const result = await sfMulti.metadataUpdate(org, mtype, body);
    const item = Array.isArray(result) ? result[0] : result;
    const ok = item?.success !== false;
    const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
    const name = body.fullName || body.label || mtype;
    return { ok, message: ok ? `✅ ${mtype} atualizado: ${name}` : `❌ Erro em ${name}: ${errs.map(e => e.message || JSON.stringify(e)).join(', ')}` };
  }
  if (step.action === 'validate') {
    // Run SOQL and evaluate condition
    if (!step.query) return { ok: false, message: '❌ validate requer query' };
    try {
      const r = await sfMulti.runSoql(org, step.query);
      if (r.error) return { ok: false, message: `❌ Validação falhou: ${r.error}` };
      const records = r.records || [];
      const count = r.totalSize || 0;
      let passed = true;
      let detail = '';

      if (step.condition === 'empty' || step.condition === 'no-results') {
        passed = count === 0;
        detail = passed ? 'Nenhum registro encontrado (esperado)' : `${count} registro(s) encontrado(s) — ATENÇÃO`;
      } else if (step.condition === 'has-results' || step.condition === 'not-empty') {
        passed = count > 0;
        detail = passed ? `${count} registro(s) encontrado(s)` : 'Nenhum registro — ATENÇÃO';
      } else if (step.condition === 'no-modify-all-data') {
        // Check if any user has ModifyAllData
        const bad = records.filter(rec => {
          const p = rec.Profile || rec;
          return p.PermissionsModifyAllData === true;
        });
        passed = bad.length === 0;
        detail = passed ? 'Nenhum user de integração com Modify All Data ✓' : `⚠️ ${bad.length} user(s) com Modify All Data!`;
      } else {
        detail = `${count} registro(s) retornado(s)`;
      }

      // Show results
      let msg = passed ? `✅ Validação OK — ${detail}` : `⚠️ Validação com alerta — ${detail}`;
      if (step.description) msg += `\n📋 ${step.description}`;
      if (records.length > 0 && records.length <= 10) {
        const keys = Object.keys(records[0]).filter(k => k !== 'attributes');
        msg += `\n\n| ${keys.join(' | ')} |\n|${keys.map(() => '---').join('|')}|\n`;
        for (const rec of records) {
          msg += `| ${keys.map(k => { const v = rec[k]; return v && typeof v === 'object' ? JSON.stringify(v).substring(0,50) : (v ?? ''); }).join(' | ')} |\n`;
        }
      }
      return { ok: true, message: msg };
    } catch (e) { return { ok: false, message: `❌ Erro na validação: ${e.message}` }; }
  }
  if (step.action === 'manual-step') {
    return { ok: true, message: `✅ Passo manual registrado — prosseguindo.` };
  }
  return { ok: false, message: '❌ Ação não suportada: ' + step.action };
}

const SYSTEM_PROMPT = `Você é o SF Agent, um assistente especialista em Salesforce (Sales Cloud, Service Cloud, Data Cloud, Revenue Cloud, Agentforce, MuleSoft).

Regras:
- Responda em português do Brasil
- Use terminologia técnica Salesforce quando relevante
- Seja direto e objetivo
- Formate com markdown quando útil
- Para perguntas técnicas, priorize configuração nativa (OOTB) > Flow > Apex`;

// Helper: get selected org from header or default
async function getSelectedOrg(req) {
  const orgId = req.headers['x-org-id'] || req.body.orgId;
  if (!orgId) {
    const r = await pool.query('SELECT * FROM orgs ORDER BY id LIMIT 1');
    return r.rows[0] || null;
  }
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [orgId]);
  return r.rows[0] || null;
}

// ── /describe ObjectName ──
async function handleDescribe(objectName, org) {
  if (!org) return { text: '❌ Nenhuma org conectada.', tipo: 'error' };
  const name = objectName.trim();
  if (!name) return { text: '⚠️ Use: /describe NomeDoObjeto (ex: /describe Account)', tipo: 'error' };
  try {
    const result = await sfMulti.describeObject(org, name);
    if (result.error) return { text: `❌ ${result.error}`, tipo: 'error' };
    const fields = result.fields || [];
    const custom = fields.filter(f => f.custom);
    const standard = fields.filter(f => !f.custom);
    const required = fields.filter(f => !f.nillable && f.createable);
    const formulas = fields.filter(f => f.calculatedFormula);
    const lookups = fields.filter(f => f.type === 'reference');
    const picklists = fields.filter(f => f.picklistValues && f.picklistValues.length > 0);
    const externalIds = fields.filter(f => f.externalId);

    let text = `## ${result.label} (${result.name})\n`;
    text += `**Key Prefix:** ${result.keyPrefix || 'N/A'} | **Custom:** ${result.custom ? 'Sim' : 'Não'}\n`;
    text += `**Queryable:** ${result.queryable ? '✓' : '✗'} | **Createable:** ${result.createable ? '✓' : '✗'} | **Updateable:** ${result.updateable ? '✓' : '✗'} | **Deletable:** ${result.deletable ? '✓' : '✗'}\n\n`;

    // Summary
    text += `### Resumo\n`;
    text += `- **Total campos:** ${fields.length} (${custom.length} custom, ${standard.length} standard)\n`;
    text += `- **Obrigatórios:** ${required.length}\n`;
    text += `- **Lookups:** ${lookups.length}\n`;
    text += `- **Picklists:** ${picklists.length}\n`;
    text += `- **Fórmulas:** ${formulas.length}\n`;
    if (externalIds.length) text += `- **External IDs:** ${externalIds.length}\n`;
    text += `\n`;

    // Record Types
    const rts = (result.recordTypeInfos || []).filter(r => r.name !== 'Master');
    if (rts.length > 0) {
      text += `### Record Types (${rts.length})\n`;
      for (const rt of rts) {
        text += `- **${rt.name}** — ${rt.active ? '🟢 Ativo' : '🔴 Inativo'} ${rt.defaultRecordTypeMapping ? '(Default)' : ''}\n`;
      }
      text += `\n`;
    }

    // ALL Fields table
    text += `### Campos (${fields.length})\n`;
    text += `| # | API Name | Label | Tipo | Req | Custom | Detalhes |\n|---|---|---|---|---|---|---|\n`;
    let idx = 0;
    for (const f of fields) {
      idx++;
      let details = '';
      if (f.length && f.type !== 'boolean' && f.type !== 'id') details += `len:${f.length}`;
      if (f.precision) details += ` prec:${f.precision}`;
      if (f.scale) details += `,${f.scale}`;
      if (f.referenceTo && f.referenceTo.length) details += `→${f.referenceTo.join(',')}`;
      if (f.unique) details += ' UNIQUE';
      if (f.externalId) details += ' ExtId';
      if (f.calculatedFormula) details += ' FORMULA';
      if (f.defaultValue !== null && f.defaultValue !== undefined) details += ` def:${f.defaultValue}`;
      const req = (!f.nillable && f.createable) ? '✓' : '';
      text += `| ${idx} | ${f.name} | ${f.label} | ${f.type} | ${req} | ${f.custom ? '✓' : ''} | ${details.trim()} |\n`;
    }

    // Picklists with values
    if (picklists.length > 0) {
      text += `\n### Picklist Values\n`;
      for (const f of picklists) {
        const vals = f.picklistValues.map(p => p.default ? `**${p.value}**` : p.value);
        text += `- **${f.name}:** ${vals.join(', ')}\n`;
      }
    }

    // Child Relationships
    const children = (result.childRelationships || []).filter(c => c.relationshipName);
    if (children.length > 0) {
      text += `\n### Child Relationships (${children.length})\n`;
      for (const c of children) {
        text += `- ${c.childSObject}.${c.field} → ${c.relationshipName}\n`;
      }
    }

    return { text, tipo: 'describe' };
  } catch (e) { return { text: `❌ Erro: ${e.message}`, tipo: 'error' }; }
}

// ── /soql QUERY ──
async function handleSoql(query, org) {
  if (!org) return { text: '❌ Nenhuma org conectada.', tipo: 'error' };
  if (!query.trim()) return { text: '⚠️ Use: /soql SELECT Id, Name FROM Account LIMIT 5', tipo: 'error' };
  try {
    const result = await sfMulti.runSoql(org, query.trim());
    if (result.error) return { text: `❌ ${result.error}`, tipo: 'error' };
    const records = result.records || [];
    if (records.length === 0) return { text: '📭 Nenhum registro encontrado.', tipo: 'soql' };
    const keys = Object.keys(records[0]).filter(k => k !== 'attributes');
    let text = `**${result.totalSize} registro(s)**\n\n`;
    text += `| ${keys.join(' | ')} |\n|${keys.map(() => '---').join('|')}|\n`;
    for (const r of records.slice(0, 50)) {
      text += `| ${keys.map(k => r[k] ?? '').join(' | ')} |\n`;
    }
    if (records.length > 50) text += `\n*... e mais ${records.length - 50} registros*`;
    return { text, tipo: 'soql' };
  } catch (e) { return { text: `❌ Erro SOQL: ${e.message}`, tipo: 'error' }; }
}

// ── /objetos ──
async function handleListObjects(org) {
  if (!org) return { text: '❌ Nenhuma org conectada.', tipo: 'error' };
  try {
    const result = await sfMulti.describeGlobal(org);
    if (result.error) return { text: `❌ ${result.error}`, tipo: 'error' };
    const objs = result.sobjects || [];
    const custom = objs.filter(o => o.custom && o.queryable);
    const standard = objs.filter(o => !o.custom && o.queryable);
    let text = `## Objetos da Org\n**Total queryable:** ${custom.length + standard.length} (${custom.length} custom, ${standard.length} standard)\n\n`;
    if (custom.length > 0) {
      text += `### Custom Objects\n`;
      for (const o of custom) text += `- **${o.name}** — ${o.label}\n`;
    }
    text += `\n### Standard Objects (principais)\n`;
    const main = ['Account','Contact','Lead','Opportunity','Case','Order','Product2','Contract','Campaign','Quote','Asset','Task','Event'];
    for (const o of standard.filter(s => main.includes(s.name))) text += `- **${o.name}** — ${o.label}\n`;
    text += `\n*Total standard: ${standard.length}*`;
    return { text, tipo: 'objetos' };
  } catch (e) { return { text: `❌ Erro: ${e.message}`, tipo: 'error' }; }
}

// ── /status ──
async function handleStatus(org) {
  if (!org) return { text: '❌ Nenhuma org conectada.', tipo: 'error' };
  try {
    const result = await sfMulti.testConnection(org);
    let text = `## Status da Org\n`;
    text += `- **Org:** ${org.name}\n`;
    text += `- **Status:** ${result.status === 'connected' ? '🟢 Conectada' : '🔴 Desconectada'}\n`;
    text += `- **OrgId:** ${result.orgId || 'N/A'}\n`;
    text += `- **User:** ${result.username || org.username}\n`;
    text += `- **Instance:** ${result.instanceUrl || 'N/A'}\n`;
    text += `- **Tipo:** ${org.org_type}\n`;
    return { text, tipo: 'status' };
  } catch (e) { return { text: `❌ Erro: ${e.message}`, tipo: 'error' }; }
}

router.post('/', async (req, res) => {
  try {
    const { messages, conversationId, orgId } = req.body;
    if (!messages || !Array.isArray(messages))
      return res.status(400).json({ error: 'messages obrigatorio' });

    const userMsg = messages[messages.length - 1]?.content || '';
    const lower = userMsg.trim().toLowerCase();

    // ── Command routing ──
    const org = await getSelectedOrg(req);

    if (lower.startsWith('/describe ')) {
      const objName = userMsg.trim().substring(10).trim();
      const result = await handleDescribe(objName, org);
      return res.json({ choices: [{ message: { content: result.text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + (org?.name || 'N/A'), tipo: result.tipo });
    }
    if (lower.startsWith('/soql ')) {
      const query = userMsg.trim().substring(6).trim();
      const result = await handleSoql(query, org);
      return res.json({ choices: [{ message: { content: result.text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + (org?.name || 'N/A'), tipo: result.tipo });
    }
    if (lower === '/objetos' || lower === '/objects' || lower === '/list-objects') {
      const result = await handleListObjects(org);
      return res.json({ choices: [{ message: { content: result.text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + (org?.name || 'N/A'), tipo: result.tipo });
    }
    if (lower === '/status') {
      const result = await handleStatus(org);
      return res.json({ choices: [{ message: { content: result.text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + (org?.name || 'N/A'), tipo: result.tipo });
    }
    if (lower === '/help') {
      const help = `## Comandos Disponíveis\n\n` +
        `### Consulta\n` +
        `| Comando | Descrição |\n|---|---|\n` +
        `| \`/describe Objeto\` | Metadados completos (campos, RTs, picklists, relationships) |\n` +
        `| \`/objetos\` | Lista todos os objetos da org (custom + standard) |\n` +
        `| \`/soql QUERY\` | Executa SOQL na org |\n` +
        `| \`/tooling QUERY\` | Consulta Tooling API (ApexClass, Flow, CustomField) |\n` +
        `| \`/layout Objeto\` | Lista layouts e seções de um objeto |\n` +
        `| \`/metadata-read Tipo FullName\` | Lê metadado raw (CustomField, Profile, etc) |\n\n` +
        `### Desenvolvimento\n` +
        `| Comando | Descrição |\n|---|---|\n` +
        `| \`/create-field Obj.Campo__c Tipo [tam]\` | Cria campo custom na org |\n` +
        `| \`/apex CÓDIGO\` | Executa Apex anônimo |\n\n` +
        `### Org\n` +
        `| Comando | Descrição |\n|---|---|\n` +
        `| \`/status\` | Status da conexão |\n` +
        `| \`/help\` | Este menu |\n\n` +
        `**Tipos de campo:** Text, Number, Checkbox, Date, DateTime, Email, Phone, Url, Currency, Percent, LongTextArea, Picklist, Lookup\n\n` +
        `Qualquer outra mensagem é respondida pelo **Claude Sonnet 4.6**.`;
      return res.json({ choices: [{ message: { content: help } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });
    }

    // ── /apex CODE ──
    if (lower.startsWith('/apex ')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const code = userMsg.trim().substring(6).trim();
      if (!code) return res.json({ choices: [{ message: { content: '⚠️ Use: /apex System.debug(\'Hello\');' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });
      try {
        const r = await sfMulti.executeApex(org, code);
        const success = r.success !== false && !r.compileProblem;
        let text = success ? '✅ **Apex executado com sucesso**' : '❌ **Erro na execução**';
        if (r.compileProblem) text += `\n\nCompile: ${r.compileProblem}`;
        if (r.exceptionMessage) text += `\n\nException: ${r.exceptionMessage}\n${r.exceptionStackTrace || ''}`;
        if (r.logs) text += `\n\n\`\`\`\n${r.logs.substring(0, 3000)}\n\`\`\``;
        return res.json({ choices: [{ message: { content: text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'apex' });
      } catch (e) { return res.json({ choices: [{ message: { content: `❌ ${e.message}` } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' }); }
    }

    // ── /tooling QUERY ──
    if (lower.startsWith('/tooling ')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const q = userMsg.trim().substring(9).trim();
      try {
        const result = await sfMulti.runToolingQuery(org, q);
        if (result.error) return res.json({ choices: [{ message: { content: `❌ ${result.error}` } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
        const records = result.records || [];
        if (!records.length) return res.json({ choices: [{ message: { content: '📭 Nenhum resultado.' } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'tooling' });
        const keys = Object.keys(records[0]).filter(k => k !== 'attributes');
        let text = `**${result.totalSize} resultado(s) — Tooling API**\n\n| ${keys.join(' | ')} |\n|${keys.map(() => '---').join('|')}|\n`;
        for (const r of records.slice(0, 50)) text += `| ${keys.map(k => { const v = r[k]; return v && typeof v === 'object' ? JSON.stringify(v).substring(0,40) : (v ?? ''); }).join(' | ')} |\n`;
        return res.json({ choices: [{ message: { content: text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'tooling' });
      } catch (e) { return res.json({ choices: [{ message: { content: `❌ ${e.message}` } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' }); }
    }

    // ── /layout ObjectName ──
    if (lower.startsWith('/layout ')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const objName = userMsg.trim().substring(8).trim();
      try {
        const result = await sfMulti.describeLayouts(org, objName);
        if (result.error) return res.json({ choices: [{ message: { content: `❌ ${result.error}` } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
        const layouts = result.layouts || result;
        let text = `## Layouts — ${objName}\n\n`;
        if (Array.isArray(layouts)) {
          for (const l of layouts) {
            text += `### ${l.name || l.fullName || 'Layout'}\n`;
            if (l.sections) for (const s of l.sections) {
              text += `- **${s.label || s.heading || 'Section'}** (${(s.layoutColumns || []).reduce((a,c) => a + (c.layoutItems||[]).length, 0)} campos)\n`;
            }
          }
        } else {
          text += '```\n' + JSON.stringify(layouts, null, 2).substring(0, 4000) + '\n```';
        }
        return res.json({ choices: [{ message: { content: text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'layout' });
      } catch (e) { return res.json({ choices: [{ message: { content: `❌ ${e.message}` } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' }); }
    }

    // ── /create-field (natural language → Claude parses → executes) ──
    if (lower.startsWith('/create-field')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const input = userMsg.trim().substring(13).trim();
      if (!input) return res.json({ choices: [{ message: { content: '⚠️ Descreva o campo. Ex:\n• /create-field campo teste no objeto Lead, texto, tamanho 30\n• /create-field Account email secundário, tipo Email\n• /create-field Lead.Segmento__c Picklist valores: PME, Enterprise, Governo' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });
      try {
        const parsePrompt = `Extraia os dados para criar um campo Salesforce a partir desta instrução do usuário. Responda SOMENTE com um JSON puro (sem markdown, sem backticks).

Instrução: "${input}"

JSON esperado:
{
  "object": "NomeDoObjeto (API Name, ex: Lead, Account, Opportunity)",
  "fieldName": "Nome_API_Do_Campo__c (se não tiver __c, adicione)",
  "label": "Label legível do campo",
  "type": "Text|Number|Checkbox|Date|DateTime|Email|Phone|Url|Currency|Percent|LongTextArea|Picklist|MultiselectPicklist|Lookup",
  "length": 255,
  "precision": null,
  "scale": null,
  "referenceTo": null,
  "picklistValues": null,
  "description": null
}

Regras:
- Se o tipo for Text, length padrão 255 (a menos que especificado)
- Se Number/Currency/Percent, precision=18 scale=2
- Se LongTextArea, length=32768
- Se Picklist, extraia os valores em picklistValues como array de strings
- Se Lookup, coloque o objeto referenciado em referenceTo
- Se o usuário não especificou __c, adicione automaticamente
- Converta nomes como "teste_mcp_server" em "teste_mcp_server__c" e label "Teste Mcp Server"`;

        const parsed = await claude.call(parsePrompt, [{ role: 'user', content: input }], 1024);
        let spec;
        try {
          const clean = parsed.replace(/```json\n?|```\n?/g, '').trim();
          spec = JSON.parse(clean);
        } catch (pe) {
          return res.json({ choices: [{ message: { content: `❌ Não consegui interpretar. Tente algo como:\n/create-field campo teste no Lead, tipo texto, tamanho 50` } }], modelo_usado: 'claude-sonnet-4-6', modelo_label: 'SF Agent', tipo: 'error' });
        }

        // Build metadata
        const fullName = spec.object + '.' + spec.fieldName;
        const body = { fullName, label: spec.label || spec.fieldName.replace('__c','').replace(/_/g,' '), type: spec.type || 'Text' };
        if (['Text'].includes(body.type)) body.length = spec.length || 255;
        if (body.type === 'LongTextArea') { body.length = spec.length || 32768; body.visibleLines = 4; }
        if (['Number','Currency','Percent'].includes(body.type)) { body.precision = spec.precision || 18; body.scale = spec.scale ?? 2; }
        if (body.type === 'Lookup' && spec.referenceTo) { body.referenceTo = spec.referenceTo; body.relationshipLabel = spec.label || spec.fieldName.replace('__c',''); }
        if (['Picklist','MultiselectPicklist'].includes(body.type) && spec.picklistValues) { body.picklist = spec.picklistValues; }
        if (spec.description) body.description = spec.description;

        // Preview - do NOT execute yet
        // Get org instance URL
        let orgUrl = '';
        try {
          const conn = await sfMulti.testConnection(org);
          orgUrl = conn.instanceUrl || '';
        } catch {}
        const orgLink = orgUrl ? orgUrl.replace('https://','') : org.username;

        let preview = `### Confirma a criação?\n\n`;
        preview += `**Org:** [${orgLink}](${orgUrl})\n\n`;
        preview += `- **Objeto:** ${spec.object}\n`;
        preview += `- **Campo:** ${spec.fieldName}\n`;
        preview += `- **Label:** ${body.label}\n`;
        preview += `- **Tipo:** ${body.type}`;
        if (body.length) preview += ` (${body.length})`;
        preview += `\n`;
        if (body.picklist) preview += `- **Valores:** ${body.picklist.join(', ')}\n`;
        if (body.referenceTo) preview += `- **Referência:** ${body.referenceTo}\n`;
        

        return res.json({ choices: [{ message: { content: preview } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'confirm', confirmData: { action: 'create-field', payload: Buffer.from(JSON.stringify(body)).toString('base64') } });
      } catch (e) { return res.json({ choices: [{ message: { content: `❌ ${e.message}` } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' }); }
    }

    // ── /metadata-read Type FullName ──
    if (lower.startsWith('/metadata-read ')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const parts = userMsg.trim().substring(15).trim().split(/\s+/);
      const mtype = parts[0]; const fname = parts.slice(1).join(' ');
      if (!mtype || !fname) return res.json({ choices: [{ message: { content: '⚠️ Use: /metadata-read CustomField Account.Industry' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });
      try {
        const result = await sfMulti.metadataRead(org, mtype, fname);
        let text = `## Metadata: ${mtype} — ${fname}\n\`\`\`json\n${JSON.stringify(result, null, 2).substring(0, 5000)}\n\`\`\``;
        return res.json({ choices: [{ message: { content: text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'metadata' });
      } catch (e) { return res.json({ choices: [{ message: { content: `❌ ${e.message}` } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' }); }
    }

        // ── /runbook — lê manifest e executa passo a passo ──
    if (lower.startsWith('/runbook')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const input = userMsg.trim().substring(8).trim();
      if (!input) return res.json({ choices: [{ message: { content: '⚠️ Cole o runbook (JSON ou texto livre).\n\nExemplo JSON:\n```json\n[\n  { "action": "create-field", "object": "Lead", "field": "Segmento__c", "type": "Picklist", "values": ["PME","Enterprise"] },\n  { "action": "create-field", "object": "Lead", "field": "SLA__c", "type": "Number" },\n  { "action": "apex", "code": "System.debug(\'done\');" }\n]\n```\nOu descreva em texto livre que o Claude interpreta.' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });

      try {
        let steps;
        // Try JSON first
        try {
          const clean = input.replace(/```json\n?|```\n?/g, '').trim();
          steps = JSON.parse(clean);
          if (!Array.isArray(steps)) steps = [steps];
        } catch {
          // Natural language → Claude parses into steps
          const parsePrompt = `Analise este runbook/spec e extraia as ações de deployment Salesforce. Responda SOMENTE com um JSON array (sem markdown, sem backticks).

Cada ação deve ter:
- "action": "create-field" | "create-object" | "apex" | "soql"
- Para create-field: "object", "field" (API name com __c), "label", "type" (Text/Number/Checkbox/Date/DateTime/Email/Phone/Url/Currency/Percent/LongTextArea/Picklist/Lookup), "length" (se Text), "values" (se Picklist, array de strings), "referenceTo" (se Lookup)
- Para create-object: "object" (API name com __c), "label", "pluralLabel"
- Para apex: "code" (código Apex)
- Para soql: "query" (SOQL query)

Se o campo não tem __c, adicione. Converta nomes para API format.`;

          const parsed = await claude.call(parsePrompt, [{ role: 'user', content: input }], 4096);
          const cleanParsed = parsed.replace(/```json\n?|```\n?/g, '').trim();
          steps = JSON.parse(cleanParsed);
          if (!Array.isArray(steps)) steps = [steps];
        }

        if (!steps.length) return res.json({ choices: [{ message: { content: '❌ Nenhuma ação encontrada no runbook.' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'error' });

        // Get org URL
        let orgUrl = '';
        try { const c = await sfMulti.testConnection(org); orgUrl = c.instanceUrl || ''; } catch {}
        const orgLink = orgUrl ? orgUrl.replace('https://','') : org.username;

        // Show step 1 preview
        const step = steps[0];
        let preview = `### Runbook — Passo 1 de ${steps.length}\n\n`;
        preview += `**Org:** [${orgLink}](${orgUrl})\n\n`;
        preview += formatStepPreview(step);

        const payload = { steps, currentStep: 0 };

        return res.json({ choices: [{ message: { content: preview } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'confirm', confirmData: { action: 'runbook', payload: Buffer.from(JSON.stringify(payload)).toString('base64') } });
      } catch (e) { return res.json({ choices: [{ message: { content: `❌ Erro ao processar runbook: ${e.message}` } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' }); }
    }

        // ── /confirm:ACTION:PAYLOAD — executa ação pendente ──
    if (lower.startsWith('/confirm:')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const parts = userMsg.trim().substring(9).split(':');
      const action = parts[0];
      const payload = parts.slice(1).join(':');
      try {
        const body = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
        if (action === 'create-field') {
          const result = await sfMulti.metadataCreate(org, 'CustomField', body);
          const item = Array.isArray(result) ? result[0] : result;
          const ok = item?.success !== false;
          const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
          const text = ok
            ? `✅ **Campo criado com sucesso!**\n- **${body.fullName}** (${body.type})`
            : `❌ **Erro:** ${errs.map(e => e.message || JSON.stringify(e)).join(', ')}`;
          return res.json({ choices: [{ message: { content: text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'executed' });
        }
        if (action === 'runbook') {
          const { steps, currentStep } = body;
          const step = steps[currentStep];
          // Execute current step
          const result = await executeRunbookStep(step, org);
          let text = `### Passo ${currentStep + 1} de ${steps.length}\n\n${result.message}\n`;
          const nextStep = currentStep + 1;
          if (nextStep < steps.length) {
            // Show next step preview
            text += `\n---\n### Próximo — Passo ${nextStep + 1} de ${steps.length}\n\n`;
            text += formatStepPreview(steps[nextStep]);
            const nextPayload = { steps, currentStep: nextStep };
            return res.json({ choices: [{ message: { content: text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'confirm', confirmData: { action: 'runbook', payload: Buffer.from(JSON.stringify(nextPayload)).toString('base64') } });
          } else {
            text += `\n---\n🏁 **Runbook completo!** ${steps.length} passo(s) executado(s).`;
            return res.json({ choices: [{ message: { content: text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'executed' });
          }
        }
        return res.json({ choices: [{ message: { content: '❌ Ação desconhecida: ' + action } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'error' });
      } catch (e) { return res.json({ choices: [{ message: { content: `❌ Erro: ${e.message}` } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' }); }
    }

    // ── /cancel — cancela ação pendente ──
    if (lower === '/cancel') {
      return res.json({ choices: [{ message: { content: '🚫 **Ação cancelada.**' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'cancelled' });
    }

        // ── AI Chat ──
    const apiMessages = messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    let response, modelUsed, modelLabel;
    try {
      response = await claude.call(SYSTEM_PROMPT, apiMessages);
      modelUsed = 'claude-sonnet-4-6';
      modelLabel = 'Claude Sonnet 4.6';
    } catch (claudeErr) {
      console.error('Claude fail, fallback Grok:', claudeErr.message);
      try {
        response = await grok.call(SYSTEM_PROMPT, apiMessages);
        modelUsed = 'grok-4.20';
        modelLabel = 'Grok 4.20';
      } catch (grokErr) {
        return res.status(500).json({ error: 'Nenhum modelo disponivel' });
      }
    }

    // Save conversation
    let convId = conversationId;
    try {
      const title = userMsg.substring(0, 80) || 'Conversa';
      const fullMsgs = [...messages, { role: 'assistant', content: response }];
      if (convId) {
        await pool.query('UPDATE conversations SET messages = $1, title = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4',
          [JSON.stringify(fullMsgs), title, convId, req.user.id]);
      } else {
        const r = await pool.query('INSERT INTO conversations (user_id, title, messages) VALUES ($1, $2, $3) RETURNING id',
          [req.user.id, title, JSON.stringify(fullMsgs)]);
        convId = r.rows[0].id;
      }
    } catch (dbErr) { console.error('Conv save fail:', dbErr.message); }

    res.json({ choices: [{ message: { content: response } }], modelo_usado: modelUsed, modelo_label: modelLabel, tipo: 'chat', conversationId: convId });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
