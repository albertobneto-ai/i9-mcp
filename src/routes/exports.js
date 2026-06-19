// src/routes/exports.js
// Gera package.xml + sfdx-project.json + README empacotados em ZIP
// a partir do deploy_log de uma US. Importável no VS Code via SFDX CLI.
// 100% aditivo — não toca em nada existente. Falhas isoladas em try/catch.

import express from 'express';
import archiver from 'archiver';
import pool from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// ── Mapeamento: action do deploy_log → Metadata Type do package.xml ──
const ACTION_TO_TYPE = {
  'create-field': 'CustomField',
  'delete-field': 'CustomField',
  'create-object': 'CustomObject',
  'create-layout': 'Layout',
  'layout-add-field': 'Layout',
  'assign-layout': 'Profile',
  'profile-fls': 'Profile',
  'ps-fls': 'PermissionSet',
  'assign-custom-permission': 'PermissionSet',
  'enable-field-history': 'CustomObject',
  'apex-class': 'ApexClass',
  'apex-trigger': 'ApexTrigger',
  'lwc': 'LightningComponentBundle',
  'flow': 'Flow',
};

// Actions que NÃO vão pro package.xml (não são metadata)
const SKIP_ACTIONS = new Set([
  'apex', 'soql', 'validate', 'manual-step', 'runbook',
  'assign-ps-to-user', 'rollback-restore',
]);

// Tenta extrair o Metadata Type para os casos genéricos
function inferType(row) {
  const { action, component, result_message } = row;
  if (SKIP_ACTIONS.has(action)) return null;
  if (ACTION_TO_TYPE[action]) return ACTION_TO_TYPE[action];

  // metadata-create/update/delete — tipo pode vir no result_message
  if (action && action.startsWith('metadata-')) {
    const msg = result_message || '';
    const m = msg.match(/type[:\s"]+([A-Za-z]+)/i);
    if (m) return m[1];
    // Heurística por nome do componente
    if (/^MR_/i.test(component) || /matching/i.test(msg)) return 'MatchingRule';
    if (/^DR_/i.test(component) || /duplicate/i.test(msg)) return 'DuplicateRule';
    if (/^VR_/i.test(component)) return 'ValidationRule';
    if (/^RT_/i.test(component)) return 'RecordType';
    return null;
  }

  if (action === 'activate-rule') {
    if (/matching/i.test(result_message || '') || /^MR_/i.test(component)) return 'MatchingRule';
    if (/duplicate/i.test(result_message || '') || /^DR_/i.test(component)) return 'DuplicateRule';
    return null;
  }

  return null;
}

// Resolve o fullName conforme padrão do tipo
function resolveFullName(type, component) {
  if (!component) return null;
  // Tipos que já vêm com Object.Field
  if (['CustomField', 'ValidationRule', 'RecordType'].includes(type)) {
    return component.includes('.') ? component : component;
  }
  // MatchingRule / DuplicateRule: padrão é Object.RuleName
  if (['MatchingRule', 'DuplicateRule'].includes(type) && !component.includes('.')) {
    // se o nome começa com MR_/DR_ e tem objeto embutido, tentamos extrair
    const m = component.match(/^[MD]R_([A-Za-z]+)_/);
    if (m) return `${m[1]}.${component}`;
    return component;
  }
  return component;
}

function buildPackageXml(groups) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
  ];
  // Ordem alfabética por tipo (convenção SFDX)
  for (const type of Object.keys(groups).sort()) {
    const members = [...new Set(groups[type])].sort();
    if (!members.length) continue;
    lines.push('    <types>');
    for (const m of members) lines.push(`        <members>${escapeXml(m)}</members>`);
    lines.push(`        <name>${type}</name>`);
    lines.push('    </types>');
  }
  lines.push('    <version>62.0</version>');
  lines.push('</Package>');
  return lines.join('\n') + '\n';
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

function buildReadme(us, orgAlias, instanceUrl, summary) {
  return [
    `# Export ${us}`,
    '',
    `Pacote gerado pelo SF Agent DevOps a partir do \`deploy_log\` da US **${us}**.`,
    `Conteúdo pronto para importar no VS Code com a extensão Salesforce.`,
    '',
    '## Conteúdo',
    '',
    summary.length
      ? summary.map(s => `- **${s.type}**: ${s.count} componente(s)`).join('\n')
      : '_Nenhum componente exportável encontrado._',
    '',
    '## Como usar no VS Code',
    '',
    '### 1. Autorize a org (uma vez por máquina)',
    '```bash',
    `sf org login web --alias ${orgAlias} --instance-url ${instanceUrl}`,
    '```',
    '',
    '### 2. Faça o retrieve dos componentes',
    '```bash',
    `sf project retrieve start --manifest manifest/package.xml --target-org ${orgAlias}`,
    '```',
    '',
    'Após o retrieve, os fontes ficam em `force-app/main/default/`',
    'e podem ser abertos/editados normalmente no VS Code.',
    '',
    '## Notas',
    '',
    '- Componentes marcados como `apex`, `soql`, `manual-step`, `assign-ps-to-user` ',
    '  não entram no package.xml por não serem metadados versionáveis.',
    '- Se algum `fullName` ficou incompleto (sem `Object.`), edite o `package.xml`',
    '  antes de rodar o retrieve.',
    '- Para devolver mudanças locais à org: `sf project deploy start --manifest manifest/package.xml --target-org ' + orgAlias + '`',
    '',
  ].join('\n');
}

function buildSfdxProjectJson(us) {
  return JSON.stringify({
    packageDirectories: [{ path: 'force-app', default: true }],
    name: `sf-agent-export-${us.toLowerCase()}`,
    namespace: '',
    sfdcLoginUrl: 'https://test.salesforce.com',
    sourceApiVersion: '62.0',
  }, null, 2);
}

// ── GET /api/exports/package/:us  → stream ZIP ──
router.get('/package/:us', authMiddleware, async (req, res) => {
  const us = String(req.params.us || '').toUpperCase().trim();
  if (!us) return res.status(400).json({ error: 'US obrigatória' });

  try {
    // Buscar componentes deployados com sucesso para essa US
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (component, action) component, action, result_message, org_name
       FROM deploy_log
       WHERE UPPER(us_number) = $1
         AND result IN ('success', 'exists')
       ORDER BY component, action, created_at DESC`,
      [us]
    );

    // Agrupar por tipo de metadata
    const groups = {};
    const summary = [];
    let orgName = 'arqevery';
    for (const row of rows) {
      if (row.org_name) orgName = row.org_name;
      const type = inferType(row);
      if (!type) continue;
      const fullName = resolveFullName(type, row.component);
      if (!fullName) continue;
      groups[type] = groups[type] || [];
      groups[type].push(fullName);
    }
    for (const type of Object.keys(groups).sort()) {
      summary.push({ type, count: new Set(groups[type]).size });
    }

    const orgAlias = orgName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'arqevery';
    const instanceUrl = 'https://test.salesforce.com';
    const packageXml = buildPackageXml(groups);
    const readme = buildReadme(us, orgAlias, instanceUrl, summary);
    const projectJson = buildSfdxProjectJson(us);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${us}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('[exports] archive error:', err.message);
      try { res.status(500).end(); } catch {}
    });
    archive.pipe(res);
    archive.append(packageXml, { name: `${us}/manifest/package.xml` });
    archive.append(readme, { name: `${us}/README.md` });
    archive.append(projectJson, { name: `${us}/sfdx-project.json` });
    // Diretório force-app vazio pra extension reconhecer o projeto
    archive.append('', { name: `${us}/force-app/main/default/.gitkeep` });
    await archive.finalize();
  } catch (err) {
    console.error('[exports] erro:', err.message);
    try { res.status(500).json({ error: 'Falha ao gerar export', detail: err.message }); } catch {}
  }
});

// ── GET /api/exports/preview/:us  → JSON com resumo (pro chat mostrar) ──
router.get('/preview/:us', authMiddleware, async (req, res) => {
  const us = String(req.params.us || '').toUpperCase().trim();
  if (!us) return res.status(400).json({ error: 'US obrigatória' });

  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (component, action) component, action, result_message
       FROM deploy_log
       WHERE UPPER(us_number) = $1
         AND result IN ('success', 'exists')
       ORDER BY component, action, created_at DESC`,
      [us]
    );

    const groups = {};
    let skipped = 0;
    for (const row of rows) {
      const type = inferType(row);
      if (!type) { skipped++; continue; }
      const fullName = resolveFullName(type, row.component);
      if (!fullName) continue;
      groups[type] = groups[type] || new Set();
      groups[type].add(fullName);
    }
    const summary = Object.keys(groups).sort().map(type => ({
      type,
      count: groups[type].size,
      members: [...groups[type]].sort(),
    }));

    res.json({
      us,
      total: rows.length,
      exportable: summary.reduce((s, g) => s + g.count, 0),
      skipped,
      groups: summary,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
