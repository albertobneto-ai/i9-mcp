// src/services/devops-engine.js
// Engine para /devops — K, C, N, I, J, L, M, O integrados
// ADITIVO: não quebra nada existente

import { connectToOrg, describeObject, runToolingQuery, metadataRead, runSoql, listMetadata } from './sf-multi.js';
import pool from '../config/db.js';

// ═══════════════════════════════════════════════════════════════
// K — DEPENDENCY ANALYZER (PRIORIDADE CRÍTICA)
// Antes do deploy, mapeia TODAS as dependências de cada componente
// ═══════════════════════════════════════════════════════════════

export async function analyzeDependencies(org, components) {
  const conn = await connectToOrg(org);
  const deps = { safe: [], warnings: [], blockers: [] };
  const analyzed = [];

  for (const comp of components) {
    const entry = { component: comp.name || comp.field || comp.fullName, action: comp.action, dependencies: [] };

    try {
      if (comp.action === 'create-field') {
        // Novo campo — sem dependências de remoção, mas checar se objeto existe
        const objName = comp.object;
        try {
          await describeObject(org, objName);
          entry.dependencies.push({ type: 'object', name: objName, status: 'exists', risk: 'none' });
        } catch {
          entry.dependencies.push({ type: 'object', name: objName, status: 'missing', risk: 'blocker' });
          deps.blockers.push(`Objeto ${objName} não existe — campo ${comp.field} não pode ser criado`);
        }
      }

      if (comp.action === 'metadata-deploy-xml' && comp.files) {
        // Analisar campos referenciados no XML
        for (const f of comp.files) {
          const content = f.content || '';
          // Extrair API names referenciados
          const fieldRefs = [...content.matchAll(/ISCHANGED\(([^)]+)\)|PRIORVALUE\(([^)]+)\)/g)]
            .map(m => m[1] || m[2]).filter(Boolean);
          for (const ref of fieldRefs) {
            try {
              const desc = await describeObject(org, 'Account');
              const fieldExists = desc.fields?.some(ff => ff.name === ref || ff.name === ref.replace('__c','') + '__c');
              if (!fieldExists) {
                entry.dependencies.push({ type: 'field', name: ref, status: 'missing', risk: 'blocker' });
                deps.blockers.push(`Campo ${ref} referenciado em VR/Formula mas não existe no Account`);
              } else {
                entry.dependencies.push({ type: 'field', name: ref, status: 'exists', risk: 'none' });
              }
            } catch { /* ignore describe errors */ }
          }
        }
      }

      // Verificar se componente a ser alterado tem dependências (VRs, Flows, Apex que referenciam)
      if (comp.field && comp.object) {
        const fieldApiName = comp.field;
        const objName = comp.object;

        // 1. VRs que referenciam este campo
        try {
          const vrQuery = `SELECT Id, ValidationName, ErrorMessage FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${objName}' AND Active = true`;
          const vrs = await runToolingQuery(org, vrQuery);
          if (vrs?.records) {
            for (const vr of vrs.records) {
              // Ler corpo da VR para checar referência
              const vrDetail = await runToolingQuery(org, `SELECT Metadata FROM ValidationRule WHERE Id = '${vr.Id}'`);
              const formula = vrDetail?.records?.[0]?.Metadata?.errorConditionFormula || '';
              if (formula.includes(fieldApiName)) {
                entry.dependencies.push({ type: 'ValidationRule', name: vr.ValidationName, status: 'references', risk: 'warning' });
                deps.warnings.push(`VR ${vr.ValidationName} referencia campo ${fieldApiName}`);
              }
            }
          }
        } catch { /* tooling query may fail for some types */ }

        // 2. Flows que referenciam este campo
        try {
          const flowQuery = `SELECT Id, ApiName, ProcessType FROM FlowDefinition WHERE ActiveVersion.Status = 'Active'`;
          const flows = await runToolingQuery(org, flowQuery);
          // FlowDefinition query limitada — registrar aviso
          if (flows?.records?.length) {
            entry.dependencies.push({ type: 'info', name: `${flows.records.length} Flows ativos na org`, status: 'check', risk: 'info' });
          }
        } catch { /* ignore */ }
      }

      // Componentes que podem ser criados sem risco
      if (['sobject-insert', 'sobject-query', 'metadata-read'].includes(comp.action)) {
        entry.dependencies.push({ type: 'info', name: 'Read-only/Insert — sem risco de dependência', status: 'safe', risk: 'none' });
        deps.safe.push(`${comp.action}: ${comp.name || comp.objectName || 'query'}`);
      }
    } catch (err) {
      entry.dependencies.push({ type: 'error', name: err.message, status: 'error', risk: 'warning' });
      deps.warnings.push(`Erro ao analisar ${entry.component}: ${err.message}`);
    }

    analyzed.push(entry);
  }

  return {
    summary: {
      total: analyzed.length,
      safe: deps.safe.length,
      warnings: deps.warnings.length,
      blockers: deps.blockers.length,
      canDeploy: deps.blockers.length === 0
    },
    blockers: deps.blockers,
    warnings: deps.warnings,
    safe: deps.safe,
    components: analyzed
  };
}

// ═══════════════════════════════════════════════════════════════
// C — COMPARADOR AS-IS vs TO-BE
// Captura estado atual antes do deploy e mostra diff
// ═══════════════════════════════════════════════════════════════

export async function captureAsIs(org, steps) {
  const conn = await connectToOrg(org);
  const snapshot = [];

  for (const step of steps) {
    const entry = { step: step.action, component: step.field || step.name || step.fullName || step.objectName, asIs: null, toBe: null };

    try {
      if (step.action === 'create-field') {
        // Verificar se campo já existe
        try {
          const desc = await describeObject(org, step.object);
          const existing = desc.fields?.find(f => f.name === step.field);
          if (existing) {
            entry.asIs = { exists: true, type: existing.type, label: existing.label, length: existing.length, updateable: existing.updateable };
          } else {
            entry.asIs = { exists: false };
          }
        } catch { entry.asIs = { exists: false, error: 'describe failed' }; }
        entry.toBe = { exists: true, type: step.type, label: step.label, length: step.length };
      }

      if (step.action === 'sobject-insert' && step.objectName === 'PermissionSet') {
        // Checar se PS já existe
        try {
          const q = await conn.query(`SELECT Id, Name, Label FROM PermissionSet WHERE Name = '${(step.records?.[0]?.Name || '').replace(/'/g, "\\'")}'`);
          entry.asIs = q.records?.length ? { exists: true, id: q.records[0].Id, label: q.records[0].Label } : { exists: false };
        } catch { entry.asIs = { exists: false }; }
        entry.toBe = { exists: true, name: step.records?.[0]?.Name, label: step.records?.[0]?.Label };
      }

      if (step.action === 'metadata-deploy-xml') {
        entry.asIs = { description: 'Verificação via metadata-read necessária' };
        entry.toBe = { files: (step.files || []).map(f => f.path) };
      }

      if (step.action === 'activate-rule') {
        try {
          const r = await metadataRead(org, step.ruleType, step.ruleName);
          entry.asIs = { active: r?.active, fullName: r?.fullName };
        } catch { entry.asIs = { exists: false }; }
        entry.toBe = { active: step.activate !== false };
      }
    } catch (err) {
      entry.asIs = { error: err.message };
    }

    snapshot.push(entry);
  }

  return snapshot;
}

export function formatDiff(snapshot) {
  const lines = [];
  for (const s of snapshot) {
    const comp = s.component || s.step;
    if (!s.asIs || s.asIs.exists === false) {
      lines.push({ component: comp, change: 'CREATE', detail: `Novo: ${JSON.stringify(s.toBe || {})}` });
    } else if (s.asIs.exists === true) {
      lines.push({ component: comp, change: 'EXISTS', detail: `Já existe. AS-IS: ${JSON.stringify(s.asIs)}. TO-BE: ${JSON.stringify(s.toBe || {})}` });
    } else {
      lines.push({ component: comp, change: 'MODIFY', detail: `AS-IS: ${JSON.stringify(s.asIs)} → TO-BE: ${JSON.stringify(s.toBe || {})}` });
    }
  }
  return lines;
}


// ═══════════════════════════════════════════════════════════════
// N — PRE-FLIGHT VALIDATION
// validateOnly=true na Metadata API antes de deployar de verdade
// ═══════════════════════════════════════════════════════════════

export async function preflightValidation(org, steps) {
  const conn = await connectToOrg(org);
  const results = [];

  // Agrupar steps metadata-deploy-xml para validação conjunta
  const xmlSteps = steps.filter(s => s.action === 'metadata-deploy-xml');
  const otherSteps = steps.filter(s => s.action !== 'metadata-deploy-xml');

  // Validar XML deploys com validateOnly=true
  for (const step of xmlSteps) {
    try {
      const archiver = (await import('archiver')).default;
      const chunks = [];
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('data', chunk => chunks.push(chunk));
      const done = new Promise((resolve, reject) => { archive.on('end', resolve); archive.on('error', reject); });
      for (const f of step.files || []) {
        archive.append(Buffer.from(f.content, 'utf-8'), { name: f.path });
      }
      archive.finalize();
      await done;
      const deployBuf = Buffer.concat(chunks);

      // VALIDATE ONLY — não aplica na org
      const deployResult = await conn.metadata.deploy(deployBuf, {
        rollbackOnError: true,
        singlePackage: true,
        checkOnly: true  // <-- PRE-FLIGHT
      });

      let deployStatus = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        deployStatus = await conn.metadata.checkDeployStatus(deployResult.id, true);
        if (deployStatus.done) break;
      }

      const ok = deployStatus?.success;
      const failures = deployStatus?.details?.componentFailures;
      const failMsgs = failures
        ? (Array.isArray(failures) ? failures : [failures]).map(f => `${f.fullName}: ${f.problem}`).join('; ')
        : '';

      results.push({
        step: 'metadata-deploy-xml (validate)',
        files: (step.files || []).map(f => f.path),
        valid: !!ok,
        message: ok ? '✅ Pre-flight OK — validação passou' : `❌ Pre-flight FALHOU: ${failMsgs}`,
        deployId: deployResult.id,
        failures: failures || null
      });
    } catch (err) {
      results.push({
        step: 'metadata-deploy-xml (validate)',
        files: (step.files || []).map(f => f.path),
        valid: false,
        message: `❌ Erro na validação: ${err.message}`
      });
    }
  }

  // Validar outros steps sintaticamente (sem chamar a org)
  for (const step of otherSteps) {
    const validation = { step: step.action, component: step.field || step.name || step.objectName, valid: true, checks: [] };

    if (step.action === 'create-field') {
      if (!step.object) { validation.valid = false; validation.checks.push('object é obrigatório'); }
      if (!step.field) { validation.valid = false; validation.checks.push('field é obrigatório'); }
      if (!step.type) { validation.valid = false; validation.checks.push('type é obrigatório'); }
      if (['Text'].includes(step.type) && (!step.length || step.length > 255)) { validation.checks.push('Text: length deve ser 1-255'); }
      if (['Picklist', 'MultiselectPicklist'].includes(step.type) && !step.picklist?.length) { validation.valid = false; validation.checks.push('Picklist sem valores'); }
      validation.checks.push(validation.valid ? '✅ Sintaxe OK' : '❌ Erros de sintaxe encontrados');
    }

    if (step.action === 'sobject-insert') {
      if (!step.objectName && !step.type) { validation.valid = false; validation.checks.push('objectName obrigatório'); }
      if (!step.records?.length && !step.body) { validation.valid = false; validation.checks.push('records[] obrigatório'); }
      validation.checks.push(validation.valid ? '✅ Payload OK' : '❌ Payload inválido');
    }

    if (step.action === 'apex-class') {
      if (!step.name) { validation.valid = false; validation.checks.push('name obrigatório'); }
      if (!step.body) { validation.valid = false; validation.checks.push('body obrigatório'); }
      if (step.body && !step.body.includes('class ')) { validation.checks.push('⚠️ body não parece conter "class" — verificar'); }
      validation.checks.push(validation.valid ? '✅ Apex validado' : '❌ Apex inválido');
    }

    results.push(validation);
  }

  const allValid = results.every(r => r.valid);
  return {
    canDeploy: allValid,
    total: results.length,
    passed: results.filter(r => r.valid).length,
    failed: results.filter(r => !r.valid).length,
    results
  };
}


// ═══════════════════════════════════════════════════════════════
// J — FIELD HISTORY TRACKING AUTOMATIZADO
// Habilitar FHT para campos custom via Metadata API
// ═══════════════════════════════════════════════════════════════

export async function enableFieldHistory(org, objectName, fields) {
  const conn = await connectToOrg(org);
  const results = [];

  // Verificar FHT já habilitado no objeto
  try {
    const desc = await describeObject(org, objectName);
    const trackableFields = desc.fields?.filter(f => f.name.endsWith('__c')).map(f => f.name) || [];

    for (const field of fields) {
      if (!trackableFields.includes(field)) {
        results.push({ field, ok: false, message: `⚠️ Campo ${field} não encontrado ou não é custom (standard FHT requer Setup manual)` });
        continue;
      }

      try {
        // Habilitar via Metadata API — update CustomField com trackHistory=true
        const fullName = `${objectName}.${field}`;
        const readResult = await metadataRead(org, 'CustomField', fullName);
        if (readResult) {
          readResult.trackHistory = true;
          const updateResult = await conn.metadata.update('CustomField', readResult);
          const item = Array.isArray(updateResult) ? updateResult[0] : updateResult;
          const ok = item?.success !== false;
          results.push({ field, ok, message: ok ? `✅ FHT habilitado: ${fullName}` : `❌ ${JSON.stringify(item?.errors || item)}` });
        } else {
          results.push({ field, ok: false, message: `❌ Não conseguiu ler metadado de ${fullName}` });
        }
      } catch (err) {
        results.push({ field, ok: false, message: `❌ ${err.message}` });
      }
    }
  } catch (err) {
    results.push({ field: objectName, ok: false, message: `❌ Erro ao descrever ${objectName}: ${err.message}` });
  }

  return {
    object: objectName,
    total: results.length,
    enabled: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results
  };
}


// ═══════════════════════════════════════════════════════════════
// L — PERFORMANCE BASELINE
// Captura tempos de execução pré e pós-deploy
// ═══════════════════════════════════════════════════════════════

export async function capturePerformanceBaseline(org, objectName) {
  const conn = await connectToOrg(org);
  const baseline = {};

  // 1. Tempo de describe
  const t1 = Date.now();
  await describeObject(org, objectName);
  baseline.describeMs = Date.now() - t1;

  // 2. Tempo de query simples
  const t2 = Date.now();
  try {
    await conn.query(`SELECT Id FROM ${objectName} LIMIT 1`);
  } catch { /* org pode não ter registros */ }
  baseline.querySimpleMs = Date.now() - t2;

  // 3. Tempo de query com campos
  const t3 = Date.now();
  try {
    await conn.query(`SELECT Id, Name, CreatedDate, LastModifiedDate FROM ${objectName} LIMIT 10`);
  } catch { /* ignore */ }
  baseline.queryFieldsMs = Date.now() - t3;

  // 4. Contar registros
  const t4 = Date.now();
  try {
    const countResult = await conn.query(`SELECT COUNT() FROM ${objectName}`);
    baseline.recordCount = countResult.totalSize;
  } catch { baseline.recordCount = -1; }
  baseline.countMs = Date.now() - t4;

  // 5. Contar VRs ativas
  try {
    const vrs = await runToolingQuery(org, `SELECT COUNT() FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${objectName}' AND Active = true`);
    baseline.activeVRs = vrs?.totalSize || 0;
  } catch { baseline.activeVRs = -1; }

  // 6. Contar Flows ativos (Record-Triggered)
  try {
    const flows = await runToolingQuery(org, `SELECT COUNT() FROM Flow WHERE ProcessType IN ('AutoLaunchedFlow','RecordBeforeSave','RecordAfterSave') AND Status = 'Active'`);
    baseline.activeFlows = flows?.totalSize || 0;
  } catch { baseline.activeFlows = -1; }

  baseline.timestamp = new Date().toISOString();
  baseline.object = objectName;

  return baseline;
}

export function compareBaselines(before, after) {
  const diff = {};
  for (const key of ['describeMs', 'querySimpleMs', 'queryFieldsMs', 'countMs']) {
    if (before[key] != null && after[key] != null) {
      const delta = after[key] - before[key];
      const pct = before[key] > 0 ? Math.round((delta / before[key]) * 100) : 0;
      diff[key] = { before: before[key], after: after[key], deltaMs: delta, deltaPct: pct, status: pct > 50 ? 'degraded' : pct > 20 ? 'warning' : 'ok' };
    }
  }
  diff.recordCountDelta = (after.recordCount || 0) - (before.recordCount || 0);
  diff.vrDelta = (after.activeVRs || 0) - (before.activeVRs || 0);
  diff.flowDelta = (after.activeFlows || 0) - (before.activeFlows || 0);
  return diff;
}


// ═══════════════════════════════════════════════════════════════
// M — AUDIT TRAIL CONSOLIDADO
// Grava cada step com metadata rica no deploy_log
// ═══════════════════════════════════════════════════════════════

export async function logDeployStep(usNumber, orgName, component, action, description, result, resultMessage, userName, snapshot = null) {
  try {
    await pool.query(
      `INSERT INTO deploy_log (us_number, org_name, component, action, description, result, result_message, user_name, previous_state, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [usNumber, orgName, component, action, description, result, resultMessage?.substring(0, 2000), userName, snapshot ? JSON.stringify(snapshot) : null]
    );
  } catch (err) {
    console.error('[audit] log error:', err.message);
  }
}

export async function getDeployAudit(usNumber) {
  try {
    const { rows } = await pool.query(
      `SELECT id, component, action, description, result, result_message, org_name, user_name, previous_state, created_at
       FROM deploy_log WHERE UPPER(us_number) = $1 ORDER BY created_at ASC, id ASC`,
      [usNumber.toUpperCase()]
    );
    return {
      us: usNumber,
      total: rows.length,
      success: rows.filter(r => r.result === 'success').length,
      errors: rows.filter(r => r.result === 'error').length,
      timeline: rows
    };
  } catch (err) {
    return { us: usNumber, total: 0, error: err.message };
  }
}


// ═══════════════════════════════════════════════════════════════
// I — DIFF DE SPEC ENTRE VERSÕES
// Compara duas specs e marca [AJUSTADO]
// ═══════════════════════════════════════════════════════════════

export function diffSpecs(specV1, specV2) {
  const diff = [];
  const sectionsV1 = parseSections(specV1);
  const sectionsV2 = parseSections(specV2);

  const allSections = new Set([...Object.keys(sectionsV1), ...Object.keys(sectionsV2)]);

  for (const section of allSections) {
    if (!sectionsV1[section]) {
      diff.push({ section, change: 'ADDED', detail: '[NOVO] Seção adicionada na nova versão' });
    } else if (!sectionsV2[section]) {
      diff.push({ section, change: 'REMOVED', detail: '[REMOVIDO] Seção removida na nova versão' });
    } else if (sectionsV1[section] !== sectionsV2[section]) {
      // Diff simples por linhas
      const linesV1 = sectionsV1[section].split('\n');
      const linesV2 = sectionsV2[section].split('\n');
      const added = linesV2.filter(l => !linesV1.includes(l) && l.trim().length > 0);
      const removed = linesV1.filter(l => !linesV2.includes(l) && l.trim().length > 0);
      diff.push({
        section,
        change: 'MODIFIED',
        detail: `[AJUSTADO] +${added.length} linhas, -${removed.length} linhas`,
        added: added.slice(0, 10),
        removed: removed.slice(0, 10)
      });
    } else {
      diff.push({ section, change: 'UNCHANGED', detail: 'Sem alterações' });
    }
  }

  return {
    totalSections: allSections.size,
    modified: diff.filter(d => d.change === 'MODIFIED').length,
    added: diff.filter(d => d.change === 'ADDED').length,
    removed: diff.filter(d => d.change === 'REMOVED').length,
    unchanged: diff.filter(d => d.change === 'UNCHANGED').length,
    sections: diff
  };
}

function parseSections(text) {
  const sections = {};
  const regex = /^(#{1,3}\s+)?(\d{1,2}[\.\s]?\s*.+)/gm;
  let currentSection = 'preamble';
  let currentContent = [];

  for (const line of (text || '').split('\n')) {
    const match = line.match(/^(#{1,3}\s+)?(\d{1,2}[\.\s])/);
    if (match) {
      if (currentContent.length) sections[currentSection] = currentContent.join('\n');
      currentSection = line.trim().substring(0, 80);
      currentContent = [line];
    } else {
      currentContent.push(line);
    }
  }
  if (currentContent.length) sections[currentSection] = currentContent.join('\n');
  return sections;
}


// ═══════════════════════════════════════════════════════════════
// O — DOCUMENTAÇÃO AUTO-PUBLICADA NO ALM
// Anexa artefatos (ADR, Cenários, ZIP) à story no ALM
// ═══════════════════════════════════════════════════════════════

export async function publishToAlm(storyId, artifacts) {
  const results = [];
  for (const art of artifacts) {
    try {
      await pool.query(
        `INSERT INTO alm_artifacts (story_id, artifact_type, artifact_name, artifact_url, content_json, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (story_id, artifact_type) DO UPDATE SET
           artifact_name = EXCLUDED.artifact_name,
           artifact_url = EXCLUDED.artifact_url,
           content_json = EXCLUDED.content_json,
           created_at = NOW()`,
        [storyId, art.type, art.name, art.url || null, art.content ? JSON.stringify(art.content) : null]
      );
      results.push({ type: art.type, ok: true, message: `✅ ${art.type}: ${art.name} publicado no ALM (story ${storyId})` });
    } catch (err) {
      results.push({ type: art.type, ok: false, message: `❌ ${err.message}` });
    }
  }
  return { storyId, total: results.length, published: results.filter(r => r.ok).length, results };
}

// Verifica se alm_artifacts tem as colunas certas, cria constraint se necessário
export async function ensureAlmArtifactsSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alm_artifacts (
        id SERIAL PRIMARY KEY,
        story_id INTEGER NOT NULL,
        artifact_type VARCHAR(50) NOT NULL,
        artifact_name VARCHAR(255),
        artifact_url TEXT,
        content_json JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(story_id, artifact_type)
      )
    `);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
