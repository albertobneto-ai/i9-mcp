// src/routes/agent-builder.js — F3: Agent Builder
// Endpoints for scanning, creating and managing Agentforce agents
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { connectToOrg } from '../services/sf-multi.js';
import pool from '../config/db.js';

const router = express.Router();

async function getOrgById(id) {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function q(conn, soql, isTooling = false) {
  try {
    const result = isTooling ? await conn.tooling.query(soql) : await conn.query(soql);
    return { ok: true, totalSize: result.totalSize, records: result.records || [] };
  } catch (e) { return { ok: false, error: e.message?.substring(0, 150) }; }
}

async function metaList(conn, typeName) {
  try {
    const result = await conn.metadata.list([{ type: typeName }]);
    const items = Array.isArray(result) ? result : result ? [result] : [];
    return { ok: true, totalSize: items.length, records: items };
  } catch (e) { return { ok: false, error: e.message?.substring(0, 150) }; }
}

async function metaCreate(conn, type, body) {
  try {
    const result = await conn.metadata.create(type, body);
    const results = Array.isArray(result) ? result : [result];
    const success = results.every(r => r.success);
    const errors = results.filter(r => !r.success).map(r => r.errors?.message || r.errors?.statusCode || 'unknown');
    return success ? { ok: true, message: `${type}: ${body.fullName}` } : { ok: false, error: errors.join('; ') };
  } catch (e) { return { ok: false, error: e.message?.substring(0, 150) }; }
}

async function metaUpdate(conn, type, body) {
  try {
    const result = await conn.metadata.update(type, body);
    const results = Array.isArray(result) ? result : [result];
    const success = results.every(r => r.success);
    const errors = results.filter(r => !r.success).map(r => r.errors?.message || r.errors?.statusCode || 'unknown');
    return success ? { ok: true, message: `${type}: ${body.fullName} updated` } : { ok: false, error: errors.join('; ') };
  } catch (e) { return { ok: false, error: e.message?.substring(0, 150) }; }
}

// ══════════════════════════════════════════════
// CHECK STANDARD ACTIONS
// ══════════════════════════════════════════════
// GET /api/orgs/:id/agent-builder/check-standard
router.get('/:id/agent-builder/check-standard', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const conn = await connectToOrg(org);

    // Standard actions are built-in and don't appear as GenAiFunction
    // List what's custom vs what's available OOTB
    const customActions = await metaList(conn, 'GenAiFunction');
    const customPlugins = await metaList(conn, 'GenAiPlugin');

    // Invocable Flows (potential action backends)
    const invocableFlows = await q(conn,
      "SELECT Id, Definition.DeveloperName, ProcessType, Status FROM Flow WHERE ProcessType = 'AutoLaunchedFlow' AND Status = 'Active' LIMIT 200", true);

    // Invocable Apex
    const apexResult = await q(conn,
      "SELECT Id, Name, Body FROM ApexClass WHERE Status = 'Active' AND NamespacePrefix = null LIMIT 500", true);
    let invocableApex = { ok: false };
    if (apexResult.ok) {
      const filtered = apexResult.records.filter(c => c.Body && c.Body.includes('@InvocableMethod')).map(c => ({ Id: c.Id, Name: c.Name }));
      invocableApex = { ok: true, totalSize: filtered.length, records: filtered };
    }

    res.json({
      org: { id: org.id, name: org.name },
      standardActions: {
        note: 'Standard actions (Query Records, Get Record Details, Create Record, Update Record, Send Email, Draft Email, Summarize Record) are built-in and always available. They do not appear as GenAiFunction metadata.',
        available: ['Query Records', 'Get Record Details', 'Create Record', 'Update Record', 'Delete Record', 'Send Email', 'Draft Email', 'Summarize Record', 'Answer Questions with Knowledge']
      },
      customActions: customActions,
      customPlugins: customPlugins,
      availableFlowBackends: invocableFlows,
      availableApexBackends: invocableApex
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// CREATE ACTIONS (Flows + GenAiFunction)
// ══════════════════════════════════════════════
// POST /api/orgs/:id/agent-builder/create-actions
// Body: { actions: [{ name, label, description, flowName, flowXml }] }
router.post('/:id/agent-builder/create-actions', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    if (org.read_only) return res.status(403).json({ error: 'Org is read-only' });
    const conn = await connectToOrg(org);
    const { actions } = req.body;
    if (!actions || !Array.isArray(actions)) return res.status(400).json({ error: 'actions array required' });

    const results = [];

    for (const action of actions) {
      // Step 1: Deploy Flow if flowXml provided
      if (action.flowXml) {
        try {
          const zipFiles = [
            { path: 'package.xml', content: `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types><members>${action.flowName}</members><name>Flow</name></types>\n  <version>62.0</version>\n</Package>` },
            { path: `flows/${action.flowName}.flow-meta.xml`, content: action.flowXml }
          ];
          // Use the existing deploy mechanism from sf-multi
          const { deployMetadataZip } = await import('../services/sf-multi.js');
          if (typeof deployMetadataZip === 'function') {
            await deployMetadataZip(conn, zipFiles);
            results.push({ step: 'flow', name: action.flowName, ok: true });
          } else {
            results.push({ step: 'flow', name: action.flowName, ok: false, error: 'deployMetadataZip not available — deploy flow manually' });
          }
        } catch (e) {
          results.push({ step: 'flow', name: action.flowName, ok: false, error: e.message?.substring(0, 100) });
        }
      }

      // Step 2: Create GenAiFunction
      const funcResult = await metaCreate(conn, 'GenAiFunction', {
        fullName: action.name,
        masterLabel: action.label,
        description: action.description,
        invocationTarget: action.flowName || action.apexName,
        invocationTargetType: action.flowName ? 'flow' : 'apex'
      });
      results.push({ step: 'action', name: action.name, ...funcResult });
    }

    res.json({ org: { id: org.id, name: org.name }, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// CREATE TOPIC (GenAiPlugin)
// ══════════════════════════════════════════════
// POST /api/orgs/:id/agent-builder/create-topic
// Body: { name, label, description, scope, language, actions[], instructions[], utterances[] }
router.post('/:id/agent-builder/create-topic', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    if (org.read_only) return res.status(403).json({ error: 'Org is read-only' });
    const conn = await connectToOrg(org);

    const { name, label, description, scope, language, actions, instructions, utterances } = req.body;
    if (!name || !label) return res.status(400).json({ error: 'name and label required' });

    const body = {
      fullName: name,
      developerName: name,
      masterLabel: label,
      description: description || '',
      pluginType: 'Topic',
      language: language || 'pt_BR',
      scope: scope || ''
    };

    if (actions && actions.length > 0) {
      body.genAiFunctions = actions.map(a => ({ functionName: a }));
    }

    if (instructions && instructions.length > 0) {
      body.genAiPluginInstructions = instructions.map((inst, i) => ({
        developerName: `instruction_${i + 1}`,
        masterLabel: `Instruction ${i + 1}`,
        description: inst
      }));
    }

    if (utterances && utterances.length > 0) {
      body.aiPluginUtterances = utterances.map((utt, i) => ({
        developerName: `utt_${i + 1}`,
        masterLabel: `Utterance ${i + 1}`,
        utterance: utt
      }));
    }

    const result = await metaCreate(conn, 'GenAiPlugin', body);
    res.json({ org: { id: org.id, name: org.name }, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// LINK TOPIC TO PLANNER
// ══════════════════════════════════════════════
// POST /api/orgs/:id/agent-builder/link-topic
// Body: { plannerName, pluginName }
router.post('/:id/agent-builder/link-topic', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    if (org.read_only) return res.status(403).json({ error: 'Org is read-only' });
    const conn = await connectToOrg(org);

    const { plannerName, pluginName } = req.body;
    if (!plannerName || !pluginName) return res.status(400).json({ error: 'plannerName and pluginName required' });

    // Read current planner to get existing plugins
    let existingPlugins = [];
    try {
      const current = await conn.metadata.read('GenAiPlanner', plannerName);
      if (current && current.genAiPlugins) {
        const plugins = Array.isArray(current.genAiPlugins) ? current.genAiPlugins : [current.genAiPlugins];
        existingPlugins = plugins.map(p => p.genAiPluginName).filter(Boolean);
      }
    } catch (e) { /* planner might not have plugins yet */ }

    // Add new plugin if not already linked
    if (!existingPlugins.includes(pluginName)) {
      existingPlugins.push(pluginName);
    }

    const result = await metaUpdate(conn, 'GenAiPlanner', {
      fullName: plannerName,
      genAiPlugins: existingPlugins.map(p => ({ genAiPluginName: p }))
    });

    res.json({ org: { id: org.id, name: org.name }, ...result, plugins: existingPlugins });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// REMOVE ACTION FROM TOPIC
// ══════════════════════════════════════════════
// POST /api/orgs/:id/agent-builder/remove-action
// Body: { pluginName, actionName }
router.post('/:id/agent-builder/remove-action', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    if (org.read_only) return res.status(403).json({ error: 'Org is read-only' });
    const conn = await connectToOrg(org);

    const { pluginName, actionName } = req.body;
    if (!pluginName || !actionName) return res.status(400).json({ error: 'pluginName and actionName required' });

    // Read current plugin
    const current = await conn.metadata.read('GenAiPlugin', pluginName);
    if (!current || !current.fullName) return res.status(404).json({ error: 'Plugin not found' });

    let functions = current.genAiFunctions || [];
    if (!Array.isArray(functions)) functions = [functions];
    const remaining = functions.filter(f => f.functionName !== actionName);

    const result = await metaUpdate(conn, 'GenAiPlugin', {
      fullName: pluginName,
      genAiFunctions: remaining
    });

    res.json({
      org: { id: org.id, name: org.name },
      ...result,
      removed: actionName,
      remainingActions: remaining.map(f => f.functionName)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// SCAN AGENT (detailed raio-x of a single agent)
// ══════════════════════════════════════════════
// GET /api/orgs/:id/agent-builder/scan/:agentName
router.get('/:id/agent-builder/scan/:agentName', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const conn = await connectToOrg(org);
    const agentName = req.params.agentName;

    // Read Bot metadata
    let bot = {};
    try {
      bot = await conn.metadata.read('Bot', agentName);
    } catch (e) { return res.status(404).json({ error: `Agent ${agentName} not found` }); }

    if (!bot || !bot.fullName) return res.status(404).json({ error: `Agent ${agentName} not found` });

    const result = {
      org: { id: org.id, name: org.name },
      agent: {
        developerName: bot.fullName,
        label: bot.label,
        agentType: bot.agentType,
        type: bot.type,
        description: bot.description
      },
      versions: []
    };

    // Parse versions
    let versions = bot.botVersions || [];
    if (!Array.isArray(versions)) versions = [versions];

    for (const v of versions) {
      const vData = {
        fullName: v.fullName,
        tone: v.toneType,
        language: v.copilotPrimaryLanguage,
        role: v.role,
        entryDialog: v.entryDialog,
        planners: [],
        dialogs: []
      };

      // Planners
      let cdp = v.conversationDefinitionPlanners;
      if (cdp) {
        if (!Array.isArray(cdp)) cdp = [cdp];
        for (const p of cdp) {
          const plannerName = p.genAiPlannerName;
          const plannerData = { name: plannerName, plugins: [], actions: [] };

          // Read planner
          try {
            const planner = await conn.metadata.read('GenAiPlanner', plannerName);
            if (planner && planner.fullName) {
              plannerData.description = planner.description;
              plannerData.plannerType = planner.plannerType;

              // Plugins
              let plugins = planner.genAiPlugins || [];
              if (!Array.isArray(plugins)) plugins = [plugins];
              for (const pl of plugins) {
                const pluginName = pl.genAiPluginName;
                try {
                  const plugin = await conn.metadata.read('GenAiPlugin', pluginName);
                  if (plugin && plugin.fullName) {
                    let funcs = plugin.genAiFunctions || [];
                    if (!Array.isArray(funcs)) funcs = [funcs];
                    plannerData.plugins.push({
                      name: plugin.fullName,
                      label: plugin.masterLabel,
                      scope: plugin.scope,
                      actions: funcs.map(f => f.functionName)
                    });
                    // Collect all actions
                    for (const f of funcs) {
                      plannerData.actions.push(f.functionName);
                    }
                  }
                } catch (e) { /* plugin read failed */ }
              }
            }
          } catch (e) { /* planner read failed */ }

          vData.planners.push(plannerData);
        }
      }

      // Dialogs
      let dialogs = v.botDialogs || [];
      if (!Array.isArray(dialogs)) dialogs = [dialogs];
      vData.dialogs = dialogs.map(d => ({
        name: d.developerName,
        label: d.label
      }));

      result.versions.push(vData);
    }

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
