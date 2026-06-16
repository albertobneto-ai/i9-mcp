import express from 'express';
import * as claude from '../services/claude.js';
import * as grok from '../services/grok.js';
import * as sfMulti from '../services/sf-multi.js';
import pool from '../config/db.js';
import specInstructions from '../prompts/spec.js';

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
  } else if (step.action === 'apex-class') {
    text += `**Ação:** Criar Apex Class\n`;
    text += `- **Nome:** ${step.name || step.className}\n`;
    if (step.description) text += `- **Descrição:** ${step.description}\n`;
    const code = step.body || step.code || '';
    text += `\n\`\`\`apex\n${code.substring(0, 400)}${code.length > 400 ? '\n...' : ''}\n\`\`\`\n`;
  } else if (step.action === 'apex-trigger') {
    text += `**Ação:** Criar Apex Trigger\n`;
    text += `- **Nome:** ${step.name || step.triggerName}\n`;
    if (step.description) text += `- **Descrição:** ${step.description}\n`;
    const code = step.body || step.code || '';
    text += `\n\`\`\`apex\n${code.substring(0, 400)}${code.length > 400 ? '\n...' : ''}\n\`\`\`\n`;
  } else if (step.action === 'lwc') {
    text += `**Ação:** Criar LWC (Lightning Web Component)\n`;
    text += `- **Nome:** ${step.name}\n`;
    if (step.description) text += `- **Descrição:** ${step.description}\n`;
    if (step.files) {
      text += `- **Arquivos:** ${Object.keys(step.files).filter(k => ['html','js','meta','css'].includes(k)).join(', ')}\n`;
    }
  } else if (step.action === 'flow') {
    text += `**Ação:** Criar Flow\n`;
    text += `- **Nome:** ${step.fullName || step.name}\n`;
    if (step.description) text += `- **Descrição:** ${step.description}\n`;
    const b = step.body || {};
    if (b.label) text += `- **Label:** ${b.label}\n`;
    if (b.processType) text += `- **Tipo:** ${b.processType}\n`;
  } else if (step.action === 'manual-step') {
    text += `**⚠️ Ação Manual Necessária**\n\n`;
    text += `${step.description || 'Passo manual — verifique na org.'}\n`;
  } else {
    text += `**Ação:** ${step.action}\n`;
    text += `\`\`\`json\n${JSON.stringify(step, null, 2).substring(0, 500)}\n\`\`\`\n`;
  }
  return text;
}

async function logDeployAction(entry) {
  try {
    await pool.query(
      `INSERT INTO deploy_log (us_number, component, action, description, result, result_message, org_id, org_name, user_id, user_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [entry.us || null, entry.component || null, entry.action || null, entry.description || null,
       entry.result || null, entry.resultMessage || null, entry.orgId || null, entry.orgName || null,
       entry.userId || null, entry.userName || null]
    );
  } catch (e) { console.error('logDeployAction fail:', e.message); }
}

// Extrai número da US do step ou do runbook
function extractComponent(step) {
  if (step.body && step.body.fullName) return step.body.fullName;
  if (step.name) return step.name;
  if (step.fullName) return step.fullName;
  if (step.object && step.field) return step.object + '.' + step.field;
  if (step.action === 'soql') return 'SOQL';
  if (step.action === 'validate') return 'Validação';
  return step.action;
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
    if (ok) return { ok: true, message: `✅ Campo criado: ${fullName}` };
    const alreadyExists = errs.some(e => {
      const msg = (e.message || e.statusCode || JSON.stringify(e)).toLowerCase();
      return msg.includes('already') || msg.includes('duplicate') || msg.includes('existe');
    });
    if (alreadyExists) return { ok: true, alreadyExists: true, message: `ℹ️ Campo já existe: ${fullName} — prosseguindo` };
    return { ok: false, message: `❌ Erro: ${errs.map(e=>e.message||JSON.stringify(e)).join(', ')}` };
  }
  if (step.action === 'apex') {
    const r = await sfMulti.executeApex(org, step.code);
    const ok = r.success !== false && !r.compileProblem;
    return { ok, message: ok ? '✅ Apex executado' : `❌ ${r.compileProblem || r.exceptionMessage || 'Erro'}` };
  }
  if (step.action === 'apex-class') {
    const name = step.name || step.className;
    const body = step.body || step.code;
    if (!name || !body) return { ok: false, message: '❌ apex-class requer name e body' };
    try {
      const r = await sfMulti.deployApexClass(org, name, body);
      const ok = r.success !== false;
      if (ok) return { ok: true, message: `✅ Apex Class criada: ${name}` };
      const errs = r.errors ? (Array.isArray(r.errors) ? r.errors : [r.errors]) : [];
      return { ok: false, message: `❌ Erro na classe ${name}: ${errs.map(e => e.message || JSON.stringify(e)).join(', ')}` };
    } catch (e) {
      const msg = e.message || String(e);
      // Tooling API returns compile errors in the exception
      return { ok: false, message: `❌ ${name}: ${msg.substring(0, 300)}` };
    }
  }
  if (step.action === 'apex-trigger') {
    const name = step.name || step.triggerName;
    const body = step.body || step.code;
    if (!name || !body) return { ok: false, message: '❌ apex-trigger requer name e body' };
    try {
      const r = await sfMulti.deployApexTrigger(org, name, body, step.object || step.sobjectType);
      const ok = r.success !== false;
      if (ok) return { ok: true, message: `✅ Apex Trigger criado: ${name}` };
      const errs = r.errors ? (Array.isArray(r.errors) ? r.errors : [r.errors]) : [];
      return { ok: false, message: `❌ Erro no trigger ${name}: ${errs.map(e => e.message || JSON.stringify(e)).join(', ')}` };
    } catch (e) { return { ok: false, message: `❌ ${name}: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'lwc') {
    const name = step.name;
    const files = step.files;
    if (!name || !files) return { ok: false, message: '❌ lwc requer name e files (html, js, meta)' };
    try {
      const r = await sfMulti.deployLWC(org, name, files);
      const ok = r.success === true || r.status === 'Succeeded';
      if (ok) return { ok: true, message: `✅ LWC deployado: ${name}` };
      const details = r.details?.componentFailures || [];
      const errMsg = Array.isArray(details) ? details.map(d => d.problem).join('; ') : (r.errorMessage || JSON.stringify(r).substring(0, 200));
      return { ok: false, message: `❌ LWC ${name}: ${errMsg}` };
    } catch (e) { return { ok: false, message: `❌ LWC ${name}: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'flow') {
    const fullName = step.fullName || step.name;
    const flowBody = step.body || step.flow;
    if (!fullName || !flowBody) return { ok: false, message: '❌ flow requer fullName e body' };
    try {
      const r = await sfMulti.deployFlow(org, fullName, flowBody);
      const item = Array.isArray(r) ? r[0] : r;
      const ok = item?.success !== false;
      if (ok) return { ok: true, message: `✅ Flow criado: ${fullName}` };
      const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
      return { ok: false, message: `❌ Erro no Flow ${fullName}: ${errs.map(e => e.message || JSON.stringify(e)).join(', ')}` };
    } catch (e) { return { ok: false, message: `❌ Flow ${fullName}: ${(e.message || String(e)).substring(0, 300)}` }; }
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
    const body = { ...step.body };
    if (!mtype || !body) return { ok: false, message: '❌ metadata-create requer type e body' };

    // Auto-resolve DuplicateRule: delete this rule if exists, compute correct sortOrder from ALL rules
    if (mtype === 'DuplicateRule' && body.fullName) {
      // Ensure required fields with correct DuplicateRule semantics
      if (!body.securityOption) body.securityOption = 'EnforceSharingRules';
      // Block: action=Block, no operations, no alertText
      // Allow+Alert: action=Allow, operationsOnInsert=['Alert','Report'], with alertText
      if (body.actionOnInsert === 'Block') {
        delete body.operationsOnInsert;
      } else if (body.actionOnInsert === 'Allow') {
        body.operationsOnInsert = body.alertText ? ['Alert', 'Report'] : ['Report'];
      }
      if (body.actionOnUpdate === 'Block') {
        delete body.operationsOnUpdate;
      } else if (body.actionOnUpdate === 'Allow') {
        body.operationsOnUpdate = body.alertText ? ['Alert', 'Report'] : ['Report'];
      }
      // alertText only valid if at least one action is Allow (alert mode)
      const hasAlert = body.actionOnInsert === 'Allow' || body.actionOnUpdate === 'Allow';
      if (!hasAlert) delete body.alertText;
      const objName = (body.fullName || '').split('.')[0] || 'Account';
      // Use listMetadata (authoritative) to find existing rules and max sortOrder
      let maxSort = 0;
      let selfExists = false;
      try {
        const allRules = await sfMulti.listMetadata(org, 'DuplicateRule');
        for (const r of allRules) {
          const fn = r.fullName || '';
          if (!fn.startsWith(objName + '.')) continue;
          if (fn === body.fullName) { selfExists = true; continue; }
          // listMetadata is authoritative — read sortOrder
          try {
            const detail = await sfMulti.metadataRead(org, 'DuplicateRule', fn);
            const so = detail?.sortOrder || 0;
            if (so > maxSort) maxSort = so;
          } catch {}
        }
      } catch {}
      body.sortOrder = maxSort + 1;
      // Only UPDATE if listMetadata confirmed it exists; otherwise CREATE
      if (selfExists) {
        const upd = await sfMulti.metadataUpdate(org, 'DuplicateRule', body);
        const uitem = Array.isArray(upd) ? upd[0] : upd;
        const uok = uitem?.success !== false;
        const uerrs = uitem?.errors ? (Array.isArray(uitem.errors) ? uitem.errors : [uitem.errors]) : [];
        if (uok) return { ok: true, message: `✅ DuplicateRule atualizada: ${body.fullName} (sortOrder ${body.sortOrder})` };
        return { ok: false, message: `❌ Erro ao atualizar ${body.fullName}: ${uerrs.map(e => e.message || JSON.stringify(e)).join(', ')}` };
      }
      // Falls through to CREATE below
    }

    let result = await sfMulti.metadataCreate(org, mtype, body);
    let item = Array.isArray(result) ? result[0] : result;
    let ok = item?.success !== false;
    let errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
    const name = body.fullName || body.label || mtype;

    // RETRY logic for DuplicateRule sortOrder errors — increment until it works
    if (!ok && mtype === 'DuplicateRule') {
      const sortErr = errs.some(e => (e.message || '').toLowerCase().includes('sortorder'));
      if (sortErr) {
        for (let attempt = 1; attempt <= 10 && !ok; attempt++) {
          body.sortOrder = attempt;
          result = await sfMulti.metadataCreate(org, mtype, body);
          item = Array.isArray(result) ? result[0] : result;
          ok = item?.success !== false;
          errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
          if (ok) break;
          const stillSort = errs.some(e => (e.message || '').toLowerCase().includes('sortorder'));
          if (!stillSort) break; // different error, stop retrying
        }
      }
    }

    const alreadyExists = errs.some(e => {
      const msg = (e.message || e.statusCode || JSON.stringify(e)).toLowerCase();
      return msg.includes('already') || msg.includes('duplicate') || msg.includes('existe') || msg.includes('já existe') || msg.includes('unique') || msg.includes('already exists');
    });
    if (ok) return { ok: true, message: `✅ ${mtype} criado: ${name} (sortOrder ${body.sortOrder || '-'})` };
    const rawErrs = errs.map(e => e.message || JSON.stringify(e)).join(' | ');
    if (alreadyExists) return { ok: true, alreadyExists: true, message: `ℹ️ ${mtype} já existe: ${name} — prosseguindo` };
    return { ok: false, message: `❌ Erro em ${name}: ${rawErrs}` };
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
  if (step.action === 'metadata-delete') {
    const mtype = step.type;
    const fname = step.fullName || (step.body && step.body.fullName);
    if (!mtype || !fname) return { ok: false, message: '❌ metadata-delete requer type e fullName' };
    try {
      // Apex uses Tooling API delete
      if (mtype === 'ApexClass') {
        const r = await sfMulti.deleteApexClass(org, fname);
        return { ok: r.success, message: r.success ? `✅ ApexClass deletada: ${fname}` : `ℹ️ ${fname}: ${r.message || 'não encontrado'}` };
      }
      if (mtype === 'ApexTrigger') {
        const r = await sfMulti.deleteApexTrigger(org, fname);
        return { ok: r.success, message: r.success ? `✅ ApexTrigger deletado: ${fname}` : `ℹ️ ${fname}: ${r.message || 'não encontrado'}` };
      }
      const result = await sfMulti.metadataDelete(org, mtype, fname);
      const item = Array.isArray(result) ? result[0] : result;
      const ok = item?.success !== false;
      return { ok, message: ok ? `✅ ${mtype} deletado: ${fname}` : `❌ Erro ao deletar ${fname}` };
    } catch (e) { return { ok: false, message: `❌ ${e.message}` }; }
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
- Para perguntas técnicas, priorize configuração nativa (OOTB) > Flow > Apex

## Referência Metadata API — Formatos Corretos para Runbook

### CustomField
{ "fullName": "Object.Field__c", "label": "Label", "type": "Text|Number|Checkbox|Date|DateTime|Email|Phone|Url|Currency|Percent|LongTextArea|Picklist|MultiselectPicklist|Lookup",
  "length": 255, "precision": 18, "scale": 2, "visibleLines": 4,
  "referenceTo": "TargetObject", "relationshipLabel": "Label",
  "picklist": ["Val1","Val2"], "description": "..." }

### CustomObject
{ "fullName": "MyObject__c", "label": "My Object", "pluralLabel": "My Objects",
  "nameField": { "label": "Name", "type": "Text" },
  "deploymentStatus": "Deployed", "sharingModel": "ReadWrite" }

### MatchingRule
{ "fullName": "Object.RuleName", "label": "Label", "ruleStatus": "Active",
  "matchingRuleItems": [{ "fieldName": "Field__c", "matchingMethod": "Exact|CompanyName|FirstName|LastName|Phone|City|Street|Zip|Title" }] }
IMPORTANTE: matchingMethod NÃO aceita "Fuzzy". Para fuzzy em nomes de empresa usar "CompanyName".

### DuplicateRule
{ "fullName": "Object.RuleName", "masterLabel": "Label (NÃO usar label)",
  "isActive": true, "sortOrder": 1,
  "actionOnInsert": "Block|Allow", "actionOnUpdate": "Block|Allow",
  "alertText": "Mensagem ao usuario",
  "duplicateRuleMatchRules": [{ "matchRuleSObjectType": "Object", "matchingRule": "MatchingRuleName" }] }
IMPORTANTE: usar masterLabel (não label). sortOrder sequencial a partir de 1. objectMapping NÃO existe — usar matchRuleSObjectType.

### ValidationRule
{ "fullName": "Object.RuleName", "active": true,
  "errorConditionFormula": "ISBLANK(Field__c)",
  "errorMessage": "Mensagem de erro",
  "errorDisplayField": "Field__c" }

### RecordType
{ "fullName": "Object.RTName", "label": "Label", "active": true,
  "description": "..." }

### PermissionSet
{ "fullName": "PSName", "label": "Label", "description": "...",
  "fieldPermissions": [{ "field": "Object.Field__c", "editable": true, "readable": true }],
  "objectPermissions": [{ "object": "Object__c", "allowCreate": true, "allowRead": true, "allowEdit": true, "allowDelete": false }] }

### Profile (metadata-update apenas)
{ "fullName": "Admin", "fieldPermissions": [{ "field": "Object.Field__c", "editable": true, "readable": true }] }

### ListView
{ "fullName": "Object.ViewName", "label": "Label",
  "filterScope": "Everything", "columns": ["FIELD1","FIELD2"],
  "filters": [{ "field": "FIELD", "operation": "equals", "value": "val" }] }
`;

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

async function generateSpecJob(jobId, hf, org, userId) {
  // Gap Analysis
  let gapContext = '';
  try {
    const objMatches = [...new Set((hf.match(/\b([A-Z][a-zA-Z]+__c|Account|Contact|Lead|Opportunity|Case|Order|Product2|Quote|Contract|Asset|Campaign)\b/g) || []))];
    const found = [];
    for (const obj of objMatches.slice(0, 5)) {
      try {
        const d = await sfMulti.describeObject(org, obj);
        if (d && d.fields) {
          const customFields = d.fields.filter(f => f.custom).map(f => f.name);
          found.push(`- **${obj}** (existe, ${d.fields.length} campos): custom = ${customFields.slice(0, 30).join(', ') || 'nenhum'}`);
        }
      } catch { found.push(`- ${obj}: não existe na org (CRIAR NOVO se necessário)`); }
    }
    if (found.length > 0) {
      gapContext = `\n\n--- GAP ANALYSIS (ORG: ${org.name}) ---\nObjetos/campos já existentes. Separe "JÁ EXISTE (reaproveitar)" vs "CRIAR NOVO" nas seções 04 e 12/18:\n${found.join('\n')}\n--- FIM ---`;
    }
  } catch (e) { console.error('Gap analysis falhou:', e.message); }

  // Gerar com Opus
  const fullSystem = specInstructions + gapContext;
  const result = await claude.callRouted('spec', fullSystem, [{ role: 'user', content: hf }], 16384);
  const specMarkdown = result.text;

  const titleMatch = specMarkdown.match(/(?:User Story ID|ID)[:\s|]*([A-Z]+-?\d+)/i);
  const docTitle = titleMatch ? 'Spec_' + titleMatch[1] : 'Especificacao_Tecnica';

  await pool.query(
    'UPDATE jobs SET status = $1, result = $2, meta = meta || $3, updated_at = NOW() WHERE id = $4',
    ['done', specMarkdown, JSON.stringify({ model: result.model, docTitle }), jobId]
  );
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
        `### Gerar (Opus 4.6)\n` +
        `| Comando | Descrição |\n|---|---|\n` +
        `| \`/spec HF\` | Gera Especificação Técnica (.docx Dark) a partir de História Funcional, com gap analysis |\n` +
        `| \`/runbook ...\` | Cria e executa runbook passo a passo (texto livre ou JSON) |\n` +
        `| \`/qa US\` | Smoke test dos componentes deployados de uma US |\n\n` +
        `### Consulta\n` +
        `| Comando | Descrição |\n|---|---|\n` +
        `| \`/describe Objeto\` | Metadados completos (campos, RTs, picklists, relationships) |\n` +
        `| \`/objetos\` | Lista todos os objetos da org |\n` +
        `| \`/soql QUERY\` | Executa SOQL na org |\n` +
        `| \`/tooling QUERY\` | Consulta Tooling API |\n` +
        `| \`/layout Objeto\` | Lista layouts e seções |\n` +
        `| \`/metadata-read Tipo FullName\` | Lê metadado raw |\n\n` +
        `### Desenvolvimento\n` +
        `| Comando | Descrição |\n|---|---|\n` +
        `| \`/create-field ...\` | Cria campo custom (linguagem natural) |\n` +
        `| \`/delete-field Obj.Campo__c\` | Remove campo custom |\n` +
        `| \`/apex CÓDIGO\` | Executa Apex anônimo |\n\n` +
        `### Auditoria & Org\n` +
        `| Comando | Descrição |\n|---|---|\n` +
        `| \`/log [US]\` | Histórico de deploys (auditoria) |\n` +
        `| \`/status\` | Status da conexão |\n` +
        `| \`/help\` | Este menu |\n\n` +
        `**Runbook suporta:** CustomField, MatchingRule, DuplicateRule, ValidationRule, RecordType, PermissionSet, Apex Class, Apex Trigger, LWC, Flow.\n\n` +
        `Qualquer outra mensagem → **Claude Sonnet 4.6**.`;
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
        let spec;  // create-field stays on Sonnet — simple parsing
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

        // ── /spec — gera Especificação Técnica (ASYNC job, Opus + gap analysis) ──
    if (lower.startsWith('/spec')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada para gap analysis.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const hf = userMsg.trim().substring(5).trim();
      if (!hf) return res.json({ choices: [{ message: { content: '⚠️ Cole a História Funcional após /spec. O Opus vai gerar a especificação técnica completa (.docx Dark) com gap analysis contra a ORG ARQUITETURA + runbook acoplado.' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });

      // Create job and return immediately
      const jobRes = await pool.query(
        'INSERT INTO jobs (user_id, kind, status, input, meta) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [req.user.id, 'spec', 'processing', hf, JSON.stringify({ orgId: org.id, orgName: org.name })]
      );
      const jobId = jobRes.rows[0].id;

      // Process in background (não await — deixa rodar após a resposta)
      generateSpecJob(jobId, hf, org, req.user.id).catch(e => {
        console.error('Spec job error:', e.message);
        pool.query('UPDATE jobs SET status = $1, error = $2, updated_at = NOW() WHERE id = $3', ['error', e.message, jobId]).catch(() => {});
      });

      return res.json({
        choices: [{ message: { content: '⏳ **Gerando especificação técnica com Claude Opus 4.6...**\n\nIsso leva ~40-90s (18 seções + gap analysis + runbook). Aguarde, o documento aparecerá automaticamente.' } }],
        modelo_usado: 'job',
        modelo_label: 'Opus 4.6 (processando)',
        tipo: 'job-started',
        jobId
      });
    }

    // ── /runbook — lê manifest e executa passo a passo ──
    if (lower.startsWith('/runbook')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const input = userMsg.trim().substring(8).trim();
      if (!input) return res.json({ choices: [{ message: { content: '⚠️ Cole o runbook (JSON ou texto livre).\n\nExemplo JSON:\n```json\n[\n  { "action": "create-field", "object": "Lead", "field": "Segmento__c", "type": "Picklist", "values": ["PME","Enterprise"] },\n  { "action": "create-field", "object": "Lead", "field": "SLA__c", "type": "Number" },\n  { "action": "apex", "code": "System.debug(\'done\');" }\n]\n```\nOu descreva em texto livre que o Claude interpreta.' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });

      try {
        let steps;
        let parseModel = null;
        // Try JSON first
        try {
          const clean = input.replace(/```json\n?|```\n?/g, '').trim();
          steps = JSON.parse(clean);
          if (!Array.isArray(steps)) steps = [steps];
        } catch {
          // Natural language → Claude parses into steps
          const parsePrompt = `Analise este runbook/spec e extraia as ações de deployment Salesforce. Responda SOMENTE com um JSON array (sem markdown, sem backticks).

Ações disponíveis:
- "action": "create-field" — criar campo custom
- "action": "metadata-create" — criar qualquer metadado (MatchingRule, DuplicateRule, ValidationRule, RecordType, PermissionSet, CustomObject, ListView)
- "action": "metadata-update" — atualizar metadado existente (Profile FLS, etc)
- "action": "apex-class" — criar Apex Class (gerar código completo)
- "action": "apex-trigger" — criar Apex Trigger (gerar código completo)
- "action": "lwc" — criar Lightning Web Component (gerar bundle)
- "action": "flow" — criar Flow (gerar metadata)
- "action": "apex" — executar Apex anônimo
- "action": "soql" — executar SOQL
- "action": "validate" — validação automática (query + condition: "empty"|"has-results"|"no-modify-all-data")

Para create-field: "object", "field" (__c), "label", "type", "length", "values" (Picklist), "referenceTo" (Lookup)
Para metadata-create/update: "type" (tipo do metadado), "body" (JSON exato da Metadata API), "description"

FORMATOS METADATA API OBRIGATÓRIOS:
- MatchingRule: { fullName, label, ruleStatus:"Active", matchingRuleItems:[{fieldName, matchingMethod:"Exact"|"CompanyName"|"FirstName"|"LastName"|"Phone"|"City"|"Street"|"Zip"|"Title"}] }. NÃO usar "Fuzzy" — para fuzzy de empresa usar "CompanyName".
- DuplicateRule: { fullName, masterLabel (NÃO label!), isActive, sortOrder (sequencial de 1), actionOnInsert:"Block"|"Allow", actionOnUpdate, alertText, duplicateRuleMatchRules:[{matchRuleSObjectType, matchingRule}] }. NÃO usar objectMapping — usar matchRuleSObjectType.
- ValidationRule: { fullName:"Obj.Name", active:true, errorConditionFormula, errorMessage, errorDisplayField }
- RecordType: { fullName:"Obj.Name", label, active:true }
- PermissionSet: { fullName, label, fieldPermissions:[{field,editable,readable}] }

FORMATOS COMPONENTES EXÓTICOS:
- apex-class: { "action":"apex-class", "name":"NomeClasse", "body":"public with sharing class NomeClasse { ... }", "description":"..." }. Gere código Apex completo e válido. Inclua test class separada quando fizer sentido (outro step apex-class com @isTest).
- apex-trigger: { "action":"apex-trigger", "name":"NomeTrigger", "body":"trigger NomeTrigger on Account (before insert, before update) { ... }", "description":"..." }. Sempre delegue lógica a uma handler class (best practice). O body do trigger deve ser fino.
- lwc: { "action":"lwc", "name":"meuComponente", "files": { "html":"<template>...</template>", "js":"import { LightningElement } from 'lwc'; export default class MeuComponente extends LightningElement { ... }", "meta":"<?xml version=\"1.0\"?><LightningComponentBundle xmlns=\"http://soap.sforce.com/2006/04/metadata\"><apiVersion>62.0</apiVersion><isExposed>true</isExposed><targets><target>lightning__RecordPage</target></targets></LightningComponentBundle>" }, "description":"..." }. Nome em camelCase. Classe JS em PascalCase.
- flow: { "action":"flow", "fullName":"Nome_Flow", "body": { "label":"Label do Flow", "processType":"AutoLaunchedFlow"|"Flow", "status":"Active", "start":{...}, ... }, "description":"..." }. Para Flow, gere a metadata estruturada. Prefira processType AutoLaunchedFlow para record-triggered. Flows complexos: gere os elementos (recordLookups, decisions, assignments, recordUpdates) com conectores corretos.

REGRAS DE DEPLOY (best practices):
- Apex Trigger sempre fino + handler class (2 steps: apex-class do handler primeiro, depois apex-trigger).
- Apex Class de negócio sempre com test class (cobertura mínima 75%).
- Ordene os steps por dependência: campos antes de Apex que os usa; handler class antes do trigger; Matching Rules antes de Duplicate Rules.

Se o campo não tem __c, adicione. Converta nomes para API format.`;

          const parsedResult = await claude.callRouted('runbook-parse', parsePrompt, [{ role: 'user', content: input }], 8192);
          parseModel = parsedResult.model;
          const parsed = parsedResult.text;
          const cleanParsed = parsed.replace(/```json\n?|```\n?/g, '').trim();
          steps = JSON.parse(cleanParsed);
          if (!Array.isArray(steps)) steps = [steps];
        }

        if (!steps.length) return res.json({ choices: [{ message: { content: '❌ Nenhuma ação encontrada no runbook.' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'error' });

        // Get org URL
        let orgUrl = '';
        try { const c = await sfMulti.testConnection(org); orgUrl = c.instanceUrl || ''; } catch {}
        const orgLink = orgUrl ? orgUrl.replace('https://','') : org.username;

        // Show FULL PLAN summary before starting
        let preview = `## Runbook — ${steps.length} passos\n\n`;
        preview += `**Org:** [${orgLink}](${orgUrl})\n`;
        if (parseModel) {
          preview += `**Gerado por:** ${parseModel.includes('opus') ? 'Claude Opus 4.6' : parseModel}\n`;
        }
        preview += `\n`;
        preview += `| # | Ação | Componente | Detalhes |\n|---|---|---|---|\n`;
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i];
          let comp = '', det = '';
          if (s.action === 'metadata-create' || s.action === 'metadata-update') {
            comp = s.body?.fullName || s.type || '';
            det = s.description || s.body?.masterLabel || s.body?.label || s.type;
          } else if (s.action === 'create-field') {
            comp = s.object + '.' + s.field;
            det = s.type || 'Text';
          } else if (s.action === 'soql') {
            comp = 'SOQL';
            det = s.description || (s.query || '').substring(0, 60);
          } else if (s.action === 'validate') {
            comp = 'Validação';
            det = s.description || s.condition || '';
          } else if (s.action === 'apex') {
            comp = 'Apex';
            det = s.description || (s.code || '').substring(0, 60);
          } else if (s.action === 'manual-step') {
            comp = 'Manual';
            det = (s.description || '').substring(0, 60);
          } else {
            comp = s.action;
            det = s.description || '';
          }
          preview += `| ${i + 1} | ${s.action} | ${comp} | ${det.substring(0, 80)} |\n`;
        }
        preview += `\n**Confirme para iniciar a execução passo a passo.**`;

        // Detect US number: pega a primeira "palavra-código" antes do JSON/descrição
        // Padrões: CRMB2B-90, TESTE-QA, US-123, ABC-456, JIRA-1234
        let usNumber = null;
        const usPatterns = [
          /\b([A-Z][A-Z0-9]*B2B-\d+)\b/i,        // CRMB2B-90
          /\b(US[-\s]?\d+)\b/i,                   // US-123, US 123
          /\b([A-Z]{2,}-[A-Z0-9]+)\b/,            // TESTE-QA, ABC-123, JIRA-456
        ];
        for (const pat of usPatterns) {
          const m = input.match(pat);
          if (m) { usNumber = m[1].toUpperCase().replace(/\s+/, '-'); break; }
        }

        const payload = { steps, currentStep: 0, us: usNumber };

        let usLine = usNumber ? `**US:** ${usNumber}\n` : '';
        preview = preview.replace('**Org:**', usLine + '**Org:**');

        return res.json({ choices: [{ message: { content: preview } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'confirm', confirmData: { action: 'runbook', payload: Buffer.from(JSON.stringify(payload)).toString('base64') } });
      } catch (e) { return res.json({ choices: [{ message: { content: `❌ Erro ao processar runbook: ${e.message}` } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' }); }
    }

        // ── /qa [US] — smoke test dos componentes deployados ──
    if (lower === '/qa' || lower.startsWith('/qa ')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const usFilter = userMsg.trim().substring(3).trim().toUpperCase();
      if (!usFilter) return res.json({ choices: [{ message: { content: '⚠️ Use: /qa CRMB2B-90 — roda smoke test dos componentes deployados nessa US.' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });

      try {
        // Buscar componentes da US no deploy_log (apenas sucessos)
        const logRows = (await pool.query(
          "SELECT DISTINCT component, action FROM deploy_log WHERE UPPER(us_number) = $1 AND result IN ('success','exists') ORDER BY component",
          [usFilter]
        )).rows;

        if (!logRows.length) return res.json({ choices: [{ message: { content: `📭 Nenhum componente deployado encontrado para ${usFilter}. Rode o runbook primeiro.` } }], modelo_usado: 'local', modelo_label: 'QA', tipo: 'qa' });

        let report = `## 🔍 QA Smoke Test — ${usFilter}\n\n`;
        report += `**Org:** ${org.name}\n**Componentes verificados:** ${logRows.length}\n\n`;
        report += `| Componente | Tipo | Verificação | Status |\n|---|---|---|---|\n`;

        let passCount = 0, failCount = 0;
        for (const row of logRows) {
          const comp = row.component;
          const act = row.action;
          let check = '', status = '', ok = false;

          try {
            if (act === 'create-field' || (comp && comp.includes('.') && comp.endsWith('__c') && act === 'metadata-create')) {
              // Campo: verificar via describe
              const [objName, fieldName] = comp.split('.');
              const d = await sfMulti.describeObject(org, objName);
              const found = d.fields && d.fields.find(f => f.name === fieldName);
              ok = !!found;
              check = found ? `Campo existe (${found.type})` : 'Campo NÃO encontrado';
              status = ok ? '✅' : '❌';
            } else if (act === 'metadata-create' || act === 'metadata-update') {
              // Metadado: inferir tipo pelo nome e ler
              let mtype = 'CustomField';
              if (comp.includes('MR_') || comp.toLowerCase().includes('match')) mtype = 'MatchingRule';
              else if (comp.includes('DR_') || comp.toLowerCase().includes('dup')) mtype = 'DuplicateRule';
              else if (comp.includes('.') && comp.endsWith('__c')) mtype = 'CustomField';
              const meta = await sfMulti.metadataRead(org, mtype, comp);
              if (mtype === 'DuplicateRule') {
                ok = meta && meta.masterLabel && meta.masterLabel.length > 0;
                check = ok ? `Ativa: ${meta.isActive}, ação: ${meta.actionOnInsert}` : 'Regra vazia/inexistente';
              } else if (mtype === 'MatchingRule') {
                ok = meta && (meta.ruleStatus === 'Active' || meta.masterLabel);
                check = ok ? `Status: ${meta.ruleStatus || 'OK'}` : 'Regra não encontrada';
              } else {
                ok = meta && Object.keys(meta).length > 0;
                check = ok ? 'Existe' : 'Não encontrado';
              }
              status = ok ? '✅' : '❌';
            } else if (act === 'apex-class') {
              const q = await sfMulti.runToolingQuery(org, `SELECT Id, Status FROM ApexClass WHERE Name = '${comp}'`);
              ok = q.records && q.records.length > 0;
              check = ok ? `Status: ${q.records[0].Status}` : 'Classe não encontrada';
              status = ok ? '✅' : '❌';
            } else if (act === 'apex-trigger') {
              const q = await sfMulti.runToolingQuery(org, `SELECT Id, Status FROM ApexTrigger WHERE Name = '${comp}'`);
              ok = q.records && q.records.length > 0;
              check = ok ? `Status: ${q.records[0].Status}` : 'Trigger não encontrado';
              status = ok ? '✅' : '❌';
            } else {
              check = 'Tipo não verificável (soql/validate/manual)';
              status = '➖';
              ok = true; // não conta como falha
            }
          } catch (e) {
            check = 'Erro: ' + (e.message || '').substring(0, 40);
            status = '❌';
            ok = false;
          }

          if (status === '✅') passCount++;
          else if (status === '❌') failCount++;
          report += `| ${comp} | ${act} | ${check} | ${status} |\n`;
        }

        report += `\n### Resultado\n`;
        report += `- ✅ **Passou:** ${passCount}\n`;
        report += `- ❌ **Falhou:** ${failCount}\n`;
        const verdict = failCount === 0 ? '🟢 **APROVADO** — todos os componentes verificados estão presentes e configurados.' : `🔴 **ATENÇÃO** — ${failCount} componente(s) com problema. Revisar antes do go-live.`;
        report += `\n${verdict}`;

        return res.json({ choices: [{ message: { content: report } }], modelo_usado: 'mcp-server', modelo_label: 'QA Agent — ' + org.name, tipo: 'qa' });
      } catch (e) { return res.json({ choices: [{ message: { content: `❌ ${e.message}` } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' }); }
    }

        // ── /log [US] — histórico de auditoria de deploys ──
    if (lower === '/log' || lower.startsWith('/log ')) {
      const filter = userMsg.trim().substring(4).trim().toUpperCase();
      try {
        let rows;
        if (filter) {
          rows = (await pool.query('SELECT * FROM deploy_log WHERE UPPER(us_number) = $1 OR UPPER(component) LIKE $2 ORDER BY created_at DESC LIMIT 100', [filter, '%' + filter + '%'])).rows;
        } else {
          rows = (await pool.query('SELECT * FROM deploy_log ORDER BY created_at DESC LIMIT 50')).rows;
        }
        if (!rows.length) return res.json({ choices: [{ message: { content: filter ? `📭 Nenhum registro para "${filter}".` : '📭 Nenhum deploy registrado ainda.' } }], modelo_usado: 'local', modelo_label: 'Auditoria', tipo: 'log' });
        let text = `## Auditoria de Deploys${filter ? ' — ' + filter : ' (últimos 50)'}\n\n`;
        text += `| Data | US | Componente | Ação | Resultado | Descrição |\n|---|---|---|---|---|---|\n`;
        for (const r of rows) {
          const dt = new Date(r.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
          const icon = r.result === 'success' ? '✅' : r.result === 'exists' ? 'ℹ️' : '❌';
          text += `| ${dt} | ${r.us_number || '—'} | ${r.component || '—'} | ${r.action || '—'} | ${icon} | ${(r.description || '').substring(0, 50)} |\n`;
        }
        return res.json({ choices: [{ message: { content: text } }], modelo_usado: 'local', modelo_label: 'Auditoria', tipo: 'log' });
      } catch (e) { return res.json({ choices: [{ message: { content: `❌ ${e.message}` } }], modelo_usado: 'local', modelo_label: 'Erro', tipo: 'error' }); }
    }

        // ── /debug-dr — debug DuplicateRule state ──
    if (lower === '/debug-dr') {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Sem org.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      try {
        const list = await sfMulti.listMetadata(org, 'DuplicateRule');
        let text = `## Debug DuplicateRule\n\n**listMetadata retornou ${list.length} regras:**\n\n`;
        for (const r of list) {
          text += `- ${r.fullName}\n`;
        }
        text += `\n**Detalhes (metadata.read):**\n\n`;
        for (const r of list.filter(x => (x.fullName||'').startsWith('Account.'))) {
          try {
            const d = await sfMulti.metadataRead(org, 'DuplicateRule', r.fullName);
            text += `- **${r.fullName}**: sortOrder=${d.sortOrder}, masterLabel="${d.masterLabel}", isActive=${d.isActive}\n`;
          } catch (e) { text += `- ${r.fullName}: erro ao ler\n`; }
        }
        return res.json({ choices: [{ message: { content: text } }], modelo_usado: 'mcp-server', modelo_label: 'Debug', tipo: 'debug' });
      } catch (e) { return res.json({ choices: [{ message: { content: `❌ ${e.message}` } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' }); }
    }

        // ── /delete-field Object.Field__c ──
    if (lower.startsWith('/delete-field ')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const fname = userMsg.trim().substring(14).trim();
      if (!fname || !fname.includes('.')) return res.json({ choices: [{ message: { content: '⚠️ Use: /delete-field Lead.Campo__c' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });
      let orgUrl = '';
      try { const c = await sfMulti.testConnection(org); orgUrl = c.instanceUrl || ''; } catch {}
      const orgLink = orgUrl ? orgUrl.replace('https://','') : org.username;
      const preview = `### Deletar campo?\n\n**Org:** [${orgLink}](${orgUrl})\n\n- **Campo:** ${fname}\n\n⚠️ Esta ação é irreversível.`;
      const payload = Buffer.from(JSON.stringify({ type: 'CustomField', fullName: fname })).toString('base64');
      return res.json({ choices: [{ message: { content: preview } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'confirm', confirmData: { action: 'delete-field', payload } });
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
          await logDeployAction({ us: null, component: body.fullName, action: 'create-field', description: 'Campo ' + body.type, result: ok ? 'success' : 'error', resultMessage: text, orgId: org.id, orgName: org.name, userId: req.user.id, userName: req.user.name });
          return res.json({ choices: [{ message: { content: text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'executed' });
        }
        if (action === 'runbook') {
          const { steps, currentStep, us } = body;
          const step = steps[currentStep];
          // Execute current step
          const result = await executeRunbookStep(step, org);
          // Log to deploy_log
          await logDeployAction({
            us: us,
            component: extractComponent(step),
            action: step.action,
            description: step.description || '',
            result: result.ok ? (result.alreadyExists ? 'exists' : 'success') : 'error',
            resultMessage: result.message,
            orgId: org.id,
            orgName: org.name,
            userId: req.user.id,
            userName: req.user.name
          });
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
        if (action === 'delete-field') {
          const result = await sfMulti.metadataDelete(org, body.type || 'CustomField', body.fullName);
          const item = Array.isArray(result) ? result[0] : result;
          const ok = item?.success !== false;
          const text = ok ? `✅ **Campo deletado:** ${body.fullName}` : `❌ Erro ao deletar ${body.fullName}`;
          return res.json({ choices: [{ message: { content: text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'executed' });
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
