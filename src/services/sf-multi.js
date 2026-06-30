// src/services/sf-multi.js — Conexão multi-org Salesforce via jsforce
import jsforce from 'jsforce';

// Cache de conexões ativas (evita re-login a cada request)
const connections = {};

export async function connectToOrg(org) {
  const key = org.id || org.username;
  
  // Usar cache se conexão ainda válida
  if (connections[key]) {
    try {
      await connections[key].identity();
      return connections[key];
    } catch {
      delete connections[key];
    }
  }

  const conn = new jsforce.Connection({
    loginUrl: org.login_url,
    version: '62.0',
  });

  await conn.login(org.username, org.password + (org.security_token || ''));
  connections[key] = conn;
  return conn;
}

// Describe objeto em qualquer org
export async function describeObject(org, objectName) {
  const conn = await connectToOrg(org);
  const meta = await conn.describe(objectName);
  return {
    name: meta.name,
    label: meta.label,
    labelPlural: meta.labelPlural,
    keyPrefix: meta.keyPrefix,
    custom: meta.custom,
    queryable: meta.queryable,
    createable: meta.createable,
    updateable: meta.updateable,
    deletable: meta.deletable,
    searchable: meta.searchable,
    fields: meta.fields.map(f => ({
      name: f.name, label: f.label, type: f.type,
      length: f.length, precision: f.precision, scale: f.scale,
      custom: f.custom, unique: f.unique,
      nillable: f.nillable, createable: f.createable, updateable: f.updateable,
      defaultValue: f.defaultValue,
      calculatedFormula: f.calculatedFormula,
      inlineHelpText: f.inlineHelpText,
      referenceTo: f.referenceTo,
      relationshipName: f.relationshipName,
      externalId: f.externalId,
      picklistValues: f.picklistValues && f.picklistValues.length > 0
        ? f.picklistValues.filter(p => p.active).map(p => ({ value: p.value, label: p.label, default: p.defaultValue }))
        : undefined,
    })),
    recordTypeInfos: meta.recordTypeInfos,
    childRelationships: meta.childRelationships ? meta.childRelationships.map(c => ({
      childSObject: c.childSObject, field: c.field, relationshipName: c.relationshipName,
    })) : [],
  };
}

// Executar SOQL em qualquer org
export async function runSoql(org, query) {
  const conn = await connectToOrg(org);
  return await conn.query(query);
}

// Criar metadado em qualquer org
export async function metadataCreate(org, type, metadata) {
  const conn = await connectToOrg(org);
  return await conn.metadata.create(type, metadata);
}

// Ler metadado em qualquer org
export async function metadataRead(org, type, fullName) {
  const conn = await connectToOrg(org);
  return await conn.metadata.read(type, fullName);
}

// Testar conexão com qualquer org
export async function testConnection(org) {
  try {
    const conn = await connectToOrg(org);
    const identity = await conn.identity();
    return {
      status: 'connected',
      orgId: identity.organization_id,
      username: identity.username,
      displayName: identity.display_name,
      instanceUrl: conn.instanceUrl,
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// Deploy campo via metadata.create
export async function deployField(org, field) {
  const conn = await connectToOrg(org);
  const fullName = field.objectName + '.' + field.fieldName;
  const body = { fullName, label: field.label, type: field.type };
  if (field.length) body.length = field.length;
  if (field.precision) body.precision = field.precision;
  if (field.scale) body.scale = field.scale;
  if (field.visibleLines) body.visibleLines = field.visibleLines;
  if (field.referenceTo) body.referenceTo = field.referenceTo;
  if (field.relationshipLabel) body.relationshipLabel = field.relationshipLabel;
  if (field.picklist) {
    body.valueSet = {
      valueSetDefinition: {
        value: field.picklist.map(v => ({ fullName: v, label: v, default: false }))
      }
    };
  }
  const result = await conn.metadata.create('CustomField', body);
  return { component: 'Field: ' + fullName, ...result };
}

// Delete campo (para limpeza de testes)
export async function deleteField(org, fullName) {
  const conn = await connectToOrg(org);
  return await conn.metadata.delete('CustomField', fullName);
}

// Atualizar metadado em qualquer org
export async function metadataUpdate(org, type, metadata) {
  const conn = await connectToOrg(org);
  return await conn.metadata.update(type, metadata);
}

export async function metadataRetrieve(org, types) {
  const conn = await connectToOrg(org);
  const retrieveRequest = {
    apiVersion: '62.0',
    singlePackage: true,
    unpackaged: { types, version: '62.0' }
  };
  const result = await conn.metadata.retrieve(retrieveRequest);
  let status = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    status = await conn.metadata.checkRetrieveStatus(result.id);
    if (status.done === 'true' || status.done === true) break;
  }
  return status;
}
export async function metadataDeployZip(org, zipBase64) {
  const conn = await connectToOrg(org);
  const buf = Buffer.from(zipBase64, 'base64');
  const result = await conn.metadata.deploy(buf, { rollbackOnError: true, singlePackage: true });
  let status = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    status = await conn.metadata.checkDeployStatus(result.id, true);
    if (status.done === 'true' || status.done === true) break;
  }
  return status;
}



// Deletar metadado generico em qualquer org
export async function metadataDelete(org, type, fullName) {
  const conn = await connectToOrg(org);
  return await conn.metadata.delete(type, fullName);
}

// Executar Apex anonimo em qualquer org
export async function executeApex(org, code) {
  const conn = await connectToOrg(org);
  const result = await conn.tooling.executeAnonymous(code);
  return result;
}

// Adicionar/mover campo em layout em qualquer org
export async function moveFieldInLayout(org, layoutName, fieldName, toSectionLabel) {
  const conn = await connectToOrg(org);
  const layout = await conn.metadata.read('Layout', layoutName);
  if (!layout || !layout.fullName) return { status: 'error', message: 'Layout not found' };
  const sections = Array.isArray(layout.layoutSections) ? layout.layoutSections : [layout.layoutSections];
  let fieldItem = null, fromSection = null;
  for (const section of sections) {
    const columns = Array.isArray(section.layoutColumns) ? section.layoutColumns : section.layoutColumns ? [section.layoutColumns] : [];
    for (const col of columns) {
      const items = Array.isArray(col.layoutItems) ? col.layoutItems : col.layoutItems ? [col.layoutItems] : [];
      const idx = items.findIndex(item => item.field === fieldName);
      if (idx >= 0) { fieldItem = items[idx]; fromSection = section.label; items.splice(idx, 1); col.layoutItems = items; break; }
    }
    if (fieldItem) break;
  }
  if (!fieldItem) {
    const addTarget = sections.find(s => s.label === toSectionLabel) || sections[0];
    const addCols = Array.isArray(addTarget.layoutColumns) ? addTarget.layoutColumns : [addTarget.layoutColumns];
    const addCol = addCols[0];
    const newItem = { behavior: 'Edit', field: fieldName };
    if (!addCol.layoutItems) addCol.layoutItems = [newItem];
    else if (Array.isArray(addCol.layoutItems)) addCol.layoutItems.push(newItem);
    else addCol.layoutItems = [addCol.layoutItems, newItem];
    await conn.metadata.update('Layout', layout);
    return { status: 'added', field: fieldName, section: toSectionLabel, success: true };
  }
  const targetSection = sections.find(s => s.label === toSectionLabel) || sections[0];
  const tgtColumns = Array.isArray(targetSection.layoutColumns) ? targetSection.layoutColumns : [targetSection.layoutColumns];
  const tgtItems = Array.isArray(tgtColumns[0].layoutItems) ? tgtColumns[0].layoutItems : tgtColumns[0].layoutItems ? [tgtColumns[0].layoutItems] : [];
  tgtItems.push(fieldItem);
  tgtColumns[0].layoutItems = tgtItems;
  const result = await conn.metadata.update('Layout', layout);
  const item = Array.isArray(result) ? result[0] : result;
  return { status: item?.success ? 'moved' : 'failed', field: fieldName, from: fromSection, to: toSectionLabel, success: item?.success };
}

// Executar Tooling API SOQL em qualquer org (read-only)
export async function runToolingQuery(org, query) {
  const conn = await connectToOrg(org);
  return await conn.tooling.query(query);
}

// Ler layout metadata (read-only)
export async function readLayout(org, fullName) {
  const conn = await connectToOrg(org);
  return await conn.metadata.read('Layout', fullName);
}

// Listar layouts de um objeto via describe
export async function describeLayouts(org, objectName) {
  const conn = await connectToOrg(org);
  const url = `/services/data/v62.0/sobjects/${objectName}/describe/layouts`;
  return await conn.request(url);
}


export async function describeGlobal(org) {
  const conn = await connectToOrg(org);
  const result = await conn.describeGlobal();
  return result;
}

export async function listMetadata(org, type) {
  const conn = await connectToOrg(org);
  const result = await conn.metadata.list([{ type }], conn.version);
  return Array.isArray(result) ? result : (result ? [result] : []);
}

// ── Apex Class deploy via Tooling API (síncrono, rápido) com create-or-update ──
export async function deployApexClass(org, name, body) {
  const conn = await connectToOrg(org);
  return await deployApexTooling(conn, 'ApexClass', name, body);
}

// ── Apex Trigger deploy via Tooling API ──
export async function deployApexTrigger(org, name, body, sobjectType) {
  const conn = await connectToOrg(org);
  // Extract object from trigger body if not provided: "trigger X on Account ("
  let obj = sobjectType;
  if (!obj) {
    const m = (body || '').match(/trigger\s+\w+\s+on\s+(\w+)/i);
    obj = m ? m[1] : null;
  }
  return await deployApexTooling(conn, 'ApexTrigger', name, body, obj);
}

// Deploy Apex via Tooling MetadataContainer (correct way to UPDATE existing Apex)
async function deployApexTooling(conn, metaType, name, body, sobjectType) {
  const memberType = metaType === 'ApexClass' ? 'ApexClassMember' : 'ApexTriggerMember';

  // Check if exists
  const existing = await conn.tooling.query(`SELECT Id FROM ${metaType} WHERE Name = '${name}'`);
  const exists = existing.records && existing.records.length > 0;

  if (!exists) {
    // New — simple create
    try {
      const payload = { Name: name, Body: body };
      // ApexTrigger requires the target object
      if (metaType === 'ApexTrigger') {
        const m = (body || '').match(/trigger\s+\w+\s+on\s+(\w+)/i);
        payload.TableEnumOrId = sobjectType || (m ? m[1] : null);
      }
      const r = await conn.tooling.sobject(metaType).create(payload);
      return { success: r.success !== false, errors: r.errors };
    } catch (e) {
      const msg = e.message || (e.errors ? JSON.stringify(e.errors) : String(e));
      return { success: false, errors: [{ message: msg }] };
    }
  }

  // Exists — update via MetadataContainer
  const containerName = 'i9deploy_' + Date.now();
  let container;
  try {
    container = await conn.tooling.sobject('MetadataContainer').create({ Name: containerName });
    const memberPayload = { MetadataContainerId: container.id, ContentEntityId: existing.records[0].Id, Body: body };
    await conn.tooling.sobject(memberType).create(memberPayload);
    // Deploy the container (async request)
    const asyncReq = await conn.tooling.sobject('ContainerAsyncRequest').create({ MetadataContainerId: container.id, IsCheckOnly: false });
    // Poll for completion (fast for single class)
    let state = 'Queued';
    for (let i = 0; i < 15 && (state === 'Queued' || state === 'InProgress'); i++) {
      await new Promise(r => setTimeout(r, 1000));
      const status = await conn.tooling.query(`SELECT State, ErrorMsg, DeployDetails FROM ContainerAsyncRequest WHERE Id = '${asyncReq.id}'`);
      state = status.records[0].State;
      if (state === 'Completed') { try { await conn.tooling.sobject('MetadataContainer').delete(container.id); } catch {} return { success: true }; }
      if (state === 'Failed' || state === 'Error') {
        const dd = status.records[0].DeployDetails;
        const failures = dd?.componentFailures || [];
        try { await conn.tooling.sobject('MetadataContainer').delete(container.id); } catch {}
        return { success: false, errors: failures.map(f => ({ message: f.problem })) };
      }
    }
    try { await conn.tooling.sobject('MetadataContainer').delete(container.id); } catch {}
    return { success: state === 'Completed' };
  } catch (e) {
    if (container) { try { await conn.tooling.sobject('MetadataContainer').delete(container.id); } catch {} }
    return { success: false, errors: [{ message: e.message || String(e) }] };
  }
}

// ── LWC deploy via Metadata API (LightningComponentBundle) ──
export async function deployLWC(org, name, files) {
  const conn = await connectToOrg(org);
  // files: { html, js, meta, css? }
  const metadata = {
    fullName: name,
    apiVersion: 62.0,
    isExposed: files.isExposed !== false,
    lwcResources: { lwcResource: [] },
  };
  // Build the bundle via metadata.create with the LightningComponentBundle
  // jsforce expects the bundle as a deploy zip; use a simpler approach via metadata
  const bundle = {
    fullName: name,
    metadata: {
      apiVersion: 62.0,
      isExposed: files.isExposed !== false,
      targets: files.targets || undefined,
    },
  };
  // LWC requires zip deploy — return structured data for the deploy
  return await deployLWCBundle(conn, name, files);
}

async function deployLWCBundle(conn, name, files) {
  const archiver = await import('archiver');
  const { PassThrough } = await import('stream');

  const metaXml = files.meta || `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <isExposed>${files.isExposed !== false}</isExposed>
</LightningComponentBundle>`;

  // Build zip buffer
  const zipBuffer = await new Promise((resolve, reject) => {
    const archive = archiver.default('zip');
    const chunks = [];
    const stream = new PassThrough();
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    archive.on('error', reject);
    archive.pipe(stream);
    const base = `lwc/${name}/`;
    archive.append(files.js || '', { name: base + name + '.js' });
    archive.append(files.html || '', { name: base + name + '.html' });
    archive.append(metaXml, { name: base + name + '.js-meta.xml' });
    if (files.css) archive.append(files.css, { name: base + name + '.css' });
    const pkgXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types><members>${name}</members><name>LightningComponentBundle</name></types>
    <version>62.0</version>
</Package>`;
    archive.append(pkgXml, { name: 'package.xml' });
    archive.finalize();
  });

  // Submit deploy and get the deploy ID, then poll via checkDeployStatus (avoids .complete() crash)
  const locator = conn.metadata.deploy(zipBuffer, { singlePackage: true, rollbackOnError: true });
  // Attach error handler to prevent unhandled 'error' event from crashing process
  if (locator && typeof locator.on === 'function') {
    locator.on('error', () => {}); // swallow — we poll manually
  }
  let deployId;
  try {
    const submitted = await locator;
    deployId = submitted.id || submitted.async?.id || submitted;
  } catch (e) {
    return { success: false, errors: [{ message: 'Falha ao submeter deploy: ' + (e.message || String(e)) }] };
  }
  if (!deployId || typeof deployId !== 'string') {
    return { success: false, errors: [{ message: 'Deploy ID inválido' }] };
  }
  // Poll up to ~22s
  for (let i = 0; i < 11; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const status = await conn.metadata.checkDeployStatus(deployId, true);
      if (status.done) {
        if (status.success || status.status === 'Succeeded') return { success: true };
        const failures = status.details?.componentFailures;
        const failArr = failures ? (Array.isArray(failures) ? failures : [failures]) : [];
        return { success: false, errors: failArr.map(f => ({ message: f.problem || f.message })) };
      }
    } catch (e) { /* keep polling */ }
  }
  return { success: false, pending: true, deployId, errors: [{ message: 'Deploy em andamento. ID: ' + deployId }] };
}

// ── Flow deploy via Metadata API ──
export async function deployFlow(org, fullName, flowMetadata) {
  const conn = await connectToOrg(org);
  // flowMetadata is the Flow metadata object (or XML)
  const result = await conn.metadata.create('Flow', { fullName, ...flowMetadata });
  return result;
}

export async function deleteApexClass(org, name) {
  const conn = await connectToOrg(org);
  const r = await conn.tooling.query(`SELECT Id FROM ApexClass WHERE Name = '${name}'`);
  if (r.records && r.records.length > 0) {
    await conn.tooling.sobject('ApexClass').delete(r.records[0].Id);
    return { success: true };
  }
  return { success: false, message: 'não encontrado' };
}

export async function deleteApexTrigger(org, name) {
  const conn = await connectToOrg(org);
  const r = await conn.tooling.query(`SELECT Id FROM ApexTrigger WHERE Name = '${name}'`);
  if (r.records && r.records.length > 0) {
    await conn.tooling.sobject('ApexTrigger').delete(r.records[0].Id);
    return { success: true };
  }
  return { success: false, message: 'não encontrado' };
}

// ── Snapshot readers (for rollback) — read current state before update ──
export async function readApexBody(org, name, type = 'ApexClass') {
  const conn = await connectToOrg(org);
  const q = await conn.tooling.query(`SELECT Id, Body FROM ${type} WHERE Name = '${name}'`);
  if (q.records && q.records.length > 0) return { exists: true, body: q.records[0].Body, id: q.records[0].Id };
  return { exists: false };
}

export async function readLWCBundleFiles(org, name) {
  const conn = await connectToOrg(org);
  const bundle = await conn.tooling.query(`SELECT Id FROM LightningComponentBundle WHERE DeveloperName = '${name}'`);
  if (!bundle.records || !bundle.records.length) return { exists: false };
  const bundleId = bundle.records[0].Id;
  const resources = await conn.tooling.query(`SELECT FilePath, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '${bundleId}'`);
  const files = {};
  for (const r of (resources.records || [])) {
    const path = r.FilePath || '';
    if (path.endsWith('.html')) files.html = r.Source;
    else if (path.endsWith('.js') && !path.endsWith('-meta.xml')) files.js = r.Source;
    else if (path.endsWith('.js-meta.xml')) files.meta = r.Source;
    else if (path.endsWith('.css')) files.css = r.Source;
  }
  return { exists: true, files };
}

// === Grupo 2: Layout add field e Profile FLS (ADITIVO) ===

/**
 * Adiciona um campo a uma seção específica de um Page Layout.
 * @param {Object} org - org connection
 * @param {string} layoutName - ex: "Account-Account Layout Nacional PJ"
 * @param {string} fieldName - API name do campo
 * @param {string} sectionLabel - label da seção destino
 * @param {string} behavior - 'Required'|'Edit'|'Readonly' (default: 'Edit')
 */
export async function addFieldToLayout(org, layoutName, fieldName, sectionLabel, behavior = 'Edit') {
  const conn = org.connection;
  const layout = await conn.metadata.read('Layout', layoutName);
  if (!layout || !layout.fullName) return { status: 'error', message: 'Layout not found: ' + layoutName };

  if (!Array.isArray(layout.layoutSections)) layout.layoutSections = [layout.layoutSections].filter(Boolean);

  const section = layout.layoutSections.find(s => s.label === sectionLabel);
  if (!section) {
    return { status: 'error', message: 'Section not found: ' + sectionLabel + '. Available: ' + layout.layoutSections.map(s => s.label).join(', ') };
  }

  if (!Array.isArray(section.layoutColumns)) section.layoutColumns = [section.layoutColumns].filter(Boolean);
  if (!section.layoutColumns.length) section.layoutColumns = [{ layoutItems: [] }];

  // Verifica se o campo já está em alguma coluna desta seção
  const exists = section.layoutColumns.some(col => {
    if (!col.layoutItems) return false;
    const items = Array.isArray(col.layoutItems) ? col.layoutItems : [col.layoutItems];
    return items.some(it => it.field === fieldName);
  });
  if (exists) return { status: 'exists', message: 'Field already in section' };

  // Adiciona à primeira coluna
  const col0 = section.layoutColumns[0];
  if (!col0.layoutItems) col0.layoutItems = [];
  if (!Array.isArray(col0.layoutItems)) col0.layoutItems = [col0.layoutItems];
  col0.layoutItems.push({ field: fieldName, behavior });

  const result = await conn.metadata.update('Layout', layout);
  return { status: 'success', result, message: 'Field added to layout section' };
}

/**
 * Atualiza FLS de um Profile.
 * @param {Object} org - org connection
 * @param {string} profileName - ex: "Profile_Comercial_Base"
 * @param {Array} fieldPermissions - [{ field: 'Object.Field__c', editable: true, readable: true }]
 * @param {Array} objectPermissions - [{ object, allowCreate, allowRead, allowEdit, allowDelete, viewAllRecords, modifyAllRecords }]
 */
export async function updateProfileFLS(org, profileName, fieldPermissions = [], objectPermissions = []) {
  const conn = org.connection;
  const profile = await conn.metadata.read('Profile', profileName);
  if (!profile || !profile.fullName) return { status: 'error', message: 'Profile not found: ' + profileName };

  // FLS
  if (fieldPermissions.length) {
    let existingFP = profile.fieldPermissions || [];
    if (!Array.isArray(existingFP)) existingFP = [existingFP].filter(Boolean);
    const fpMap = new Map(existingFP.map(fp => [fp.field, fp]));
    for (const fp of fieldPermissions) {
      fpMap.set(fp.field, { field: fp.field, editable: fp.editable, readable: fp.readable });
    }
    profile.fieldPermissions = Array.from(fpMap.values());
  }

  // Object permissions
  if (objectPermissions.length) {
    let existingOP = profile.objectPermissions || [];
    if (!Array.isArray(existingOP)) existingOP = [existingOP].filter(Boolean);
    const opMap = new Map(existingOP.map(op => [op.object, op]));
    for (const op of objectPermissions) {
      opMap.set(op.object, op);
    }
    profile.objectPermissions = Array.from(opMap.values());
  }

  const result = await conn.metadata.update('Profile', profile);
  return { status: 'success', result, fieldsUpdated: fieldPermissions.length, objectsUpdated: objectPermissions.length };
}

/**
 * Ativa Matching Rule ou Duplicate Rule via Tooling API.
 */
export async function activateRule(org, ruleType, ruleName, activate = true) {
  const conn = await connectToOrg(org);
  if (ruleType === 'MatchingRule') {
    // Se ruleName contém '.', usar direto; senão buscar via Tooling
    let fullName = ruleName;
    if (!ruleName.includes('.')) {
      const result = await conn.tooling.sobject('MatchingRule').find({ DeveloperName: ruleName });
      if (!result.length) return { status: 'error', message: 'Matching Rule not found: ' + ruleName };
      fullName = `${result[0].SobjectType}.${ruleName}`;
    }
    const rule = await conn.metadata.read('MatchingRule', fullName);
    if (!rule || !rule.fullName) return { status: 'error', message: 'Matching Rule metadata not found: ' + fullName };
    rule.ruleStatus = activate ? 'Active' : 'Inactive';
    const r = await conn.metadata.update('MatchingRule', rule);
    return { status: 'success', result: r, message: `${activate ? 'Ativada' : 'Desativada'}: ${fullName}` };
  }
  if (ruleType === 'DuplicateRule') {
    const rule = await conn.metadata.read('DuplicateRule', ruleName);
    if (!rule || !rule.fullName) return { status: 'error', message: 'Duplicate Rule not found: ' + ruleName };
    rule.isActive = activate;
    const r = await conn.metadata.update('DuplicateRule', rule);
    return { status: 'success', result: r, message: `${activate ? 'Ativada' : 'Desativada'}: ${ruleName}` };
  }
  return { status: 'error', message: 'Unknown rule type: ' + ruleType };
}

// Insert múltiplos registros via REST sobjects/composite
export async function insertRecords(org, objectName, records) {
  const conn = await connectToOrg(org);
  if (!Array.isArray(records) || !records.length) return { results: [] };
  // Usar conn.sobject().create() que aceita array
  try {
    const results = await conn.sobject(objectName).create(records, { allOrNone: false });
    const arr = Array.isArray(results) ? results : [results];
    return { results: arr };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// Diagnóstico: IP de saída do dyno
import https from 'https';
export async function getOutboundIP() {
  return new Promise((resolve) => {
    https.get('https://api.ipify.org?format=json', (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body).ip); } catch { resolve('unknown'); } });
    }).on('error', () => resolve('error'));
  });
}
