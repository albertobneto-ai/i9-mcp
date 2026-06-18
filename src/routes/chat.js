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
    // Picklist values — aceita picklist, values ou picklistValues
    const previewValues = step.picklist || step.values || step.picklistValues;
    if (Array.isArray(previewValues) && previewValues.length > 0) {
      text += `- **Valores:** ${previewValues.join(', ')}\n`;
    } else if (['Picklist','MultiselectPicklist'].includes(step.type)) {
      text += `- **Valores:** ⚠️ NÃO INFORMADOS (campo Picklist precisa de valores)\n`;
    }
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
  } else if (step.action === 'rollback-restore') {
    text += `**⏪ Restaurar versão anterior**\n`;
    text += `- **Tipo:** ${step.type}\n`;
    text += `- **Componente:** ${step.fullName}\n`;
    if (step.description) text += `- **Descrição:** ${step.description}\n`;
  } else if (step.action === 'ps-fls') {
    text += `**Ação:** FLS no PermissionSet\n`;
    text += `- **Permission Set:** ${step.permissionSetName}\n`;
    const fps = step.fieldPermissions || [];
    text += `- **Campos:** ${fps.length}\n`;
    if (fps.length <= 10) {
      for (const fp of fps) {
        text += `  - ${fp.field}: read=${fp.readable !== false ? '✓' : '✗'} edit=${fp.editable ? '✓' : '✗'}\n`;
      }
    }
  } else if (step.action === 'assign-ps-to-user') {
    text += `**Ação:** Atribuir PermissionSet a usuários\n`;
    text += `- **Permission Set:** ${step.permissionSetName}\n`;
    if (step.users) text += `- **Users (emails):** ${step.users.join(', ')}\n`;
    if (step.userIds) text += `- **User IDs:** ${step.userIds.length}\n`;
    if (step.usernamePattern) text += `- **Pattern:** ${step.usernamePattern}\n`;
  } else if (step.action === 'enable-field-history') {
    text += `**Ação:** Ativar Field History Tracking\n`;
    text += `- **Objeto:** ${step.object}\n`;
    text += `- **Campos:** ${(step.fields || []).join(', ')}\n`;
  } else if (step.action === 'create-layout') {
    text += `**Ação:** Criar Page Layout\n`;
    text += `- **Objeto:** ${step.object}\n`;
    text += `- **Layout:** ${step.layoutName || step.name}\n`;
    const secs = step.sections || [];
    text += `- **Seções (${secs.length}):**\n`;
    for (const s of secs.slice(0, 5)) {
      const fieldCount = (s.columns || []).reduce((acc, col) => acc + (col || []).length, 0);
      text += `  - ${s.label} (${fieldCount} campos)\n`;
    }
  } else if (step.action === 'assign-layout') {
    text += `**Ação:** Atribuir Page Layout a Profile\n`;
    text += `- **Profile:** ${step.profileName}\n`;
    text += `- **Layout:** ${step.layoutName}\n`;
    if (step.recordType) text += `- **Record Type:** ${step.recordType}\n`;
  } else if (step.action === 'assign-custom-permission') {
    text += `**Ação:** Atribuir Custom Permission(s) a PermissionSet\n`;
    text += `- **PermissionSet:** ${step.permissionSetName}\n`;
    const cps = Array.isArray(step.customPermissions) ? step.customPermissions : [step.customPermissions];
    text += `- **Custom Permissions:** ${cps.filter(Boolean).join(', ')}\n`;
    text += `- **Enabled:** ${step.enabled !== false ? 'true' : 'false'}\n`;
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
      `INSERT INTO deploy_log (us_number, component, action, description, result, result_message, org_id, org_name, user_id, user_name, previous_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [entry.us || null, entry.component || null, entry.action || null, entry.description || null,
       entry.result || null, entry.resultMessage || null, entry.orgId || null, entry.orgName || null,
       entry.userId || null, entry.userName || null, entry.previousState || null]
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


// Normaliza metadata de Flow para API 62.0
// API 62.0 mudou: triggerType, recordTriggerType, object devem ficar DENTRO de start{}, não na raiz
function normalizeFlowMetadata(flow) {
  if (!flow || typeof flow !== 'object') return flow;
  const out = { ...flow };

  // Garantir defaults obrigatórios em API 62.0
  if (!out.apiVersion) out.apiVersion = 62.0;
  if (!out.processType) out.processType = 'AutoLaunchedFlow';
  if (!out.status) out.status = 'Active';
  if (!out.label && out.fullName) out.label = out.fullName.replace(/_/g,' ');

  // Mover triggerType/recordTriggerType/object da raiz para start{} (formato API 62.0)
  const startObj = out.start && typeof out.start === 'object' ? { ...out.start } : {};
  const triggerFields = ['triggerType','recordTriggerType','object','filterFormula','filterLogic','filters','schedule','scheduledPaths','flowRunAsUser','runInMode'];
  for (const f of triggerFields) {
    if (out[f] !== undefined && startObj[f] === undefined) {
      startObj[f] = out[f];
      delete out[f];
    }
  }
  // Se há triggerType ou recordTriggerType, processType deve ser AutoLaunchedFlow ou Flow (não pode ser AutoLaunchedFlow para record-triggered)
  if (startObj.triggerType || startObj.recordTriggerType) {
    if (out.processType === 'AutoLaunchedFlow' && (startObj.triggerType === 'RecordAfterSave' || startObj.triggerType === 'RecordBeforeSave')) {
      out.processType = 'AutoLaunchedFlow';
    }
    // start.locationX/locationY são obrigatórios em alguns casos
    if (startObj.locationX === undefined) startObj.locationX = 50;
    if (startObj.locationY === undefined) startObj.locationY = 0;
  }

  // Corrigir enums comuns que o Opus alucina em FlowComparisonOperator
  function fixOperator(op) {
    if (!op || typeof op !== 'string') return op;
    const map = {
      'DoesNotContain': 'WasSet', // hack: não existe NotContain em filterCondition, mas pode ser tratado com 'Contains' invertido pelo flow
      'NotContain': 'WasSet',
      'NotContains': 'WasSet',
      'DoesNotEqual': 'NotEqualTo',
      'Equals': 'EqualTo',
      'NotEqual': 'NotEqualTo',
      'GreaterThan': 'GreaterThan',
      'LessThan': 'LessThan',
      'GreaterEqual': 'GreaterThanOrEqualTo',
      'LessEqual': 'LessThanOrEqualTo'
    };
    return map[op] || op;
  }

  // Aplicar fix de operadores recursivamente
  function walkAndFix(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (k === 'operator' && typeof obj[k] === 'string') {
        const fixed = fixOperator(obj[k]);
        if (fixed !== obj[k]) obj[k] = fixed;
      } else if (typeof obj[k] === 'object') {
        walkAndFix(obj[k]);
      }
    }
  }
  walkAndFix(out);

  if (Object.keys(startObj).length > 0) out.start = startObj;
  return out;
}

async function executeRunbookStep(step, org) {
  if (step.action === 'create-field') {
    const fullName = step.object + '.' + step.field;
    const body = { fullName, label: step.label || step.field.replace('__c','').replace(/_/g,' '), type: step.type || 'Text' };
    if (['Text'].includes(body.type)) body.length = step.length || 255;
    if (body.type === 'LongTextArea') { body.length = step.length || 32768; body.visibleLines = 4; }
    if (['Number','Currency','Percent'].includes(body.type)) { body.precision = step.precision || 18; body.scale = step.scale ?? 2; }
    if (body.type === 'Lookup' && step.referenceTo) { body.referenceTo = step.referenceTo; body.relationshipLabel = body.label; }
    // Picklist — aceita step.picklist OU step.values OU step.picklistValues; converte array → valueSet (formato API 62.0+)
    if (['Picklist','MultiselectPicklist'].includes(body.type)) {
      const pickValues = step.picklist || step.values || step.picklistValues;
      if (Array.isArray(pickValues) && pickValues.length > 0) {
        // jsforce API 62.0 exige formato valueSet → valueSetDefinition → value[]
        body.valueSet = {
          restricted: true,
          valueSetDefinition: {
            sorted: false,
            value: pickValues.map(v => {
              if (typeof v === 'string') return { fullName: v, default: false, label: v };
              return { fullName: v.fullName || v.value || v.label, default: v.default || false, label: v.label || v.fullName || v.value };
            })
          }
        };
        if (body.type === 'MultiselectPicklist') body.visibleLines = step.visibleLines || 4;
      } else {
        return { ok: false, message: '❌ Campo Picklist sem valores. O step precisa de "picklist":["v1","v2"] ou "values":["v1","v2"]. Step: ' + JSON.stringify(step).substring(0, 300) };
      }
    }
    // Checkbox requires defaultValue
    if (body.type === 'Checkbox') { body.defaultValue = (step.defaultValue === true || step.defaultValue === 'true'); }
    // LongTextArea visibleLines default
    if (body.type === 'LongTextArea' && !body.visibleLines) body.visibleLines = 4;
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
    // Snapshot: read current state before deploy (for rollback)
    let previousState = null;
    try { const snap = await sfMulti.readApexBody(org, name, 'ApexClass'); if (snap.exists) previousState = JSON.stringify({ type: 'ApexClass', name, body: snap.body }); } catch {}
    try {
      const r = await sfMulti.deployApexClass(org, name, body);
      const ok = r.success !== false;
      if (ok) return { ok: true, message: `✅ Apex Class criada: ${name}`, previousState };
      const errs = r.errors ? (Array.isArray(r.errors) ? r.errors : [r.errors]) : [];
      return { ok: false, message: `❌ Erro na classe ${name}: ${errs.map(e => e.message || JSON.stringify(e)).join(', ')}` };
    } catch (e) {
      const msg = e.message || String(e);
      return { ok: false, message: `❌ ${name}: ${msg.substring(0, 300)}` };
    }
  }
  if (step.action === 'apex-trigger') {
    const name = step.name || step.triggerName;
    const body = step.body || step.code;
    if (!name || !body) return { ok: false, message: '❌ apex-trigger requer name e body' };
    let previousState = null;
    try { const snap = await sfMulti.readApexBody(org, name, 'ApexTrigger'); if (snap.exists) previousState = JSON.stringify({ type: 'ApexTrigger', name, body: snap.body }); } catch {}
    try {
      const r = await sfMulti.deployApexTrigger(org, name, body, step.object || step.sobjectType);
      const ok = r.success !== false;
      if (ok) return { ok: true, message: `✅ Apex Trigger criado: ${name}`, previousState };
      const errs = r.errors ? (Array.isArray(r.errors) ? r.errors : [r.errors]) : [];
      return { ok: false, message: `❌ Erro no trigger ${name}: ${errs.map(e => e.message || JSON.stringify(e)).join(', ')}` };
    } catch (e) { return { ok: false, message: `❌ ${name}: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'lwc') {
    const name = step.name;
    const files = step.files;
    if (!name || !files) return { ok: false, message: '❌ lwc requer name e files (html, js, meta)' };
    let previousState = null;
    try { const snap = await sfMulti.readLWCBundleFiles(org, name); if (snap.exists) previousState = JSON.stringify({ type: 'LWC', name, files: snap.files }); } catch {}
    try {
      const r = await sfMulti.deployLWC(org, name, files);
      const ok = r.success === true || r.status === 'Succeeded';
      if (ok) return { ok: true, message: `✅ LWC deployado: ${name}`, previousState };
      const details = r.details?.componentFailures || [];
      const errMsg = Array.isArray(details) ? details.map(d => d.problem).join('; ') : (r.errorMessage || JSON.stringify(r).substring(0, 200));
      return { ok: false, message: `❌ LWC ${name}: ${errMsg}` };
    } catch (e) { return { ok: false, message: `❌ LWC ${name}: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'flow') {
    const fullName = step.fullName || step.name;
    const flowBodyRaw = step.body || step.flow;
    if (!fullName || !flowBodyRaw) return { ok: false, message: '❌ flow requer fullName e body' };
    try {
      // Normalizar Flow para formato API 62.0
      const flowBody = normalizeFlowMetadata(flowBodyRaw);
      const r = await sfMulti.deployFlow(org, fullName, flowBody);
      const item = Array.isArray(r) ? r[0] : r;
      const ok = item?.success !== false;
      if (ok) return { ok: true, message: `✅ Flow criado: ${fullName}` };
      const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
      return { ok: false, message: `❌ Erro no Flow ${fullName}: ${errs.map(e => e.message || JSON.stringify(e)).join(', ')}` };
    } catch (e) { return { ok: false, message: `❌ Flow ${fullName}: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'soql') {
    try {
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
    } catch (e) { return { ok: false, message: `❌ Erro na SOQL:\n${step.query}\n\n${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'metadata-create') {
    // Aceitar 2 formatos do Opus: step.type OU step.metadataType
    const mtype = step.type || step.metadataType;
    const body = step.body ? { ...step.body } : null;
    if (!mtype) return { ok: false, message: '❌ metadata-create requer type (ou metadataType). Recebido: ' + JSON.stringify(step).substring(0, 200) };
    
    // ═══ AUTO-CONVERSÃO ═══ Se for CustomField, redirecionar para handler create-field (que sabe lidar com Picklist/valueSet/etc)
    if (mtype === 'CustomField') {
      const fullName = (body && body.fullName) || (step.object + '.' + step.field);
      const [objName, fieldName] = fullName.split('.');
      // Construir step no formato create-field
      const cfStep = {
        action: 'create-field',
        object: objName,
        field: fieldName,
        label: (body && body.label) || step.label || fieldName.replace('__c','').replace(/_/g,' '),
        type: (body && body.type) || step.fieldType || step.type,
        length: (body && body.length) || step.length,
        precision: (body && body.precision) || step.precision,
        scale: (body && body.scale) || step.scale,
        picklist: (body && (body.picklist || body.values || body.picklistValues)) || step.picklist || step.values || step.picklistValues,
        referenceTo: (body && body.referenceTo) || step.referenceTo,
        defaultValue: (body && body.defaultValue !== undefined) ? body.defaultValue : step.defaultValue,
        description: (body && body.description) || step.description,
        required: (body && body.required) || step.required
      };
      // Se valueSet veio do prompt do Opus (formato XML), extrair valores
      if (body && body.valueSet) {
        const vs = body.valueSet;
        const vsd = vs.valueSetDefinition || vs;
        const values = vsd.value || vsd.values || [];
        if (Array.isArray(values)) {
          cfStep.picklist = values.map(v => typeof v === 'string' ? v : (v.fullName || v.label || v.value));
        }
      }
      // Recursão controlada — executa o handler create-field
      return await executeRunbookStep(cfStep, org);
    }
    
    if (!body) return { ok: false, message: '❌ metadata-create requer body para tipo ' + mtype };

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
        // Snapshot before update (for rollback)
        let drPreviousState = null;
        try {
          const snap = await sfMulti.metadataRead(org, 'DuplicateRule', body.fullName);
          if (snap && snap.masterLabel) drPreviousState = JSON.stringify({ type: 'DuplicateRule', fullName: body.fullName, body: snap });
        } catch {}
        const upd = await sfMulti.metadataUpdate(org, 'DuplicateRule', body);
        const uitem = Array.isArray(upd) ? upd[0] : upd;
        const uok = uitem?.success !== false;
        const uerrs = uitem?.errors ? (Array.isArray(uitem.errors) ? uitem.errors : [uitem.errors]) : [];
        if (uok) return { ok: true, message: `✅ DuplicateRule atualizada: ${body.fullName} (sortOrder ${body.sortOrder})`, previousState: drPreviousState };
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
  if (step.action === 'rollback-restore') {
    // Restore component to previous state from snapshot
    const snapshot = step.snapshot;
    if (!snapshot) return { ok: false, message: '❌ Sem snapshot para restaurar' };
    try {
      const snap = JSON.parse(snapshot);
      if (snap.type === 'ApexClass' || snap.type === 'ApexTrigger') {
        // Redeploy original Apex body
        const deployFn = snap.type === 'ApexClass' ? sfMulti.deployApexClass : sfMulti.deployApexTrigger;
        const r = await deployFn(org, snap.name, snap.body);
        const ok = r.success !== false;
        return { ok, message: ok ? `⏪ ${snap.type} restaurado: ${snap.name}` : `❌ Erro ao restaurar ${snap.name}` };
      }
      if (snap.type === 'LWC') {
        const r = await sfMulti.deployLWC(org, snap.name, snap.files);
        const ok = r.success === true || r.status === 'Succeeded';
        return { ok, message: ok ? `⏪ LWC restaurado: ${snap.name}` : `❌ Erro ao restaurar LWC ${snap.name}` };
      }
      if (snap.type === 'DuplicateRule') {
        const r = await sfMulti.metadataUpdate(org, 'DuplicateRule', snap.body);
        const item = Array.isArray(r) ? r[0] : r;
        const ok = item?.success !== false;
        return { ok, message: ok ? `⏪ DuplicateRule restaurada: ${snap.fullName}` : `❌ Erro ao restaurar ${snap.fullName}` };
      }
      return { ok: false, message: `❌ Tipo ${snap.type} não suporta restore` };
    } catch (e) { return { ok: false, message: `❌ Erro no restore: ${(e.message || '').substring(0, 200)}` }; }
  }
  if (step.action === 'metadata-delete') {
    const mtype = step.type;
    const fname = step.fullName || (step.body && step.body.fullName);
    if (!mtype || !fname) return { ok: false, message: '❌ metadata-delete requer type e fullName' };
    try {
      // Apex uses Tooling API delete
      if (mtype === 'ApexClass') {
        const r = await sfMulti.deleteApexClass(org, fname);
        if (r.success) { try { await pool.query('DELETE FROM deploy_log WHERE component = $1', [fname]); } catch {} }
        else if ((r.message || '').includes('não encontrado')) { try { await pool.query('DELETE FROM deploy_log WHERE component = $1', [fname]); } catch {} }
        return { ok: r.success || (r.message || '').includes('não encontrado'), message: r.success ? `✅ ApexClass deletada: ${fname}` : `ℹ️ ${fname}: ${r.message || 'não encontrado'} — removido do histórico` };
      }
      if (mtype === 'ApexTrigger') {
        const r = await sfMulti.deleteApexTrigger(org, fname);
        if (r.success || (r.message || '').includes('não encontrado')) { try { await pool.query('DELETE FROM deploy_log WHERE component = $1', [fname]); } catch {} }
        return { ok: r.success || (r.message || '').includes('não encontrado'), message: r.success ? `✅ ApexTrigger deletado: ${fname}` : `ℹ️ ${fname}: não encontrado — removido do histórico` };
      }
      // DuplicateRule: fullName usa Object.RuleName (igual MatchingRule)
      let deleteName = fname;
      // MatchingRule/DuplicateRule: desativar via metadata read+update antes de deletar
      if (mtype === 'MatchingRule' || mtype === 'DuplicateRule') {
        try {
          const rule = await sfMulti.metadataRead(org, mtype, deleteName);
          if (rule && rule.fullName) {
            const isActive = mtype === 'MatchingRule' ? (rule.ruleStatus === 'Active') : (rule.isActive === true || rule.isActive === 'true');
            if (isActive) {
              if (mtype === 'MatchingRule') rule.ruleStatus = 'Inactive';
              else rule.isActive = false;
              await sfMulti.metadataUpdate(org, mtype, rule);
              await new Promise(r => setTimeout(r, 4000));
            }
          }
        } catch {} // ignore
      }
      // Tentar deletar com retry
      let delResult;
      const maxRetries = (mtype === 'MatchingRule' || mtype === 'DuplicateRule') ? 4 : 1;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          delResult = await sfMulti.metadataDelete(org, mtype, deleteName);
          const chk = Array.isArray(delResult) ? delResult[0] : delResult;
          if (chk?.success !== false) break;
          const errMsg = chk?.errors ? JSON.stringify(chk.errors) : '';
          // Se MR falha por DR associada ativa → desativar+deletar a DR primeiro
          if (mtype === 'MatchingRule' && errMsg.includes('associated to an active duplicate rule')) {
            // Extrair texto do erro (pode estar em JSON) e depois extrair DR label
            let errTextClean = errMsg;
            try { const parsed = JSON.parse(errMsg); errTextClean = (Array.isArray(parsed) ? parsed.map(e=>e.message||'').join(' ') : (parsed.message || errMsg)); } catch {}
            const drLabelMatch = errTextClean.match(/:\s*([A-Za-z0-9_ ]+)\.?\s*$/);
            if (drLabelMatch) {
              // Converter label para DeveloperName e prefixar com objeto
              const drDevName = drLabelMatch[1].trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '');
              const objPrefix = deleteName.includes('.') ? deleteName.split('.')[0] : 'Account';
              const drFullName = objPrefix + '.' + drDevName;
              try {
                // Desativar DR
                const dr = await sfMulti.metadataRead(org, 'DuplicateRule', drFullName);
                if (dr && dr.fullName) {
                  dr.isActive = false;
                  await sfMulti.metadataUpdate(org, 'DuplicateRule', dr);
                  await new Promise(r => setTimeout(r, 3000));
                }
                // Deletar DR
                await sfMulti.metadataDelete(org, 'DuplicateRule', drFullName);
                await new Promise(r => setTimeout(r, 3000));
              } catch {}
            }
            continue; // retry MR delete
          }
          if (errMsg.includes('activation') || errMsg.includes('deactivation') || errMsg.includes('must be active or inactive')) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          break;
        } catch (e) {
          if (attempt < maxRetries - 1) { await new Promise(r => setTimeout(r, 3000)); }
          else throw e;
        }
      }
      const item = Array.isArray(delResult) ? delResult[0] : delResult;
      const ok = item?.success !== false;
      if (!ok) {
        const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
        const errText = errs.map(e => e.message || JSON.stringify(e)).join(', ');
        // "not found" / "does not exist" / "no X named Y found" = já foi deletado → sucesso
        if (errText.toLowerCase().includes('not found') || errText.toLowerCase().includes('does not exist') || errText.match(/no \w+ named .+ found/i)) {
          // Limpar do deploy_log para não aparecer em rollbacks futuros
          try { await pool.query('DELETE FROM deploy_log WHERE component = $1', [deleteName]); } catch {}
          try { await pool.query('DELETE FROM deploy_log WHERE component = $1', [fname]); } catch {}
          return { ok: true, message: `ℹ️ ${mtype} ${deleteName} já não existe — removido do histórico`, alreadyExists: true };
        }
        // Se campo referenciado por VR/Flow/etc → tentar deletar a referência primeiro
        if (mtype === 'CustomField' && errText.includes('referenced elsewhere')) {
          const refMatch = errText.match(/(?:Validation Rule|Flow|Trigger)\s*[-–]\s*([A-Za-z0-9_]+)/i);
          if (refMatch) {
            const refName = refMatch[1];
            const objName = deleteName.includes('.') ? deleteName.split('.')[0] : '';
            // Tentar deletar VR que referencia este campo
            try {
              const vrFullName = objName ? objName + '.' + refName : refName;
              await sfMulti.metadataDelete(org, 'ValidationRule', vrFullName);
              await new Promise(r => setTimeout(r, 2000));
              // Retry delete do campo
              const retryResult = await sfMulti.metadataDelete(org, mtype, deleteName);
              const retryItem = Array.isArray(retryResult) ? retryResult[0] : retryResult;
              if (retryItem?.success !== false) {
                return { ok: true, message: `✅ VR ${refName} auto-removida → ${mtype} deletado: ${deleteName}` };
              }
            } catch {}
          }
        }
        return { ok: false, message: `❌ Erro ao deletar ${mtype} ${deleteName}: ${errText}` };
      }
      // Limpar do deploy_log após delete bem-sucedido
      try { await pool.query('DELETE FROM deploy_log WHERE component = $1', [deleteName]); } catch {}
      try { if (deleteName !== fname) await pool.query('DELETE FROM deploy_log WHERE component = $1', [fname]); } catch {}
      return { ok: true, message: `✅ ${mtype} deletado: ${deleteName}` };
    } catch (e) { return { ok: false, message: `❌ ${e.message}` }; }
  }
  if (step.action === 'rollback-restore') {
    // Restaura um componente ao estado anterior (snapshot)
    const { type, fullName, snapshot } = step;
    if (!type || !fullName || !snapshot) return { ok: false, message: `ℹ️ Restauração ignorada: ${fullName || 'componente desconhecido'} — sem snapshot completo` };
    try {
      const prev = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
      // Dependendo do tipo, fazer metadataUpdate com o snapshot
      if (prev.fullName || prev.name) {
        await sfMulti.metadataUpdate(org, type, prev.fullName ? prev : { fullName, ...prev });
        return { ok: true, message: `⏪ ${type} ${fullName} restaurado à versão anterior` };
      }
      return { ok: true, message: `ℹ️ ${type} ${fullName} — snapshot sem dados restauráveis, prosseguindo` };
    } catch (e) {
      return { ok: false, message: `⚠️ Erro ao restaurar ${fullName}: ${(e.message || String(e)).substring(0, 200)}` };
    }
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
  // === Grupo 2 — handlers novos (ADITIVO) ===
  if (step.action === 'layout-add-field') {
    const { layoutName, fieldName, sectionLabel, behavior } = step;
    if (!layoutName || !fieldName || !sectionLabel) return { ok: false, message: '❌ layout-add-field requer layoutName, fieldName, sectionLabel' };
    try {
      const r = await sfMulti.addFieldToLayout(org, layoutName, fieldName, sectionLabel, behavior || 'Edit');
      if (r.status === 'exists') return { ok: true, alreadyExists: true, message: `ℹ️ Campo ${fieldName} já está em ${sectionLabel}` };
      if (r.status === 'success') return { ok: true, message: `✅ Campo ${fieldName} adicionado a ${sectionLabel} no layout ${layoutName}` };
      return { ok: false, message: `❌ ${r.message}` };
    } catch (e) { return { ok: false, message: `❌ Layout: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'profile-fls') {
    const { profileName, fieldPermissions, objectPermissions } = step;
    if (!profileName) return { ok: false, message: '❌ profile-fls requer profileName' };
    try {
      let previousState = null;
      try {
        const conn = org.connection;
        const existing = await conn.metadata.read('Profile', profileName);
        previousState = JSON.stringify({ type: 'Profile', name: profileName, fieldPermissions: existing.fieldPermissions, objectPermissions: existing.objectPermissions });
      } catch {}
      const r = await sfMulti.updateProfileFLS(org, profileName, fieldPermissions || [], objectPermissions || []);
      if (r.status === 'success') return { ok: true, message: `✅ Profile ${profileName} atualizado (${r.fieldsUpdated} FLS, ${r.objectsUpdated} objects)`, previousState };
      return { ok: false, message: `❌ ${r.message}` };
    } catch (e) { return { ok: false, message: `❌ Profile: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'activate-rule') {
    const { ruleType, ruleName } = step;
    if (!ruleType || !ruleName) return { ok: false, message: '❌ activate-rule requer ruleType e ruleName' };
    try {
      const r = await sfMulti.activateRule(org, ruleType, ruleName);
      if (r.status === 'success') return { ok: true, message: `✅ ${ruleType} ${ruleName} ativada` };
      return { ok: false, message: `❌ ${r.message}` };
    } catch (e) { return { ok: false, message: `❌ Ativação: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'create-layout') {
    // Cria um Page Layout do zero com seções e campos. Auto-converte formato simplificado em Metadata API XML.
    // Aceita: { object, layoutName, sections:[{label, columns:[[{field, behavior, required?}]]}], relatedLists?, summaryLayout? }
    const objName = step.object;
    const layoutName = step.layoutName || step.name;
    if (!objName || !layoutName) return { ok: false, message: '❌ create-layout requer object e layoutName' };
    try {
      const fullName = `${objName}-${layoutName}`;
      // Verificar se já existe
      let exists = false;
      try {
        const check = await sfMulti.metadataRead(org, 'Layout', fullName);
        if (check && check.fullName) exists = true;
      } catch {}
      // Montar layoutSections
      const layoutSections = (step.sections || []).map((sec, idx) => {
        const cols = sec.columns || [[]];
        return {
          label: sec.label,
          editHeading: sec.editHeading !== false,
          detailHeading: sec.detailHeading !== false,
          style: sec.style || (cols.length === 1 ? 'OneColumn' : 'TwoColumnsTopToBottom'),
          layoutColumns: cols.map(col => ({
            layoutItems: (col || []).map(item => {
              if (typeof item === 'string') return { field: item, behavior: 'Edit' };
              return {
                field: item.field,
                behavior: item.behavior || (item.required ? 'Required' : (item.readOnly ? 'Readonly' : 'Edit'))
              };
            })
          }))
        };
      });
      const body = {
        fullName,
        layoutSections
      };
      // showInheritedRelatedLists só é válido em objetos filhos (não no objeto base) — só incluir se explicitamente pedido
      if (step.showInheritedRelatedLists === true) body.showInheritedRelatedLists = true;
      // Related Lists opcionais
      if (Array.isArray(step.relatedLists) && step.relatedLists.length) {
        body.relatedLists = step.relatedLists.map(rl => {
          if (typeof rl === 'string') return { relatedList: rl, fields: [] };
          return { relatedList: rl.relatedList || rl.name, fields: rl.fields || [], sortField: rl.sortField, sortOrder: rl.sortOrder };
        });
      }
      // Summary Layout (compact layout dentro do page layout)
      if (step.summaryLayout) body.summaryLayout = step.summaryLayout;
      // Multiline layout fields
      if (step.multilineLayoutFields) body.multilineLayoutFields = step.multilineLayoutFields;
      const result = exists
        ? await sfMulti.metadataUpdate(org, 'Layout', body)
        : await sfMulti.metadataCreate(org, 'Layout', body);
      const item = Array.isArray(result) ? result[0] : result;
      const ok = item?.success !== false;
      if (ok) return { ok: true, message: `✅ Page Layout ${exists ? 'atualizado' : 'criado'}: ${fullName} (${layoutSections.length} seções)`, alreadyExists: exists };
      const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
      return { ok: false, message: `❌ Erro Layout: ${errs.map(e=>e.message||JSON.stringify(e)).join(', ')}` };
    } catch (e) { return { ok: false, message: `❌ create-layout: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'assign-layout') {
    // Atribui Page Layout a um Profile + RecordType
    const { profileName, layoutName, recordType } = step;
    if (!profileName || !layoutName) return { ok: false, message: '❌ assign-layout requer profileName e layoutName' };
    try {
      const profile = await sfMulti.metadataRead(org, 'Profile', profileName);
      if (!profile || !profile.fullName) return { ok: false, message: '❌ Profile não encontrado: ' + profileName };
      let assignments = profile.layoutAssignments || [];
      if (!Array.isArray(assignments)) assignments = [assignments].filter(Boolean);
      // Remove existing assignment for same recordType (or no RT)
      assignments = assignments.filter(a => a.recordType !== recordType);
      assignments.push({ layout: layoutName, recordType: recordType || undefined });
      profile.layoutAssignments = assignments;
      const result = await sfMulti.metadataUpdate(org, 'Profile', profile);
      const item = Array.isArray(result) ? result[0] : result;
      const ok = item?.success !== false;
      if (ok) return { ok: true, message: `✅ Layout ${layoutName} atribuído ao Profile ${profileName}${recordType ? ' (RT: '+recordType+')' : ''}` };
      const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
      return { ok: false, message: `❌ Erro: ${errs.map(e=>e.message||JSON.stringify(e)).join(', ')}` };
    } catch (e) { return { ok: false, message: `❌ assign-layout: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'ps-fls') {
    // FLS para PermissionSet (diferente do profile-fls que atua em Profile)
    // Aceita: { permissionSetName, fieldPermissions:[{field:"Object.Field__c", editable, readable}], objectPermissions?:[{object, allowCreate, allowRead, allowEdit, allowDelete, viewAllRecords?, modifyAllRecords?}] }
    const { permissionSetName, fieldPermissions, objectPermissions } = step;
    if (!permissionSetName) return { ok: false, message: '❌ ps-fls requer permissionSetName' };
    const fps = Array.isArray(fieldPermissions) ? fieldPermissions : [];
    const ops = Array.isArray(objectPermissions) ? objectPermissions : [];
    if (!fps.length && !ops.length) return { ok: false, message: '❌ ps-fls requer fieldPermissions[] ou objectPermissions[]' };
    try {
      const ps = await sfMulti.metadataRead(org, 'PermissionSet', permissionSetName);
      if (!ps || !ps.fullName) return { ok: false, message: '❌ PermissionSet não encontrado: ' + permissionSetName };
      // Snapshot rollback
      let previousState = null;
      try { previousState = JSON.stringify({ type: 'PermissionSet', name: permissionSetName, fieldPermissions: ps.fieldPermissions, objectPermissions: ps.objectPermissions }); } catch {}
      // Merge FLS
      let existingFP = ps.fieldPermissions || [];
      if (!Array.isArray(existingFP)) existingFP = [existingFP].filter(Boolean);
      const fpMap = new Map(existingFP.map(fp => [fp.field, fp]));
      for (const fp of fps) {
        fpMap.set(fp.field, { field: fp.field, editable: !!fp.editable, readable: fp.readable !== false });
      }
      ps.fieldPermissions = Array.from(fpMap.values());
      // Merge Object Perms
      if (ops.length) {
        let existingOP = ps.objectPermissions || [];
        if (!Array.isArray(existingOP)) existingOP = [existingOP].filter(Boolean);
        const opMap = new Map(existingOP.map(op => [op.object, op]));
        for (const op of ops) {
          opMap.set(op.object, op);
        }
        ps.objectPermissions = Array.from(opMap.values());
      }
      const result = await sfMulti.metadataUpdate(org, 'PermissionSet', ps);
      const item = Array.isArray(result) ? result[0] : result;
      const ok = item?.success !== false;
      if (ok) return { ok: true, message: `✅ PS ${permissionSetName}: ${fps.length} FLS + ${ops.length} object perms aplicados`, previousState };
      const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
      return { ok: false, message: `❌ Erro: ${errs.map(e=>e.message||JSON.stringify(e)).join(', ')}` };
    } catch (e) { return { ok: false, message: `❌ ps-fls: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'assign-ps-to-user') {
    // Atribui PermissionSet a usuários via PermissionSetAssignment SObject
    // Aceita: { permissionSetName, users: ["email1@x.com","email2@x.com"] OU userIds: ["005..."] OU usernamePattern: "*@backoffice.com" }
    const { permissionSetName, users, userIds, usernamePattern } = step;
    if (!permissionSetName) return { ok: false, message: '❌ assign-ps-to-user requer permissionSetName' };
    try {
      const conn = await (await import('../services/sf-multi.js')).default ? null : null;
      // Usar runSoql + composite via sfMulti
      // Buscar Id do PermissionSet
      const psQuery = await sfMulti.runSoql(org, `SELECT Id FROM PermissionSet WHERE Name = '${permissionSetName.replace(/'/g,"\\'")}' LIMIT 1`);
      if (psQuery.error) return { ok: false, message: '❌ Erro buscando PS: ' + psQuery.error };
      if (!psQuery.records || !psQuery.records.length) return { ok: false, message: '❌ PermissionSet não encontrado: ' + permissionSetName };
      const psId = psQuery.records[0].Id;
      // Resolver UserIds
      let resolvedIds = [];
      if (Array.isArray(userIds) && userIds.length) {
        resolvedIds = userIds.slice();
      } else if (Array.isArray(users) && users.length) {
        const emails = users.map(u => "'" + u.replace(/'/g, "\\'") + "'").join(',');
        const uq = await sfMulti.runSoql(org, `SELECT Id, Username FROM User WHERE Username IN (${emails}) AND IsActive = true`);
        if (uq.error) return { ok: false, message: '❌ Erro buscando users: ' + uq.error };
        resolvedIds = (uq.records || []).map(u => u.Id);
        if (!resolvedIds.length) return { ok: false, message: '❌ Nenhum usuário ativo encontrado para: ' + users.join(', ') };
      } else if (usernamePattern) {
        // LIKE pattern
        const pat = usernamePattern.replace(/\*/g,'%').replace(/'/g,"\\'");
        const uq = await sfMulti.runSoql(org, `SELECT Id FROM User WHERE Username LIKE '${pat}' AND IsActive = true`);
        if (uq.error) return { ok: false, message: '❌ Erro pattern: ' + uq.error };
        resolvedIds = (uq.records || []).map(u => u.Id);
        if (!resolvedIds.length) return { ok: false, message: '❌ Nenhum usuário ativo casa com pattern: ' + usernamePattern };
      } else {
        return { ok: false, message: '❌ Forneça users[] OU userIds[] OU usernamePattern' };
      }
      // Verificar quais já têm o PS (não duplicar)
      const idsList = resolvedIds.map(i => "'" + i + "'").join(',');
      const existing = await sfMulti.runSoql(org, `SELECT AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = '${psId}' AND AssigneeId IN (${idsList})`);
      const alreadyAssigned = new Set((existing.records || []).map(r => r.AssigneeId));
      const toAssign = resolvedIds.filter(uid => !alreadyAssigned.has(uid));
      if (!toAssign.length) return { ok: true, message: `ℹ️ Todos os ${resolvedIds.length} usuários já têm o PS ${permissionSetName} — prosseguindo`, alreadyExists: true };
      // Criar PermissionSetAssignment para cada
      const records = toAssign.map(uid => ({ attributes: { type: 'PermissionSetAssignment' }, PermissionSetId: psId, AssigneeId: uid }));
      const insertResult = await sfMulti.insertRecords(org, 'PermissionSetAssignment', records.map(r => ({ PermissionSetId: r.PermissionSetId, AssigneeId: r.AssigneeId })));
      const successCount = (insertResult.results || []).filter(r => r.success !== false).length;
      const errors = (insertResult.results || []).filter(r => r.success === false);
      if (errors.length === 0) {
        return { ok: true, message: `✅ ${successCount} usuário(s) recebeu(ram) o PS ${permissionSetName} (${alreadyAssigned.size} já tinha(m))` };
      }
      return { ok: false, message: `⚠️ ${successCount} OK, ${errors.length} falharam: ${errors.slice(0,3).map(e => JSON.stringify(e.errors||e)).join('; ')}` };
    } catch (e) { return { ok: false, message: `❌ assign-ps-to-user: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'enable-field-history') {
    // Ativa Field History Tracking em campos de um objeto
    // Aceita: { object: "Account", fields: ["Phone","Industry","Custom_Field__c"] }
    const { object, fields } = step;
    if (!object) return { ok: false, message: '❌ enable-field-history requer object' };
    const flds = Array.isArray(fields) ? fields : [];
    if (!flds.length) return { ok: false, message: '❌ enable-field-history requer fields[] (lista de API names)' };
    try {
      // 1. Ativar History Tracking no objeto (se não estiver ativo)
      // Para objetos standard, não precisa — já vem com enableHistory; para custom (__c), precisa via metadata.update
      const isCustom = object.endsWith('__c');
      if (isCustom) {
        try {
          const obj = await sfMulti.metadataRead(org, 'CustomObject', object);
          if (obj && obj.fullName && !obj.enableHistory) {
            obj.enableHistory = true;
            await sfMulti.metadataUpdate(org, 'CustomObject', obj);
          }
        } catch {}
      }
      // 2. Ativar trackHistory em cada campo
      const updates = [];
      for (const f of flds) {
        const fullName = `${object}.${f}`;
        try {
          const field = await sfMulti.metadataRead(org, 'CustomField', fullName);
          if (!field || !field.fullName) {
            // Campo standard — usar trackHistory direto via update (jsforce gerencia)
            updates.push({ fullName, trackHistory: true });
          } else {
            field.trackHistory = true;
            updates.push(field);
          }
        } catch {
          updates.push({ fullName, trackHistory: true });
        }
      }
      const result = await sfMulti.metadataUpdate(org, 'CustomField', updates);
      const items = Array.isArray(result) ? result : [result];
      const okCount = items.filter(r => r.success !== false).length;
      const errs = items.filter(r => r.success === false);
      if (errs.length === 0) {
        return { ok: true, message: `✅ Field History ativado em ${okCount}/${flds.length} campos de ${object}: ${flds.join(', ')}` };
      }
      // Se 0 ativados e erro de history tracking não habilitado — objeto standard precisa enable manual antes
      if (okCount === 0 && errs.some(e => JSON.stringify(e).toLowerCase().includes('history tracking enabled'))) {
        return { ok: false, message: `⚠️ Objeto standard '${object}' precisa ter History Tracking habilitado primeiro: Setup → Object Manager → ${object} → Edit → "Track Field History" → Save. Depois rode este step novamente.` };
      }
      return { ok: false, message: `⚠️ ${okCount}/${flds.length} ativados. Erros: ${errs.slice(0,3).map(e => JSON.stringify(e.errors||e)).join('; ')}` };
    } catch (e) { return { ok: false, message: `❌ enable-field-history: ${(e.message || String(e)).substring(0, 300)}` }; }
  }
  if (step.action === 'assign-custom-permission') {
    const { permissionSetName, customPermissions } = step;
    const enabled = step.enabled !== false; // default true
    if (!permissionSetName) return { ok: false, message: '❌ assign-custom-permission requer permissionSetName' };
    const cps = Array.isArray(customPermissions) ? customPermissions : (customPermissions ? [customPermissions] : []);
    if (!cps.length) return { ok: false, message: '❌ assign-custom-permission requer customPermissions (array de nomes)' };
    try {
      // Ler PermissionSet atual via sfMulti (gerencia a conexão)
      const ps = await sfMulti.metadataRead(org, 'PermissionSet', permissionSetName);
      if (!ps || !ps.fullName) return { ok: false, message: '❌ PermissionSet não encontrado: ' + permissionSetName };
      // Snapshot para rollback
      let previousState = null;
      try { previousState = JSON.stringify({ type: 'PermissionSet', name: permissionSetName, customPermissions: ps.customPermissions }); } catch {}
      // Mesclar customPermissions existentes com as novas
      let existing = ps.customPermissions || [];
      if (!Array.isArray(existing)) existing = [existing].filter(Boolean);
      const cpMap = new Map(existing.map(cp => [cp.name, cp]));
      for (const cpName of cps) {
        cpMap.set(cpName, { name: cpName, enabled });
      }
      ps.customPermissions = Array.from(cpMap.values());
      const result = await sfMulti.metadataUpdate(org, 'PermissionSet', ps);
      const item = Array.isArray(result) ? result[0] : result;
      const ok = item?.success !== false;
      if (ok) return { ok: true, message: `✅ ${cps.length} Custom Permission(s) atribuída(s) a ${permissionSetName}: ${cps.join(', ')}`, previousState };
      const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
      return { ok: false, message: `❌ Erro: ${errs.map(e=>e.message||JSON.stringify(e)).join(', ')}` };
    } catch (e) { return { ok: false, message: `❌ assign-custom-permission: ${(e.message || String(e)).substring(0, 300)}` }; }
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

const RUNBOOK_PARSE_PROMPT = `Analise este runbook/spec e extraia as acoes de deployment Salesforce. Responda SOMENTE com um JSON array (sem markdown, sem backticks).

CONVERSAO DIRETA: Se o input contem blocos estruturados com "Step N: action" e parametros como "- action: create-field", "- object: Account", etc., EXTRAIA DIRETAMENTE os valores para JSON sem interpretar. Cada bloco vira um objeto no array.

Exemplo de input estruturado:
#### Step 1: create-field — Campo CNPJ
- action: create-field
- object: Account
- field: CNPJ__c
- label: CNPJ
- type: Text
- length: 18

Converte para: {"action":"create-field","object":"Account","field":"CNPJ__c","label":"CNPJ","type":"Text","length":18}

Se o input NAO for estruturado (texto livre/prosa), interprete e converta usando as regras abaixo.

Ações disponíveis:
- "action": "create-field" — criar campo custom (USE SEMPRE para CustomField. NÃO use metadata-create com type:CustomField)
- "action": "metadata-create" — criar qualquer metadado (CustomObject, CustomField, MatchingRule, DuplicateRule, ValidationRule, RecordType, PermissionSet, PermissionSetGroup, CustomPermission, ListView, CustomTab, BusinessProcess, CompactLayout, CustomLabel, GlobalValueSet, ReportType, CustomMetadata, SharingRules, QuickAction, Group, Queue)
- "action": "layout-add-field" — adiciona campo a uma seção de Page Layout. Requer: { layoutName: "Object-Layout Name", fieldName: "Field__c", sectionLabel: "Identificação", behavior: "Edit"|"Required"|"Readonly" }
- "action": "profile-fls" — atualiza FLS de um Profile. Requer: { profileName: "Profile_Name", fieldPermissions: [{ field: "Object.Field__c", editable: true, readable: true }], objectPermissions: [{ object: "Account", allowCreate: true, allowRead: true, allowEdit: false, allowDelete: false }] }
- "action": "activate-rule" — ativa Matching Rule ou Duplicate Rule (pós-deploy). Requer: { ruleType: "MatchingRule"|"DuplicateRule", ruleName: "Object.RuleName" }
- "action": "assign-custom-permission" — atribui uma ou mais Custom Permissions a um PermissionSet existente (mescla com o que já existe). Requer: { permissionSetName: "PS_Name", customPermissions: ["CP_Name1","CP_Name2"], enabled?: true (default) }
- "action": "create-layout" — cria/atualiza Page Layout com seções e campos. Requer: { object: "Account", layoutName: "MyLayout", sections: [{ label: "Identificação", columns: [[{field:"Name", behavior:"Edit"}, {field:"CNPJ__c", behavior:"Readonly"}], [{field:"Status__c", behavior:"Required"}]] }], relatedLists?: ["ContactList","OpportunityList"] }. Behavior: "Edit"|"Required"|"Readonly". Cada seção tem array de colunas, cada coluna tem array de items.
- "action": "assign-layout" — atribui Page Layout a um Profile (opcionalmente por RecordType). Requer: { profileName: "MyProfile", layoutName: "Account-MyLayout", recordType?: "Account.Cliente_Encarteirado" }
- "action": "ps-fls" — FLS num PermissionSet (DIFERENTE de profile-fls). Requer: { permissionSetName: "PS_Name", fieldPermissions: [{ field: "Account.Campo__c", editable: true, readable: true }], objectPermissions?: [{ object, allowCreate, allowRead, allowEdit, allowDelete }] }
- "action": "assign-ps-to-user" — atribui PermissionSet a um ou mais usuários (via PermissionSetAssignment, sem Apex). Requer: { permissionSetName, users?: ["email1","email2"] OU userIds?: ["005..."] OU usernamePattern?: "*@backoffice.com" }
- "action": "enable-field-history" — ativa Field History Tracking em campos de um objeto. Requer: { object: "Account", fields: ["Phone","Industry","CustomField__c"] }
- "action": "flow" — cria Flow via Metadata API 62.0. Formato { fullName, body: { ... } }
  ⚠️ ATENÇÃO API 62.0: triggerType, recordTriggerType, object DEVEM ficar dentro de start{}, NÃO na raiz do Flow.
  Operadores válidos em FlowComparisonOperator: EqualTo, NotEqualTo, GreaterThan, LessThan, GreaterThanOrEqualTo, LessThanOrEqualTo, StartsWith, EndsWith, Contains, IsNull, WasSet, WasSelected, WasVisited. NÃO existem: DoesNotContain, NotContain, NotEqual, Equals.
  Para "não contém", use Decision com 2 outcomes: um com Contains+true para um lado, outro (default) para o outro.
  Exemplo de Record-Triggered Flow:
  { "action":"flow", "fullName":"Account_Update_On_Insert", "body": { "label":"Account Update", "apiVersion":62.0, "processType":"AutoLaunchedFlow", "status":"Active", "start": { "triggerType":"RecordAfterSave", "recordTriggerType":"Create", "object":"Account", "locationX":50, "locationY":0, "connector":{"targetReference":"updateFields"} }, "recordUpdates": [...] } }

⚠️ REGRAS CRÍTICAS para conversão TEXTO → JSON:
- Se o texto diz "Configurar Page Layout Assignment" ou "matriz Profile x RecordType" ou "atribuir layout X ao profile Y" → use assign-layout (UMA action por combinação Profile+RecordType+Layout)
- Se o texto diz "Criar Page Layout" ou "configurar layout com seções" → use create-layout
- Se o texto diz "Atribuir Custom Permission X ao PS Y" → use assign-custom-permission
- Se o texto diz "Configurar FLS no Profile X" → use profile-fls
- Se o texto diz "Ativar Matching/Duplicate Rule" → use activate-rule
- NUNCA gere manual-step para: layouts, layout assignments, FLS, custom permissions, MR/DR ativação. Sempre tem action automatizada.
- Para layout assignment matriz: expanda em VÁRIOS steps assign-layout (um por combinação)
  Ex: "Atribuir Layout A ao Profile X para RT Y e RT Z, e Layout B ao Profile X para RT Y" gera 3 steps assign-layout
- "action": "metadata-update" — atualizar metadado existente
- "action": "apex-class" — criar Apex Class (gerar código completo)
- "action": "apex-trigger" — criar Apex Trigger (gerar código completo)
- "action": "lwc" — criar Lightning Web Component (gerar bundle)
- "action": "flow" — criar Flow (gerar metadata)
- "action": "apex" — executar Apex anônimo
- "action": "soql" — executar SOQL
- "action": "validate" — validação (query + condition: "empty"|"has-results"|"no-modify-all-data")
- "action": "manual-step" — passo manual (description obrigatória). Use para coisas que não dá pra automatizar via API (ex: importar CSV via Data Loader, configurar em Setup UI).

Para create-field: "object", "field" (__c), "label", "type", "length", "picklist" (array de strings para Picklist/MultiselectPicklist — OBRIGATÓRIO se type=Picklist), "referenceTo" (Lookup), "defaultValue" (obrigatório para Checkbox: true/false). IMPORTANTE: Picklist sem array de valores no campo "picklist" vai FALHAR no deploy. Exemplo correto: {"action":"create-field","object":"Account","field":"Origem__c","label":"Origem","type":"Picklist","picklist":["Manual","SERASA","Neoway"]}
Para metadata-create/update: "type", "body" (JSON exato da Metadata API), "description"

FORMATOS METADATA API OBRIGATÓRIOS:
- MatchingRule: { fullName, label, ruleStatus:"Active", matchingRuleItems:[{fieldName, matchingMethod:"Exact"|"CompanyName"|"FirstName"|"LastName"|"Phone"|"City"|"Street"|"Zip"|"Title"}] }. NÃO usar "Fuzzy" — para fuzzy de empresa usar "CompanyName".
- DuplicateRule: { fullName, masterLabel (NÃO label!), isActive, actionOnInsert:"Block"|"Allow", actionOnUpdate, alertText, duplicateRuleMatchRules:[{matchRuleSObjectType, matchingRule}] }. NÃO incluir sortOrder nem operationsOnInsert (resolvidos automaticamente). NÃO usar objectMapping.
- ValidationRule: { fullName:"Obj.Name", active:true, errorConditionFormula, errorMessage, errorDisplayField }
- RecordType: { fullName:"Obj.Name", label, active:true }
- PermissionSet: { fullName, label, fieldPermissions:[{field,editable,readable}], objectPermissions:[{object,allowCreate,allowRead,allowEdit,allowDelete}], customPermissions:[{name:"CustomPermName",enabled:true}], applicationVisibilities:[{application:"AppName",visible:true}], userPermissions:[{name:"PermName",enabled:true}] }
- CustomObject: { fullName:"MeuObj__c", label:"Meu Objeto", pluralLabel:"Meus Objetos", nameField:{ type:"Text"|"AutoNumber", label:"Name", displayFormat:"OBJ-{0000}" }, deploymentStatus:"Deployed", sharingModel:"ReadWrite"|"Private"|"Read" }
- CustomPermission: { fullName:"MinhaPerm", label:"Minha Permissao", description:"Descricao" }. Usado em VRs via $CustomPermission ou em PSs.
- PermissionSetGroup: { fullName:"PSG_Nome", label, description, permissionSets:["PS_1","PS_2"] }. Agrupa PSs para atribuicao em bloco.
- CustomMetadata: { fullName:"TipoMetadata__mdt.RecordName", label:"Label do Registro", protected:false, values:[{field:"Campo__c",value:{string:"valor"}}] }. Para registros de Custom Metadata Type ja existente. Para criar o TIPO use CustomObject com fullName terminado em __mdt.
- SharingRules: { fullName:"Account.SR_Nome", sharingCriteriaRules:[{fullName:"SR_Nome",label,accessLevel:"Read"|"Edit"|"All",booleanFilter,criteriaItems:[{field:"Status__c",operation:"equals",value:"Ativo"}],sharedTo:{group:"MeuGrupo"}|{role:"MinhaRole"}|{publicGroup:"Grupo"}}] }
- QuickAction: { fullName:"Objeto.MinhaAction", label, type:"Create"|"Update"|"Flow"|"LightningComponent", targetObject:"Account", flowDefinition:"MeuFlow", optionsCreateFeedItem:false }
- Group: { fullName:"MeuPublicGroup", name:"MeuPublicGroup", doesIncludeBosses:true, doesSendEmailToMembers:false }. Public Group para Sharing Rules e Queue.
- Queue: { fullName:"MinhaQueue", name:"MinhaQueue", doesSendEmailToMembers:false, queueRoutingConfig:null, queueMembers:{publicGroups:["GrupoX"],users:["user@example.com"]}, queueSobject:[{sobjectType:"Lead"}] }
- ListView: { fullName:"Obj.ViewName", label, filterScope:"Everything"|"Mine", columns:["Name","CreatedDate","Owner.Alias"], filters:[{field:"Status__c",operation:"equals",value:"Ativo"}] }
- CustomTab: { fullName:"MeuObj__c", customObject:true, motif:"Custom68__Tab" }
- BusinessProcess: { fullName:"Obj.ProcessName", isActive:true, values:[{fullName:"Qualification"},{fullName:"Proposal"},{fullName:"Closed Won"}] }. Obj = Lead|Opportunity|Case.
- CompactLayout: { fullName:"Obj.LayoutName", label, fields:["Name","Phone","Email"] }
- CustomLabel: { fullName:"MeuLabel", value:"Texto do label", language:"pt_BR", protected:false }
- GlobalValueSet: { fullName:"MeuGlobalPicklist", sorted:false, customValue:[{fullName:"Valor1",label:"Valor 1",isActive:true},{fullName:"Valor2",label:"Valor 2",isActive:true}] }
- ReportType: { fullName:"MeuReportType", label, baseObject:"Account", category:"accounts", deployed:true, sections:[{columns:[{checkedByDefault:true,field:"Id",table:"Account"}]}] }

FORMATOS COMPONENTES EXÓTICOS:
- apex-class: { "action":"apex-class", "name":"NomeClasse", "body":"public with sharing class NomeClasse { ... }", "description":"..." }. Inclua test class separada (outro step apex-class com @isTest, cobertura 75%+).
- apex-trigger: { "action":"apex-trigger", "name":"NomeTrigger", "body":"trigger NomeTrigger on Account (...) { ... }", "description":"..." }. Trigger fino + handler class (handler primeiro).
- lwc: { "action":"lwc", "name":"meuComponente", "files": { "html":"...", "js":"...", "meta":"..." }, "description":"..." }. Nome camelCase, classe PascalCase.
- flow: { "action":"flow", "fullName":"Nome_Flow", "body": { "label":"...", "processType":"AutoLaunchedFlow"|"Flow", "status":"Active", ... }, "description":"..." }.

REGRAS:
- Ordene por dependência: campos antes de Apex; handler class antes do trigger; Matching Rules antes de Duplicate Rules; objetos pai antes de filhos.
- Para passos que NÃO são automatizáveis via Metadata API (importar dados CSV, configurar Lead Convert Settings, ativar features), use "manual-step" com description clara.
Se o campo não tem __c, adicione. Converta nomes para API format.`;

async function parseRunbookJob(jobId, input, org, us) {
  const parsedResult = await claude.callRouted('runbook-parse', RUNBOOK_PARSE_PROMPT, [{ role: 'user', content: input }], 8192);
  const parsed = parsedResult.text;
  const cleanParsed = parsed.replace(/```json\n?|```\n?/g, '').trim();
  let steps = JSON.parse(cleanParsed);
  if (!Array.isArray(steps)) steps = [steps];

  // Monta o plano (preview markdown) + payload base64
  let orgUrl = '';
  try { const c = await sfMulti.testConnection(org); orgUrl = c.instanceUrl || ''; } catch {}
  const orgLink = orgUrl ? orgUrl.replace('https://', '') : org.username;

  let preview = `## Runbook — ${steps.length} passos\n\n`;
  if (us) preview += `**US:** ${us}\n`;
  preview += `**Org:** [${orgLink}](${orgUrl})\n`;
  preview += `**Gerado por:** ${parsedResult.model.includes('opus') ? 'Claude Opus 4.6' : parsedResult.model}\n\n`;
  preview += `| # | Ação | Componente | Detalhes |\n|---|---|---|---|\n`;
  steps.forEach((s, i) => {
    const comp = extractComponent(s);
    const det = (s.description || s.type || '').substring(0, 60);
    preview += `| ${i + 1} | ${s.action} | ${comp} | ${det} |\n`;
  });
  preview += `\n**Confirme para iniciar a execução passo a passo.**`;

  const payload = Buffer.from(JSON.stringify({ steps, currentStep: 0, us })).toString('base64');

  await pool.query(
    'UPDATE jobs SET status = $1, result = $2, meta = meta || $3, updated_at = NOW() WHERE id = $4',
    ['done', preview, JSON.stringify({ model: parsedResult.model, confirmAction: 'runbook', confirmPayload: payload }), jobId]
  );
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
  const result = await claude.callRouted('spec', fullSystem, [{ role: 'user', content: hf }], 32000);
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
        `| \`/relatorio [US]\` | Relatório completo do deploy (download .docx) |\n` +
        `| \`/promover [US]\` | Guia de promoção ORG ARQUITETURA → Dev/Prod (Change Set + SFDX) |\n` +
        `| \`/bugfix [US] [descrição]\` | Diagnóstico + runbook corretivo pós-deploy |\n` +
        `| \`/checklist [US]\` | Configurações manuais pós-deploy da US (Seção 19 da spec) |\n` +
        `| \`/log [US]\` | Histórico de deploys (auditoria) |\n` +
        `| \`/rollback [US]\` | Lista componentes e permite desfazer (delete) |\n` +
        `| \`/status\` | Status da conexão |\n` +
        `| \`/help\` | Este menu |\n\n` +
        `**Runbook suporta:** CustomObject, CustomField, MatchingRule, DuplicateRule, ValidationRule, RecordType, PermissionSet (com customPermissions), PermissionSetGroup, CustomPermission, ListView, CustomTab, BusinessProcess, CompactLayout, CustomLabel, GlobalValueSet, ReportType, CustomMetadata, SharingRules, QuickAction, Group, Queue, Page Layout (create + add field + assign), Profile FLS, Activate MR/DR, Assign Custom Permission to PS, Apex Class, Apex Trigger, LWC, Flow.\n\n` +
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
- Se Picklist, extraia os valores em picklist como array de strings (formato canônico)
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
        if (['Picklist','MultiselectPicklist'].includes(body.type)) { body.picklist = spec.picklist || spec.picklistValues || spec.values; }
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

        // ── /scriptApex — gera script Apex para execução anônima na org ──
    if (lower.startsWith('/scriptapex')) {
      const desc = userMsg.trim().substring(11).trim();
      if (!desc) return res.json({ choices: [{ message: { content: '⚠️ Descreva o que precisa em linguagem natural após /scriptApex.\n\nExemplo: `/scriptApex consultar Leads com Status Qualified e atualizar Rating para Hot`' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });

      try {
        const scriptPrompt = `Você é um especialista Salesforce Apex. Gere um script para EXECUÇÃO ANÔNIMA (Developer Console → Execute Anonymous).

REGRAS OBRIGATÓRIAS:
- NÃO use "public class", "private", "static" — é execução anônima, código direto
- SEMPRE envolva em try/catch com System.debug do erro
- SEMPRE adicione System.debug para feedback (contagens, resultados)
- Respeite governor limits: use LIMIT quando fizer SELECT, bulkifique DML
- Para updates/deletes grandes (>200 registros), use Database.update com allOrNone=false
- Adicione comentários explicativos em português
- Formate o código limpo e legível
- Se o script precisar de dados específicos (IDs, valores), use variáveis no topo para fácil customização
- Para queries grandes, mostre o total encontrado antes de executar
- NÃO execute DML destrutivo (delete) sem confirmação via debug primeiro — gere uma versão "dry run" que só mostra o que seria afetado, e comente a linha de DML para o usuário descomentar

FORMATO DA RESPOSTA:
1. Breve descrição do que o script faz (1-2 linhas)
2. O código Apex em bloco \`\`\`apex
3. Instruções de uso (onde colar, o que verificar no debug log)`;

        const result = await claude.callRouted('apex-gen', scriptPrompt, [{ role: 'user', content: desc }], 4096);
        const response = result.text;
        const modelLabel = result.model.includes('opus') ? 'Claude Opus 4.6' : result.model;

        return res.json({
          choices: [{ message: { content: response } }],
          modelo_usado: result.model,
          modelo_label: modelLabel,
          tipo: 'script',
          copyable: true
        });
      } catch (e) {
        return res.json({ choices: [{ message: { content: `❌ Erro: ${e.message}` } }], modelo_usado: 'local', modelo_label: 'Erro', tipo: 'error' });
      }
    }

        // ── /spec-adjust — refina spec existente com Opus ──
    if (lower.startsWith('/spec-adjust')) {
      const input = userMsg.trim().substring(12).trim();
      // Formato: JOB_ID: texto do ajuste
      const match = input.match(/^(\d+):\s*(.+)/s);
      if (!match) return res.json({ choices: [{ message: { content: '⚠️ Formato inválido. Use o botão "✏️ Ajustar Spec" após gerar uma spec.' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });

      const origJobId = parseInt(match[1]);
      const adjustment = match[2].trim();

      try {
        // Ler spec original do banco
        const origJob = await pool.query('SELECT result, meta FROM jobs WHERE id = $1', [origJobId]);
        if (!origJob.rows.length || !origJob.rows[0].result) {
          return res.json({ choices: [{ message: { content: '❌ Spec original não encontrada (job ' + origJobId + ').' } }], modelo_usado: 'local', modelo_label: 'Erro', tipo: 'error' });
        }
        const origSpec = origJob.rows[0].result;
        const origMeta = origJob.rows[0].meta || {};

        // Job assíncrono
        const jobRes = await pool.query(
          'INSERT INTO jobs (user_id, kind, status, input, meta) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [req.user.id, 'spec', 'processing', adjustment, JSON.stringify({ ...origMeta, origJobId, adjustment: true })]
        );
        const jobId = jobRes.rows[0].id;

        // Background: Opus aplica ajuste
        (async () => {
          try {
            const adjustPrompt = 'Você é um arquiteto Salesforce. Recebeu uma especificação técnica completa e um pedido de ajuste do revisor.\n\n' +
              'REGRAS:\n' +
              '- Aplique EXATAMENTE o ajuste solicitado na spec\n' +
              '- Mantenha TODAS as seções e estrutura original\n' +
              '- Só modifique o que foi pedido — não altere seções não afetadas\n' +
              '- Se o ajuste impactar o Runbook (seção 18), atualize-o também\n' +
              '- Se o ajuste impactar a Seção 19 (Pós-Deploy), atualize-a também\n' +
              '- Retorne a spec COMPLETA atualizada (todas as seções)\n' +
              '- Adicione no topo: "⚡ SPEC AJUSTADA — v' + (origMeta.version ? (parseFloat(origMeta.version) + 0.1).toFixed(1) : '1.1') + '"\n' +
              '- Marque as seções alteradas com [AJUSTADO] no título\n' +
              '- Português do Brasil';

            const result = await claude.callRouted('spec', adjustPrompt,
              [{ role: 'user', content: '--- SPEC ORIGINAL ---\n\n' + origSpec + '\n\n--- AJUSTE SOLICITADO ---\n\n' + adjustment }],
              16384
            );

            await pool.query(
              'UPDATE jobs SET status = $1, result = $2, meta = meta || $3, updated_at = NOW() WHERE id = $4',
              ['done', result.text, JSON.stringify({ model: result.model, version: origMeta.version ? (parseFloat(origMeta.version) + 0.1).toFixed(1) : '1.1' }), jobId]
            );
          } catch (e) {
            await pool.query('UPDATE jobs SET status = $1, error = $2, updated_at = NOW() WHERE id = $3', ['error', e.message, jobId]).catch(() => {});
          }
        })();

        return res.json({
          choices: [{ message: { content: '⏳ **Ajustando spec com Claude Opus 4.6...**\n\n' +
            'O Opus está aplicando seu ajuste na spec original. Aguarde (~30-60s).\n\n' +
            '**Ajuste:** ' + adjustment.substring(0, 200) } }],
          modelo_usado: 'job',
          modelo_label: 'Opus 4.6 (ajustando)',
          tipo: 'job-started',
          jobId
        });
      } catch (e) {
        return res.json({ choices: [{ message: { content: '❌ Erro: ' + e.message } }], modelo_usado: 'local', modelo_label: 'Erro', tipo: 'error' });
      }
    }

    // ── /bugfix — diagnóstico + runbook corretivo pós-deploy ──
    if (lower.startsWith('/bugfix')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const input = userMsg.trim().substring(7).trim();
      if (!input) return res.json({ choices: [{ message: { content: '⚠️ Use: `/bugfix CRMB2B-90 A Duplicate Rule não está bloqueando via API`\n\nDescreva a US + o problema encontrado. O Opus analisa a spec original + deploy log + sua descrição e gera um runbook corretivo.' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });

      // Extrair US
      const usMatch = input.match(/\b([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\b/i);
      const us = usMatch ? usMatch[1].toUpperCase() : null;
      const bugDesc = us ? input.substring(usMatch.index + usMatch[0].length).trim() : input;

      try {
        // 1. Buscar spec original
        let specContext = 'Nenhuma spec encontrada para esta US.';
        if (us) {
          const specQuery = await pool.query(
            "SELECT result FROM jobs WHERE kind = 'spec' AND status = 'done' AND (input ILIKE $1 OR result ILIKE $1 OR meta::text ILIKE $1) ORDER BY id DESC LIMIT 1",
            ['%' + us + '%']
          );
          if (specQuery.rows.length) {
            const specText = specQuery.rows[0].result;
            // Pegar resumo da spec (primeiros 3000 chars + seção de runbook)
            const runbookMatch = specText.match(/##\s*18[\s\S]{0,3000}/);
            specContext = specText.substring(0, 3000) + (runbookMatch ? '\n\n[...]\n\n' + runbookMatch[0] : '');
          }
        }

        // 2. Buscar deploy_log
        let deployContext = 'Nenhum deploy registrado para esta US.';
        if (us) {
          const logQuery = await pool.query(
            "SELECT component, action, result, result_message, created_at FROM deploy_log WHERE us_number ILIKE $1 ORDER BY created_at DESC LIMIT 30",
            ['%' + us + '%']
          );
          if (logQuery.rows.length) {
            deployContext = logQuery.rows.map(r =>
              r.created_at.toISOString().substring(0,16) + ' | ' + r.result + ' | ' + r.action + ' | ' + r.component + (r.result_message ? ' — ' + r.result_message.substring(0, 80) : '')
            ).join('\n');
          }
        }

        // 3. Enviar tudo pro Opus como job assíncrono
        const bugfixPrompt = 'Você é um arquiteto Salesforce especialista em troubleshooting pós-deploy.\n\n' +
          'Analise o bug reportado com base na spec original e no log de deploy.\n\n' +
          'RESPONDA COM:\n\n' +
          '## 1. Diagnóstico\n' +
          'O que a spec pedia vs o que foi deployado vs o que o usuário reportou.\n\n' +
          '## 2. Causa Raiz\n' +
          'Classifique: Gap de Spec | Gap de Desenvolvimento | Gap Funcional | Bug de Código\n\n' +
          '## 3. Runbook Corretivo\n' +
          'JSON array com steps para corrigir (mesmo formato do runbook normal).\n' +
          'Actions: create-field, metadata-create, metadata-update, metadata-delete, apex-class, apex-trigger, ' +
          'layout-add-field, profile-fls, activate-rule, validate, soql, manual-step\n\n' +
          'O JSON DEVE estar em bloco:\n```json\n[...]\n```\n\n' +
          '## 4. Recomendações\n' +
          'Ações preventivas para evitar o mesmo tipo de problema.\n\n' +
          'Seja direto. Português do Brasil.';

        const userContent = 'US: ' + (us || 'N/A') + '\n\n' +
          '--- BUG REPORTADO ---\n' + bugDesc + '\n\n' +
          '--- SPEC ORIGINAL (resumo) ---\n' + specContext + '\n\n' +
          '--- DEPLOY LOG ---\n' + deployContext;

        // Job assíncrono (Opus pode demorar)
        const jobRes = await pool.query(
          'INSERT INTO jobs (user_id, kind, status, input, meta) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [req.user.id, 'bugfix', 'processing', bugDesc, JSON.stringify({ us, orgId: org.id, orgName: org.name })]
        );
        const jobId = jobRes.rows[0].id;

        // Process in background
        (async () => {
          try {
            const result = await claude.callRouted('spec', bugfixPrompt, [{ role: 'user', content: userContent }], 8192);
            await pool.query(
              'UPDATE jobs SET status = $1, result = $2, meta = meta || $3, updated_at = NOW() WHERE id = $4',
              ['done', result.text, JSON.stringify({ model: result.model }), jobId]
            );
          } catch (e) {
            await pool.query(
              'UPDATE jobs SET status = $1, error = $2, updated_at = NOW() WHERE id = $3',
              ['error', e.message, jobId]
            ).catch(() => {});
          }
        })();

        return res.json({
          choices: [{ message: { content: '⏳ **Analisando bug com Claude Opus 4.6...**\n\n' +
            'O Opus está cruzando a spec original + deploy log + seu relato para gerar o diagnóstico e runbook corretivo. Aguarde (~30-60s).' +
            (us ? '\n\n**US:** ' + us : '') +
            '\n**Bug:** ' + bugDesc.substring(0, 200) } }],
          modelo_usado: 'job',
          modelo_label: 'Opus 4.6 (processando)',
          tipo: 'job-started',
          jobId,
          jobKind: 'bugfix'
        });
      } catch (e) {
        return res.json({ choices: [{ message: { content: '❌ Erro: ' + e.message } }], modelo_usado: 'local', modelo_label: 'Erro', tipo: 'error' });
      }
    }

    // ── /relatorio — relatório final do deploy de uma US ──
    if (lower.startsWith('/relatorio') || lower.startsWith('/relatório')) {
      const us = userMsg.trim().replace(/^\/relat[óo]rio/, '').trim();
      if (!us) return res.json({ choices: [{ message: { content: '⚠️ Use: `/relatorio US-XXX`\n\nGera relatório completo do que foi deployado para a US (auditoria + snapshots + steps manuais + erros).' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });
      try {
        // Buscar tudo do deploy_log da US
        const logQuery = await pool.query(
          'SELECT us_number, component, action, description, result, result_message, previous_state, created_at FROM deploy_log WHERE us_number ILIKE $1 ORDER BY created_at ASC',
          ['%' + us + '%']
        );
        if (!logQuery.rows.length) {
          return res.json({ choices: [{ message: { content: `⚠️ Nenhum registro de deploy encontrado para ${us}.` } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });
        }
        const rows = logQuery.rows;
        const succeeded = rows.filter(r => r.result === 'success').length;
        const failed = rows.filter(r => r.result === 'error').length;
        const existed = rows.filter(r => r.result === 'exists').length;
        const manuals = rows.filter(r => r.action === 'manual-step').length;

        const firstTime = rows[0].created_at;
        const lastTime = rows[rows.length - 1].created_at;
        const durationMin = Math.round((new Date(lastTime) - new Date(firstTime)) / 60000);

        // Agrupar por tipo de componente
        const byType = {};
        for (const r of rows) {
          const type = r.action || 'outro';
          if (!byType[type]) byType[type] = [];
          byType[type].push(r);
        }

        let report = `# 📋 Relatório de Implementação — ${us}\n\n`;
        report += `**Org:** ${org ? org.name : 'N/A'}\n`;
        report += `**Início:** ${new Date(firstTime).toLocaleString('pt-BR')}\n`;
        report += `**Conclusão:** ${new Date(lastTime).toLocaleString('pt-BR')}\n`;
        report += `**Duração:** ${durationMin} minuto(s)\n\n`;
        report += `## 📊 Resumo\n\n`;
        report += `| Métrica | Quantidade |\n|---|---|\n`;
        report += `| Total de passos | ${rows.length} |\n`;
        report += `| ✅ Sucesso | ${succeeded} |\n`;
        report += `| ℹ️ Já existia | ${existed} |\n`;
        report += `| ❌ Erro | ${failed} |\n`;
        report += `| ⚠️ Passos manuais | ${manuals} |\n\n`;

        report += `## 🛠️ Componentes Deployados por Tipo\n\n`;
        for (const type of Object.keys(byType).sort()) {
          report += `### ${type} (${byType[type].length})\n\n`;
          report += `| Componente | Status | Mensagem |\n|---|---|---|\n`;
          for (const r of byType[type]) {
            const icon = r.result === 'success' ? '✅' : (r.result === 'exists' ? 'ℹ️' : (r.result === 'error' ? '❌' : '⚠️'));
            const msg = (r.result_message || r.description || '').substring(0, 80).replace(/\|/g,'│').replace(/\n/g,' ');
            report += `| ${r.component} | ${icon} | ${msg} |\n`;
          }
          report += `\n`;
        }

        if (failed > 0) {
          report += `## ❌ Erros Encontrados\n\n`;
          for (const r of rows.filter(x => x.result === 'error')) {
            report += `### ${r.component} (${r.action})\n`;
            report += `- **Quando:** ${new Date(r.created_at).toLocaleString('pt-BR')}\n`;
            report += `- **Erro:** ${(r.result_message || 'N/A').substring(0, 300)}\n\n`;
          }
        }

        const hasSnapshots = rows.filter(r => r.previous_state).length;
        report += `## 🔄 Rollback\n\n`;
        report += `${hasSnapshots} componente(s) com snapshot — execute \`/rollback ${us}\` se necessário.\n\n`;

        report += `## ⏭️ Próximos Passos\n\n`;
        report += `1. \`/qa ${us}\` — Smoke test dos componentes deployados\n`;
        report += `2. \`/checklist ${us}\` — Lista de configurações manuais pendentes\n`;
        report += `3. \`/promover ${us}\` — Guia para promover de ORG ARQUITETURA para Dev/Prod\n`;

        return res.json({
          choices: [{ message: { content: report } }],
          modelo_usado: 'local',
          modelo_label: 'Relatório SF Agent',
          tipo: 'spec',
          downloadData: { type: 'spec', title: 'Relatorio_' + us, content: report }
        });
      } catch (e) {
        return res.json({ choices: [{ message: { content: '❌ Erro: ' + e.message } }], modelo_usado: 'local', modelo_label: 'Erro', tipo: 'error' });
      }
    }

    // ── /promover — guia de promoção da US para outra org (ARQ → Dev/Prod) ──
    if (lower.startsWith('/promover')) {
      const us = userMsg.trim().substring(9).trim();
      if (!us) return res.json({ choices: [{ message: { content: '⚠️ Use: `/promover US-XXX`\n\nGera guia de promoção do que foi deployado na ORG ARQUITETURA para outra org (Dev, QA, Prod).' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });
      try {
        const logQuery = await pool.query(
          "SELECT component, action, description, result FROM deploy_log WHERE us_number ILIKE $1 AND result IN ('success','exists') ORDER BY created_at ASC",
          ['%' + us + '%']
        );
        if (!logQuery.rows.length) {
          return res.json({ choices: [{ message: { content: `⚠️ Nenhum deploy bem-sucedido encontrado para ${us}.` } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });
        }
        const rows = logQuery.rows;

        // Agrupar por tipo de metadado SFDX
        const sfdxTypeMap = {
          'create-field': 'CustomField',
          'create-layout': 'Layout',
          'metadata-create': null, // depende do tipo
          'apex-class': 'ApexClass',
          'apex-trigger': 'ApexTrigger',
          'lwc': 'LightningComponentBundle',
          'flow': 'Flow',
          'ps-fls': 'PermissionSet',
          'profile-fls': 'Profile',
          'assign-layout': 'Profile',
          'assign-custom-permission': 'PermissionSet',
          'layout-add-field': 'Layout',
          'activate-rule': null
        };

        const components = {};
        for (const r of rows) {
          if (r.action === 'manual-step' || r.action === 'soql' || r.action === 'validate' || r.action === 'apex' || r.action === 'assign-ps-to-user' || r.action === 'enable-field-history') continue; // data steps, não migração
          let mtype = sfdxTypeMap[r.action];
          if (!mtype && r.action === 'metadata-create') {
            // Extrair tipo da description: "MatchingRule criado: ...", "ValidationRule criado: ..."
            const m = (r.description || '').match(/^(\w+)/);
            if (m) mtype = m[1];
          }
          if (!mtype) mtype = 'Other';
          if (!components[mtype]) components[mtype] = new Set();
          components[mtype].add(r.component);
        }

        let guide = `# 🚀 Guia de Promoção — ${us}\n\n`;
        guide += `**De:** ORG ARQUITETURA (sandbox arqevery)\n`;
        guide += `**Para:** Dev Org / QA / Produção\n`;
        guide += `**Total de componentes:** ${Object.values(components).reduce((a,s) => a+s.size, 0)}\n\n`;

        guide += `## 📦 Componentes a Promover (por tipo)\n\n`;
        for (const t of Object.keys(components).sort()) {
          guide += `### ${t} (${components[t].size})\n\n`;
          for (const c of Array.from(components[t]).sort()) {
            guide += `- \`${c}\`\n`;
          }
          guide += `\n`;
        }

        guide += `## ⚙️ Opção 1 — Change Set (Setup UI, sem código)\n\n`;
        guide += `1. Na ORG ARQUITETURA: **Setup → Outbound Change Sets → New**\n`;
        guide += `2. Adicionar componentes acima\n`;
        guide += `3. Click **Add Profiles** se houver assign-layout/profile-fls\n`;
        guide += `4. Upload para a Dev Org\n`;
        guide += `5. Na Dev Org: **Setup → Inbound Change Sets → Deploy**\n`;
        guide += `6. Após deploy: rodar testes na Dev Org\n\n`;

        guide += `## ⚙️ Opção 2 — SFDX (CLI)\n\n`;
        guide += `\`\`\`bash\n`;
        guide += `# 1. Autorizar as orgs\n`;
        guide += `sf org login web -a ARQ\n`;
        guide += `sf org login web -a DEV\n\n`;
        guide += `# 2. Criar package.xml na pasta src/\n`;
        guide += `cat > package.xml <<EOF\n`;
        guide += `<?xml version="1.0" encoding="UTF-8"?>\n`;
        guide += `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n`;
        for (const t of Object.keys(components).sort()) {
          guide += `  <types>\n`;
          for (const c of Array.from(components[t]).sort()) {
            guide += `    <members>${c}</members>\n`;
          }
          guide += `    <name>${t}</name>\n`;
          guide += `  </types>\n`;
        }
        guide += `  <version>62.0</version>\n`;
        guide += `</Package>\n`;
        guide += `EOF\n\n`;
        guide += `# 3. Recuperar da ORG ARQUITETURA\n`;
        guide += `sf project retrieve start --manifest package.xml --target-org ARQ\n\n`;
        guide += `# 4. Validar deploy na DEV (--dry-run)\n`;
        guide += `sf project deploy validate --manifest package.xml --target-org DEV --test-level RunLocalTests\n\n`;
        guide += `# 5. Deploy real (após validação OK)\n`;
        guide += `sf project deploy start --manifest package.xml --target-org DEV --test-level RunLocalTests\n`;
        guide += `\`\`\`\n\n`;

        guide += `## ✅ Checklist Pré-Promoção\n\n`;
        guide += `- [ ] Rodar \`/qa ${us}\` na ORG ARQUITETURA e validar 100% verde\n`;
        guide += `- [ ] Rodar \`/checklist ${us}\` e completar configs manuais na ORG ARQUITETURA\n`;
        guide += `- [ ] Stakeholders aprovaram o resultado funcional na ORG ARQUITETURA\n`;
        guide += `- [ ] Backup/snapshot da Dev Org (caso de rollback)\n`;
        guide += `- [ ] Janela de manutenção definida\n`;
        guide += `- [ ] Comunicação com squad e PO\n\n`;

        guide += `## ⚠️ Atenção — Componentes que NÃO migram via Change Set/SFDX\n\n`;
        guide += `Os items abaixo precisam ser **recriados manualmente** na org destino:\n\n`;
        guide += `- Atribuição de PS a usuários (\`assign-ps-to-user\`) — usuários da Dev/Prod são diferentes\n`;
        guide += `- Named Credentials com tokens — recriar por questões de segurança\n`;
        guide += `- Dados (registros de Custom Metadata só vão se incluídos no Change Set explicitamente)\n`;
        guide += `- Field History Tracking activation no objeto standard (precisa ser ativado na Setup UI da Dev/Prod)\n\n`;

        guide += `## 🔙 Plano de Rollback na Dev/Prod\n\n`;
        guide += `Se algo der errado após promover:\n`;
        guide += `1. **Quick Deploy do Change Set anterior** (se feito por Change Set, fica disponível por 4 dias)\n`;
        guide += `2. **SFDX**: \`sf project deploy quick --job-id <ID_DO_DEPLOY_ANTERIOR>\` (válido por 10 dias)\n`;
        guide += `3. **Último recurso**: usar o ARQ → desfazer aqui e re-promover\n`;

        return res.json({
          choices: [{ message: { content: guide } }],
          modelo_usado: 'local',
          modelo_label: 'Guia de Promoção',
          tipo: 'spec',
          downloadData: { type: 'spec', title: 'Guia_Promocao_' + us, content: guide }
        });
      } catch (e) {
        return res.json({ choices: [{ message: { content: '❌ Erro: ' + e.message } }], modelo_usado: 'local', modelo_label: 'Erro', tipo: 'error' });
      }
    }

    // ── /checklist — exibe configurações manuais pós-deploy de uma US ──
    if (lower.startsWith('/checklist')) {
      const us = userMsg.trim().substring(10).trim();
      if (!us) return res.json({ choices: [{ message: { content: '⚠️ Use: `/checklist US-XXX`\n\nMostra o checklist de configurações manuais pós-deploy da US (extraído da Seção 19 da spec mais recente da US).' } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });
      try {
        // Buscar última spec da US no banco (kind=spec)
        const specQuery = await pool.query(
          `SELECT id, result FROM jobs WHERE kind = 'spec' AND status = 'done' AND (input ILIKE $1 OR meta::text ILIKE $1) ORDER BY id DESC LIMIT 1`,
          [`%${us}%`]
        );
        if (!specQuery.rows.length) {
          return res.json({ choices: [{ message: { content: `⚠️ Nenhuma spec encontrada para ${us}.\n\nGere a spec primeiro com \`/spec\` + a HF.` } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });
        }
        const spec = specQuery.rows[0].result;
        // Extrair Seção 19
        const sec19Match = spec.match(/##\s*19\.?\s*Configura(ç|c)\u00f5es Manuais P(ó|o)s-Deploy[\s\S]*?(?=\n##\s+[0-9]|\n---|$)/i);
        if (!sec19Match) {
          return res.json({ choices: [{ message: { content: `⚠️ A spec da ${us} não contém a Seção 19 (Configurações Manuais Pós-Deploy).\n\nIsso pode acontecer se a spec foi gerada antes da feature de checklist. Regere com /spec.` } }], modelo_usado: 'local', modelo_label: 'SF Agent', tipo: 'help' });
        }
        return res.json({
          choices: [{ message: { content: `# 📋 Checklist Pós-Deploy — ${us}\n\n${sec19Match[0].replace(/^##\s*19\.?\s*/, '## ')}\n\n---\n\n💡 *Após executar cada item manualmente, marque como concluído nas suas anotações. As ativações automatizáveis (MR/DR, Queue) já podem entrar no runbook via \`activate-rule\` e \`metadata-create\` Group/Queue.*` } }],
          modelo_usado: 'local',
          modelo_label: 'SF Agent',
          tipo: 'checklist'
        });
      } catch (e) {
        return res.json({ choices: [{ message: { content: `❌ Erro ao buscar checklist: ${e.message}` } }], modelo_usado: 'local', modelo_label: 'Erro', tipo: 'error' });
      }
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

      // Detecta se é JSON puro (rápido) ou texto livre (precisa Opus = async)
      // Remove US token no início (ex: "CRMB2B-90 [...]") antes de tentar parsear
      let jsonCandidate = input.replace(/```json\n?|```\n?/g, '').trim();
      const leadingUs = jsonCandidate.match(/^([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\s+(?=[\[{])/i);
      if (leadingUs) jsonCandidate = jsonCandidate.substring(leadingUs[0].length).trim();
      let isJson = false;
      try { JSON.parse(jsonCandidate); isJson = true; } catch { isJson = false; }

      // Texto livre → job assíncrono (evita timeout 30s do Heroku no parsing Opus)
      if (!isJson) {
        const usMatch2 = input.match(/\b([A-Z][A-Z0-9]*B2B-\d+)\b/i) || input.match(/\b(US[-\s]?\d+)\b/i) || input.match(/\b([A-Z]{2,}-[A-Z0-9]+)\b/);
        const usNum2 = usMatch2 ? usMatch2[1].toUpperCase().replace(/\s+/, '-') : null;
        const jobRes = await pool.query(
          'INSERT INTO jobs (user_id, kind, status, input, meta) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [req.user.id, 'runbook-parse', 'processing', input, JSON.stringify({ orgId: org.id, orgName: org.name, us: usNum2 })]
        );
        const jobId = jobRes.rows[0].id;
        parseRunbookJob(jobId, input, org, usNum2).catch(e => {
          console.error('Runbook parse job error:', e.message);
          pool.query('UPDATE jobs SET status = $1, error = $2, updated_at = NOW() WHERE id = $3', ['error', e.message, jobId]).catch(() => {});
        });
        return res.json({
          choices: [{ message: { content: '⏳ **Analisando runbook com Claude Opus 4.6...**\n\nO Opus está montando o plano de deploy (pode levar até 1 min para runbooks grandes). Aguarde.' } }],
          modelo_usado: 'job', modelo_label: 'Opus 4.6 (processando)', tipo: 'job-started', jobId, jobKind: 'runbook-parse'
        });
      }

      try {
        let steps;
        let parseModel = null;
        // JSON puro — também extrai US do início se houver
        const usFromJson = leadingUs ? leadingUs[1].toUpperCase() : null;
        {
          steps = JSON.parse(jsonCandidate);
          if (!Array.isArray(steps)) steps = [steps];
        }
        if (false) {
          const parsePrompt = `Analise este runbook/spec e extraia as ações de deployment Salesforce. Responda SOMENTE com um JSON array (sem markdown, sem backticks).

Ações disponíveis:
- "action": "create-field" — criar campo custom (USE SEMPRE para CustomField. NÃO use metadata-create com type:CustomField)
- "action": "metadata-create" — criar qualquer metadado (CustomObject, CustomField, MatchingRule, DuplicateRule, ValidationRule, RecordType, PermissionSet, PermissionSetGroup, CustomPermission, ListView, CustomTab, BusinessProcess, CompactLayout, CustomLabel, GlobalValueSet, ReportType, CustomMetadata, SharingRules, QuickAction, Group, Queue)
- "action": "layout-add-field" — adiciona campo a uma seção de Page Layout. Requer: { layoutName: "Object-Layout Name", fieldName: "Field__c", sectionLabel: "Identificação", behavior: "Edit"|"Required"|"Readonly" }
- "action": "profile-fls" — atualiza FLS de um Profile. Requer: { profileName: "Profile_Name", fieldPermissions: [{ field: "Object.Field__c", editable: true, readable: true }], objectPermissions: [{ object: "Account", allowCreate: true, allowRead: true, allowEdit: false, allowDelete: false }] }
- "action": "activate-rule" — ativa Matching Rule ou Duplicate Rule (pós-deploy). Requer: { ruleType: "MatchingRule"|"DuplicateRule", ruleName: "Object.RuleName" }
- "action": "assign-custom-permission" — atribui uma ou mais Custom Permissions a um PermissionSet existente (mescla com o que já existe). Requer: { permissionSetName: "PS_Name", customPermissions: ["CP_Name1","CP_Name2"], enabled?: true (default) }
- "action": "create-layout" — cria/atualiza Page Layout com seções e campos. Requer: { object: "Account", layoutName: "MyLayout", sections: [{ label: "Identificação", columns: [[{field:"Name", behavior:"Edit"}, {field:"CNPJ__c", behavior:"Readonly"}], [{field:"Status__c", behavior:"Required"}]] }], relatedLists?: ["ContactList","OpportunityList"] }. Behavior: "Edit"|"Required"|"Readonly". Cada seção tem array de colunas, cada coluna tem array de items.
- "action": "assign-layout" — atribui Page Layout a um Profile (opcionalmente por RecordType). Requer: { profileName: "MyProfile", layoutName: "Account-MyLayout", recordType?: "Account.Cliente_Encarteirado" }
- "action": "ps-fls" — FLS num PermissionSet (DIFERENTE de profile-fls). Requer: { permissionSetName: "PS_Name", fieldPermissions: [{ field: "Account.Campo__c", editable: true, readable: true }], objectPermissions?: [{ object, allowCreate, allowRead, allowEdit, allowDelete }] }
- "action": "assign-ps-to-user" — atribui PermissionSet a um ou mais usuários (via PermissionSetAssignment, sem Apex). Requer: { permissionSetName, users?: ["email1","email2"] OU userIds?: ["005..."] OU usernamePattern?: "*@backoffice.com" }
- "action": "enable-field-history" — ativa Field History Tracking em campos de um objeto. Requer: { object: "Account", fields: ["Phone","Industry","CustomField__c"] }
- "action": "flow" — cria Flow via Metadata API 62.0. Formato { fullName, body: { ... } }
  ⚠️ ATENÇÃO API 62.0: triggerType, recordTriggerType, object DEVEM ficar dentro de start{}, NÃO na raiz do Flow.
  Operadores válidos em FlowComparisonOperator: EqualTo, NotEqualTo, GreaterThan, LessThan, GreaterThanOrEqualTo, LessThanOrEqualTo, StartsWith, EndsWith, Contains, IsNull, WasSet, WasSelected, WasVisited. NÃO existem: DoesNotContain, NotContain, NotEqual, Equals.
  Para "não contém", use Decision com 2 outcomes: um com Contains+true para um lado, outro (default) para o outro.
  Exemplo de Record-Triggered Flow:
  { "action":"flow", "fullName":"Account_Update_On_Insert", "body": { "label":"Account Update", "apiVersion":62.0, "processType":"AutoLaunchedFlow", "status":"Active", "start": { "triggerType":"RecordAfterSave", "recordTriggerType":"Create", "object":"Account", "locationX":50, "locationY":0, "connector":{"targetReference":"updateFields"} }, "recordUpdates": [...] } }

⚠️ REGRAS CRÍTICAS para conversão TEXTO → JSON:
- Se o texto diz "Configurar Page Layout Assignment" ou "matriz Profile x RecordType" ou "atribuir layout X ao profile Y" → use assign-layout (UMA action por combinação Profile+RecordType+Layout)
- Se o texto diz "Criar Page Layout" ou "configurar layout com seções" → use create-layout
- Se o texto diz "Atribuir Custom Permission X ao PS Y" → use assign-custom-permission
- Se o texto diz "Configurar FLS no Profile X" → use profile-fls
- Se o texto diz "Ativar Matching/Duplicate Rule" → use activate-rule
- NUNCA gere manual-step para: layouts, layout assignments, FLS, custom permissions, MR/DR ativação. Sempre tem action automatizada.
- Para layout assignment matriz: expanda em VÁRIOS steps assign-layout (um por combinação)
  Ex: "Atribuir Layout A ao Profile X para RT Y e RT Z, e Layout B ao Profile X para RT Y" gera 3 steps assign-layout
- "action": "metadata-update" — atualizar metadado existente (Profile FLS, etc)
- "action": "apex-class" — criar Apex Class (gerar código completo)
- "action": "apex-trigger" — criar Apex Trigger (gerar código completo)
- "action": "lwc" — criar Lightning Web Component (gerar bundle)
- "action": "flow" — criar Flow (gerar metadata)
- "action": "apex" — executar Apex anônimo
- "action": "soql" — executar SOQL
- "action": "validate" — validação automática (query + condition: "empty"|"has-results"|"no-modify-all-data")

Para create-field: "object", "field" (__c), "label", "type", "length", "picklist" (array de strings para Picklist/MultiselectPicklist — OBRIGATÓRIO se type=Picklist), "referenceTo" (Lookup), "defaultValue" (obrigatório para Checkbox: true/false). IMPORTANTE: Picklist sem array de valores no campo "picklist" vai FALHAR no deploy. Exemplo correto: {"action":"create-field","object":"Account","field":"Origem__c","label":"Origem","type":"Picklist","picklist":["Manual","SERASA","Neoway"]}
Para metadata-create/update: "type" (tipo do metadado), "body" (JSON exato da Metadata API), "description"

FORMATOS METADATA API OBRIGATÓRIOS:
- MatchingRule: { fullName, label, ruleStatus:"Active", matchingRuleItems:[{fieldName, matchingMethod:"Exact"|"CompanyName"|"FirstName"|"LastName"|"Phone"|"City"|"Street"|"Zip"|"Title"}] }. NÃO usar "Fuzzy" — para fuzzy de empresa usar "CompanyName".
- DuplicateRule: { fullName, masterLabel (NÃO label!), isActive, sortOrder (sequencial de 1), actionOnInsert:"Block"|"Allow", actionOnUpdate, alertText, duplicateRuleMatchRules:[{matchRuleSObjectType, matchingRule}] }. NÃO usar objectMapping — usar matchRuleSObjectType.
- ValidationRule: { fullName:"Obj.Name", active:true, errorConditionFormula, errorMessage, errorDisplayField }
- RecordType: { fullName:"Obj.Name", label, active:true }
- PermissionSet: { fullName, label, fieldPermissions:[{field,editable,readable}], objectPermissions:[{object,allowCreate,allowRead,allowEdit,allowDelete}], customPermissions:[{name:"CustomPermName",enabled:true}], applicationVisibilities:[{application:"AppName",visible:true}], userPermissions:[{name:"PermName",enabled:true}] }
- CustomObject: { fullName:"MeuObj__c", label:"Meu Objeto", pluralLabel:"Meus Objetos", nameField:{ type:"Text"|"AutoNumber", label:"Name", displayFormat:"OBJ-{0000}" }, deploymentStatus:"Deployed", sharingModel:"ReadWrite"|"Private"|"Read" }
- CustomPermission: { fullName:"MinhaPerm", label:"Minha Permissao", description:"Descricao" }. Usado em VRs via $CustomPermission ou em PSs.
- PermissionSetGroup: { fullName:"PSG_Nome", label, description, permissionSets:["PS_1","PS_2"] }. Agrupa PSs para atribuicao em bloco.
- CustomMetadata: { fullName:"TipoMetadata__mdt.RecordName", label:"Label do Registro", protected:false, values:[{field:"Campo__c",value:{string:"valor"}}] }. Para registros de Custom Metadata Type ja existente. Para criar o TIPO use CustomObject com fullName terminado em __mdt.
- SharingRules: { fullName:"Account.SR_Nome", sharingCriteriaRules:[{fullName:"SR_Nome",label,accessLevel:"Read"|"Edit"|"All",booleanFilter,criteriaItems:[{field:"Status__c",operation:"equals",value:"Ativo"}],sharedTo:{group:"MeuGrupo"}|{role:"MinhaRole"}|{publicGroup:"Grupo"}}] }
- QuickAction: { fullName:"Objeto.MinhaAction", label, type:"Create"|"Update"|"Flow"|"LightningComponent", targetObject:"Account", flowDefinition:"MeuFlow", optionsCreateFeedItem:false }
- Group: { fullName:"MeuPublicGroup", name:"MeuPublicGroup", doesIncludeBosses:true, doesSendEmailToMembers:false }. Public Group para Sharing Rules e Queue.
- Queue: { fullName:"MinhaQueue", name:"MinhaQueue", doesSendEmailToMembers:false, queueRoutingConfig:null, queueMembers:{publicGroups:["GrupoX"],users:["user@example.com"]}, queueSobject:[{sobjectType:"Lead"}] }
- ListView: { fullName:"Obj.ViewName", label, filterScope:"Everything"|"Mine", columns:["Name","CreatedDate","Owner.Alias"], filters:[{field:"Status__c",operation:"equals",value:"Ativo"}] }
- CustomTab: { fullName:"MeuObj__c", customObject:true, motif:"Custom68__Tab" }
- BusinessProcess: { fullName:"Obj.ProcessName", isActive:true, values:[{fullName:"Qualification"},{fullName:"Proposal"},{fullName:"Closed Won"}] }. Obj = Lead|Opportunity|Case.
- CompactLayout: { fullName:"Obj.LayoutName", label, fields:["Name","Phone","Email"] }
- CustomLabel: { fullName:"MeuLabel", value:"Texto do label", language:"pt_BR", protected:false }
- GlobalValueSet: { fullName:"MeuGlobalPicklist", sorted:false, customValue:[{fullName:"Valor1",label:"Valor 1",isActive:true},{fullName:"Valor2",label:"Valor 2",isActive:true}] }
- ReportType: { fullName:"MeuReportType", label, baseObject:"Account", category:"accounts", deployed:true, sections:[{columns:[{checkedByDefault:true,field:"Id",table:"Account"}]}] }

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

        // US do início do JSON (já extraída) ou detecta no input
        let usNumber = usFromJson;
        if (!usNumber) {
          const usPatterns = [
            /\b([A-Z][A-Z0-9]*B2B-\d+)\b/i,
            /\b(US[-\s]?\d+)\b/i,
            /\b([A-Z]{2,}-[A-Z0-9]+)\b/,
          ];
          for (const pat of usPatterns) {
            const m = input.match(pat);
            if (m) { usNumber = m[1].toUpperCase().replace(/\s+/, '-'); break; }
          }
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
            if (act === 'create-field' || (comp && comp.includes('.') && comp.endsWith('__c') && act === 'metadata-create' && !comp.includes('MR_') && !comp.includes('DR_'))) {
              // Campo: verificar via Tooling query (sem cache, ao contrário do describe)
              const [objName, fieldName] = comp.split('.');
              const devName = fieldName.replace(/__c$/, '');
              const q = await sfMulti.runToolingQuery(org, `SELECT Id, Length FROM CustomField WHERE TableEnumOrId = '${objName}' AND DeveloperName = '${devName}'`);
              ok = q.records && q.records.length > 0;
              check = ok ? 'Campo existe' : 'Campo NÃO encontrado';
              status = ok ? '✅' : '❌';
            } else if (act === 'metadata-create' || act === 'metadata-update') {
              // Metadado: inferir tipo pelo nome e ler
              // Detectar tipo pelo nome/prefixo do componente
              let mtype = null;
              const cl = comp.toLowerCase();
              if (comp.includes('MR_') || cl.includes('match')) mtype = 'MatchingRule';
              else if (comp.includes('DR_') || cl.includes('dup')) mtype = 'DuplicateRule';
              else if (comp.includes('VR_') || cl.includes('valid')) mtype = 'ValidationRule';
              else if (cl.includes('customperm') || comp.includes('CP_')) mtype = 'CustomPermission';
              else if (cl.includes('permissionsetgroup') || comp.includes('PSG_')) mtype = 'PermissionSetGroup';
              else if (comp.includes('.') && comp.endsWith('__c')) mtype = 'CustomField';
              else mtype = row.description ? row.description.split(' ')[0] : 'CustomField';
              const meta = await sfMulti.metadataRead(org, mtype, comp);
              if (mtype === 'DuplicateRule') {
                ok = meta && meta.masterLabel && meta.masterLabel.length > 0;
                check = ok ? `Ativa: ${meta.isActive}, ação: ${meta.actionOnInsert}` : 'Regra vazia/inexistente';
              } else if (mtype === 'MatchingRule') {
                ok = meta && (meta.ruleStatus === 'Active' || meta.masterLabel);
                check = ok ? `Status: ${meta.ruleStatus || 'OK'}` : 'Regra não encontrada';
              } else if (mtype === 'ValidationRule') {
                ok = meta && (meta.active !== undefined || meta.errorConditionFormula);
                check = ok ? `Ativa: ${meta.active}, fórmula OK` : 'VR não encontrada';
              } else if (mtype === 'CustomPermission') {
                ok = meta && meta.label;
                check = ok ? `Label: ${meta.label}` : 'CP não encontrada';
              } else if (mtype === 'PermissionSetGroup') {
                ok = meta && meta.label;
                check = ok ? `Label: ${meta.label}` : 'PSG não encontrado';
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

        // ── /rollback [US] — visualiza componentes e permite rollback ──
    if (lower === '/rollback' || lower.startsWith('/rollback ')) {
      if (!org) return res.json({ choices: [{ message: { content: '❌ Nenhuma org conectada.' } }], modelo_usado: 'mcp-server', modelo_label: 'Erro', tipo: 'error' });
      const filter = userMsg.trim().substring(9).trim().toUpperCase();
      try {
        let rows;
        if (filter) {
          rows = (await pool.query(
            `SELECT DISTINCT ON (component, action) * FROM deploy_log
             WHERE UPPER(us_number) = $1 AND result IN ('success','exists')
             ORDER BY component, action, created_at DESC`,
            [filter]
          )).rows;
          // Also check for updates with snapshots (for restore option)
        } else {
          rows = (await pool.query(
            `SELECT DISTINCT ON (component, action) * FROM deploy_log
             WHERE result IN ('success','exists')
             ORDER BY component, action, created_at DESC
             LIMIT 50`
          )).rows;
        }
        if (!rows.length) return res.json({ choices: [{ message: { content: filter ? `📭 Nenhum componente deployado para "${filter}".` : '📭 Nenhum deploy registrado.' } }], modelo_usado: 'local', modelo_label: 'Rollback', tipo: 'rollback' });

        // Build rollback steps: restore (if snapshot) or delete (if created new)
        const rollbackSteps = [];
        for (const r of rows) {
          const comp = r.component;
          const act = r.action;
          const hasPrevState = r.previous_state && r.previous_state.length > 2;

          // Determine component type from action + component name + description
          let deleteType = null;
          const desc = (r.description || '').toLowerCase();
          if (act === 'create-field') deleteType = 'CustomField';
          else if (act === 'create-layout') deleteType = 'Layout';
          else if (act === 'apex-class') deleteType = 'ApexClass';
          else if (act === 'apex-trigger') deleteType = 'ApexTrigger';
          else if (act === 'lwc') deleteType = 'LightningComponentBundle';
          else if (act === 'flow') deleteType = 'Flow';
          else if (act === 'metadata-create' || act === 'metadata-update') {
            // Detectar tipo pelo prefixo do componente ou pela description
            if (comp.includes('MR_') || desc.includes('matchingrule')) deleteType = 'MatchingRule';
            else if (comp.includes('DR_') || desc.includes('duplicaterule')) deleteType = 'DuplicateRule';
            else if (comp.includes('VR_') || desc.includes('validationrule')) deleteType = 'ValidationRule';
            else if (desc.includes('permissionset') && !desc.includes('group')) deleteType = 'PermissionSet';
            else if (desc.includes('permissionsetgroup')) deleteType = 'PermissionSetGroup';
            else if (desc.includes('custompermission')) deleteType = 'CustomPermission';
            else if (desc.includes('recordtype')) deleteType = 'RecordType';
            else if (desc.includes('customobject')) deleteType = 'CustomObject';
            else if (desc.includes('listview')) deleteType = 'ListView';
            else if (desc.includes('quickaction')) deleteType = 'QuickAction';
            else if (desc.includes('queue') || desc.includes('group')) deleteType = 'Queue';
            else if (desc.includes('flow')) deleteType = 'Flow';
            else if (desc.includes('layout')) deleteType = 'Layout';
            else if (comp.endsWith('__c') && comp.includes('.')) deleteType = 'CustomField';
            else if (comp.endsWith('__c')) deleteType = 'CustomObject';
            else deleteType = null; // skip if we can't determine type
          }
          // Skip non-deletable actions (assign-layout, ps-fls, assign-custom-permission, assign-ps-to-user, enable-field-history, profile-fls, activate-rule, soql, validate, apex, manual-step)
          // These are configuration changes, not new components — use snapshot restore if available
          else if (['assign-layout','ps-fls','assign-custom-permission','profile-fls','layout-add-field'].includes(act)) {
            if (hasPrevState) {
              // Has snapshot → can restore
              deleteType = act === 'ps-fls' || act === 'assign-custom-permission' ? 'PermissionSet' : (act === 'profile-fls' ? 'Profile' : 'Layout');
            } else {
              continue; // No way to rollback a config change without snapshot
            }
          }
          if (!deleteType) continue;
          // Skip se o fullName é claramente um action name (não um componente real)
          if (['create-layout','assign-layout','ps-fls','profile-fls','assign-custom-permission','layout-add-field','activate-rule','enable-field-history','assign-ps-to-user'].includes(comp)) continue;

          if (hasPrevState) {
            // Has snapshot → RESTORE to previous version
            rollbackSteps.push({
              action: 'rollback-restore',
              type: deleteType,
              fullName: comp,
              snapshot: r.previous_state,
              description: `Restaurar versão anterior: ${comp}`,
              _original: { us: r.us_number, action: act, date: r.created_at }
            });
          } else {
            // No snapshot → DELETE (was a new creation)
            rollbackSteps.push({
              action: 'metadata-delete',
              type: deleteType,
              fullName: comp,
              description: `Deletar: ${comp}`,
              _original: { us: r.us_number, action: act, date: r.created_at }
            });
          }
        }
        if (!rollbackSteps.length) return res.json({ choices: [{ message: { content: '📭 Nenhum componente reversível encontrado.' } }], modelo_usado: 'local', modelo_label: 'Rollback', tipo: 'rollback' });

        // Reverse order: triggers/apex before fields, DRs before MRs (reverse dependency)
        const typeOrder = { 'ApexTrigger': 0, 'Flow': 1, 'LightningComponentBundle': 2, 'ApexClass': 3, 'DuplicateRule': 4, 'MatchingRule': 5, 'ValidationRule': 6, 'PermissionSet': 7, 'PermissionSetGroup': 8, 'CustomPermission': 9, 'RecordType': 10, 'Layout': 11, 'ListView': 12, 'QuickAction': 13, 'CustomField': 14, 'CustomObject': 15 };
        rollbackSteps.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));

        // Show table
        let orgUrl = '';
        try { const c = await sfMulti.testConnection(org); orgUrl = c.instanceUrl || ''; } catch {}
        const orgLink = orgUrl ? orgUrl.replace('https://','') : org.username;
        let text = `## ⏪ Rollback${filter ? ' — ' + filter : ''} — ${rollbackSteps.length} componente(s)\n\n`;
        text += `**Org:** [${orgLink}](${orgUrl})\n\n`;
        text += `| # | Tipo | Componente | Ação original | Rollback |\n|---|---|---|---|---|\n`;
        rollbackSteps.forEach((s, i) => {
          const orig = s._original || {};
          const rollbackAction = s.action === 'rollback-restore' ? '⏪ restaurar' : '🗑️ delete';
          text += `| ${i + 1} | ${s.type} | ${s.fullName} | ${orig.action || '-'} | ${rollbackAction} |\n`;
        });
        text += `\n⚠️ **Atenção:** esta ação vai **deletar** todos os componentes acima da org. Esta operação é irreversível.\n\n`;
        text += `**Confirme para iniciar o rollback passo a passo.**`;

        // Clean steps for payload (remove _original)
        const cleanSteps = rollbackSteps.map(({ _original, ...rest }) => rest);
        const payload = Buffer.from(JSON.stringify({ steps: cleanSteps, currentStep: 0, us: filter || null })).toString('base64');

        return res.json({
          choices: [{ message: { content: text } }],
          modelo_usado: 'mcp-server',
          modelo_label: 'Rollback — ' + org.name,
          tipo: 'confirm',
          confirmData: { action: 'runbook', payload }
        });
      } catch (e) { return res.json({ choices: [{ message: { content: `❌ ${e.message}` } }], modelo_usado: 'local', modelo_label: 'Erro', tipo: 'error' }); }
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
          let result;
          try {
            result = await executeRunbookStep(step, org);
          } catch (stepErr) {
            result = { ok: false, message: '❌ Erro no passo: ' + (stepErr.message || String(stepErr)).substring(0, 300) };
          }
          // Log to deploy_log (with snapshot for rollback if component was updated)
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
            userName: req.user.name,
            previousState: result.previousState || null
          });
          let text = `### Passo ${currentStep + 1} de ${steps.length}\n\n${result.message}\n`;
          const remainingSteps = steps.slice(currentStep + 1);
          let errorAnalysis = null;

          // ═══ AUTO-FIX: quando step falha, Opus analisa e gera fix automaticamente ═══
          if (!result.ok) {
            errorAnalysis = { step: JSON.parse(JSON.stringify(step)), error: result.message, orgName: org.name, remainingSteps, us: us || null };
            try {
              // Chamar Opus para analisar o erro e gerar fix inline
              const afPrompt = 'Voce e um arquiteto Salesforce. Analise o erro e gere APENAS um bloco JSON com os steps corretivos.\n' +
                'Actions: create-field, metadata-create, metadata-update, metadata-delete, apex-class, apex-trigger, layout-add-field, profile-fls, ps-fls, assign-custom-permission, assign-layout, create-layout, activate-rule, soql, validate, manual-step\n' +
                'Para Picklist: use create-field com picklist:["v1","v2"] (array simples).\n' +
                'Para Flow: triggerType/object dentro de start{} (API 62.0).\n' +
                'Operadores validos: EqualTo, NotEqualTo, GreaterThan, LessThan, Contains, IsNull, WasSet. NAO usar DoesNotContain/NotContain.\n' +
                'Responda: 1 linha de diagnostico + bloco ```json\n[...]\n``` com fix steps. Seja direto.';
              const afContent = 'Step que falhou: ' + JSON.stringify(step) + '\nErro: ' + result.message + '\nOrg: ' + org.name;
              const afResult = await claude.callRouted('spec', afPrompt, [{ role: 'user', content: afContent }], 2048);
              // Extrair fixSteps do resultado
              const jsonMatch = (afResult.text || '').match(/```json\n([\s\S]*?)```/);
              if (jsonMatch) {
                const fixSteps = JSON.parse(jsonMatch[1].trim());
                if (Array.isArray(fixSteps) && fixSteps.length > 0) {
                  // Combinar: fixSteps + remainingSteps (incluindo retry do step original)
                  const combinedSteps = [...fixSteps, ...remainingSteps];
                  const combinedPayload = { steps: combinedSteps, currentStep: 0, us };
                  const diagLine = (afResult.text || '').split('\n').find(l => l.trim() && !l.startsWith('```')) || 'Correcao identificada';
                  text += '\n\n⚡ **Auto-fix:** ' + diagLine.substring(0, 200);
                  text += '\n\n---\n### Fix — Passo 1 de ' + combinedSteps.length + '\n\n';
                  text += formatStepPreview(combinedSteps[0]);
                  if (remainingSteps.length > 0) {
                    text += '\n_Apos a correcao, o runbook retoma os ' + remainingSteps.length + ' passos restantes._';
                  }
                  return res.json({
                    choices: [{ message: { content: text } }],
                    modelo_usado: 'mcp-server',
                    modelo_label: 'Auto-fix (Opus) — ' + org.name,
                    tipo: 'confirm',
                    confirmData: { action: 'runbook', payload: Buffer.from(JSON.stringify(combinedPayload)).toString('base64') }
                  });
                }
              }
            } catch (afErr) {
              // Se o auto-fix falhar, continua com o fluxo normal (mostra erro + botão manual)
            }
          }

          const nextStep = currentStep + 1;
          if (nextStep < steps.length) {
            text += '\n---\n### Proximo — Passo ' + (nextStep + 1) + ' de ' + steps.length + '\n\n';
            text += formatStepPreview(steps[nextStep]);
            const nextPayload = { steps, currentStep: nextStep, us };
            const respData = { choices: [{ message: { content: text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'confirm', confirmData: { action: 'runbook', payload: Buffer.from(JSON.stringify(nextPayload)).toString('base64') } };
            if (errorAnalysis) respData.errorAnalysis = errorAnalysis;
            return res.json(respData);
          } else {
            text += '\n---\n' + String.fromCodePoint(0x1F3C1) + ' **Runbook completo!** ' + steps.length + ' passo(s) executado(s).';
            const finalResp = { choices: [{ message: { content: text } }], modelo_usado: 'mcp-server', modelo_label: 'Org: ' + org.name, tipo: 'executed' };
            if (errorAnalysis) finalResp.errorAnalysis = errorAnalysis;
            return res.json(finalResp);
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
