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

// ── Apex Class deploy via Tooling API ──
export async function deployApexClass(org, name, body) {
  const conn = await connectToOrg(org);
  // Check if exists
  const existing = await conn.tooling.query(`SELECT Id FROM ApexClass WHERE Name = '${name}'`);
  if (existing.records && existing.records.length > 0) {
    // Update via MetadataContainer (Tooling) — delete + recreate is simpler for Dev
    const id = existing.records[0].Id;
    await conn.tooling.sobject('ApexClass').delete(id);
  }
  const result = await conn.tooling.sobject('ApexClass').create({ Name: name, Body: body });
  return result;
}

// ── Apex Trigger deploy via Tooling API ──
export async function deployApexTrigger(org, name, body) {
  const conn = await connectToOrg(org);
  const existing = await conn.tooling.query(`SELECT Id FROM ApexTrigger WHERE Name = '${name}'`);
  if (existing.records && existing.records.length > 0) {
    await conn.tooling.sobject('ApexTrigger').delete(existing.records[0].Id);
  }
  const result = await conn.tooling.sobject('ApexTrigger').create({ Name: name, Body: body });
  return result;
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
  // Use Metadata API deploy with a zip containing the LWC bundle
  const archiver = await import('archiver');
  const { PassThrough } = await import('stream');

  const metaXml = files.meta || `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <isExposed>${files.isExposed !== false}</isExposed>
</LightningComponentBundle>`;

  return new Promise((resolve, reject) => {
    const archive = archiver.default('zip');
    const chunks = [];
    const stream = new PassThrough();
    stream.on('data', c => chunks.push(c));
    stream.on('end', async () => {
      const zipBuffer = Buffer.concat(chunks);
      try {
        const result = await conn.metadata.deploy(zipBuffer, { singlePackage: true }).complete({ details: true });
        resolve(result);
      } catch (e) { reject(e); }
    });
    archive.pipe(stream);
    const base = `lwc/${name}/`;
    archive.append(files.js || '', { name: base + name + '.js' });
    archive.append(files.html || '', { name: base + name + '.html' });
    archive.append(metaXml, { name: base + name + '.js-meta.xml' });
    if (files.css) archive.append(files.css, { name: base + name + '.css' });
    // package.xml
    const pkgXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types><members>${name}</members><name>LightningComponentBundle</name></types>
    <version>62.0</version>
</Package>`;
    archive.append(pkgXml, { name: 'package.xml' });
    archive.finalize();
  });
}

// ── Flow deploy via Metadata API ──
export async function deployFlow(org, fullName, flowMetadata) {
  const conn = await connectToOrg(org);
  // flowMetadata is the Flow metadata object (or XML)
  const result = await conn.metadata.create('Flow', { fullName, ...flowMetadata });
  return result;
}
