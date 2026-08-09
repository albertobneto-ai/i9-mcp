// src/routes/org-compare.js — F2: Cross-Org Diff
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { connectToOrg } from '../services/sf-multi.js';
import pool from '../config/db.js';

const router = express.Router();

async function getOrgById(id) {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// Safe query
async function q(conn, soql, isTooling = false) {
  try {
    const result = isTooling ? await conn.tooling.query(soql) : await conn.query(soql);
    return { ok: true, totalSize: result.totalSize, records: result.records || [] };
  } catch (e) { return { ok: false, error: e.message?.substring(0, 150) }; }
}

// ══════════════════════════════════════════════
// DIFF HELPERS
// ══════════════════════════════════════════════

function diffByKey(sourceRecords, targetRecords, keyFn, compareFn) {
  const sourceMap = new Map();
  const targetMap = new Map();
  for (const r of sourceRecords) sourceMap.set(keyFn(r), r);
  for (const r of targetRecords) targetMap.set(keyFn(r), r);

  const results = { match: [], diverge: [], onlySource: [], onlyTarget: [] };

  for (const [key, srcRec] of sourceMap) {
    const tgtRec = targetMap.get(key);
    if (!tgtRec) {
      results.onlySource.push({ key, record: srcRec });
    } else if (compareFn && !compareFn(srcRec, tgtRec)) {
      results.diverge.push({ key, source: srcRec, target: tgtRec });
    } else {
      results.match.push({ key });
    }
  }

  for (const [key] of targetMap) {
    if (!sourceMap.has(key)) {
      results.onlyTarget.push({ key, record: targetMap.get(key) });
    }
  }

  results.summary = {
    total: sourceMap.size + results.onlyTarget.length,
    match: results.match.length,
    diverge: results.diverge.length,
    onlySource: results.onlySource.length,
    onlyTarget: results.onlyTarget.length
  };

  return results;
}

// ══════════════════════════════════════════════
// SCOPE COMPARATORS
// ══════════════════════════════════════════════

async function compareObjects(srcConn, tgtConn) {
  const r = {};

  // Custom Objects
  const srcObjs = await q(srcConn, "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE QualifiedApiName LIKE '%__c' AND IsCustomSetting = false AND PublisherId = '<local>' ORDER BY QualifiedApiName LIMIT 200");
  const tgtObjs = await q(tgtConn, "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE QualifiedApiName LIKE '%__c' AND IsCustomSetting = false AND PublisherId = '<local>' ORDER BY QualifiedApiName LIMIT 200");
  if (srcObjs.ok && tgtObjs.ok) {
    r.customObjects = diffByKey(srcObjs.records, tgtObjs.records, rec => rec.QualifiedApiName);
  }

  // Custom Fields per key object
  const keyObjects = ['Lead', 'Account', 'Contact', 'Opportunity', 'Case'];
  for (const obj of keyObjects) {
    const srcFields = await q(srcConn, `SELECT QualifiedApiName, DataType, Label FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${obj}' AND IsCustom = true ORDER BY QualifiedApiName LIMIT 200`);
    const tgtFields = await q(tgtConn, `SELECT QualifiedApiName, DataType, Label FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${obj}' AND IsCustom = true ORDER BY QualifiedApiName LIMIT 200`);
    if (srcFields.ok && tgtFields.ok) {
      r['fields_' + obj] = diffByKey(srcFields.records, tgtFields.records,
        rec => rec.QualifiedApiName,
        (s, t) => s.DataType === t.DataType
      );
    } else {
      r['fields_' + obj] = { error: (srcFields.error || '') + ' / ' + (tgtFields.error || '') };
    }
  }

  // Record Types
  const srcRTs = await q(srcConn, "SELECT SobjectType, DeveloperName, Name, IsActive FROM RecordType WHERE IsActive = true ORDER BY SobjectType, DeveloperName LIMIT 200");
  const tgtRTs = await q(tgtConn, "SELECT SobjectType, DeveloperName, Name, IsActive FROM RecordType WHERE IsActive = true ORDER BY SobjectType, DeveloperName LIMIT 200");
  if (srcRTs.ok && tgtRTs.ok) {
    r.recordTypes = diffByKey(srcRTs.records, tgtRTs.records,
      rec => rec.SobjectType + '.' + rec.DeveloperName);
  }

  return r;
}

async function compareSecurity(srcConn, tgtConn) {
  const r = {};

  // Permission Sets
  const srcPS = await q(srcConn, "SELECT Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false AND NamespacePrefix = null ORDER BY Label LIMIT 200");
  const tgtPS = await q(tgtConn, "SELECT Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false AND NamespacePrefix = null ORDER BY Label LIMIT 200");
  if (srcPS.ok && tgtPS.ok) {
    r.permissionSets = diffByKey(srcPS.records, tgtPS.records, rec => rec.Name);
  }

  // Permission Set Groups
  const srcPSG = await q(srcConn, "SELECT DeveloperName, MasterLabel FROM PermissionSetGroup WHERE NamespacePrefix = null ORDER BY MasterLabel LIMIT 100");
  const tgtPSG = await q(tgtConn, "SELECT DeveloperName, MasterLabel FROM PermissionSetGroup WHERE NamespacePrefix = null ORDER BY MasterLabel LIMIT 100");
  if (srcPSG.ok && tgtPSG.ok) {
    r.permissionSetGroups = diffByKey(srcPSG.records, tgtPSG.records, rec => rec.DeveloperName);
  }

  // OWD
  const srcOWD = await q(srcConn, "SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE QualifiedApiName IN ('Lead','Account','Contact','Opportunity','Case')");
  const tgtOWD = await q(tgtConn, "SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE QualifiedApiName IN ('Lead','Account','Contact','Opportunity','Case')");
  if (srcOWD.ok && tgtOWD.ok) {
    r.orgWideDefaults = diffByKey(srcOWD.records, tgtOWD.records,
      rec => rec.QualifiedApiName,
      (s, t) => s.InternalSharingModel === t.InternalSharingModel && s.ExternalSharingModel === t.ExternalSharingModel
    );
  }

  return r;
}

async function compareAutomation(srcConn, tgtConn) {
  const r = {};

  // Active Flows
  const srcFlows = await q(srcConn, "SELECT Definition.DeveloperName, ProcessType, Status FROM Flow WHERE Status = 'Active' LIMIT 300", true);
  const tgtFlows = await q(tgtConn, "SELECT Definition.DeveloperName, ProcessType, Status FROM Flow WHERE Status = 'Active' LIMIT 300", true);
  if (srcFlows.ok && tgtFlows.ok) {
    r.activeFlows = diffByKey(srcFlows.records, tgtFlows.records,
      rec => rec.Definition?.DeveloperName || 'unknown',
      (s, t) => s.ProcessType === t.ProcessType
    );
  }

  // Validation Rules
  const srcVRs = await q(srcConn, "SELECT ValidationName, EntityDefinition.QualifiedApiName, Active FROM ValidationRule WHERE Active = true LIMIT 100", true);
  const tgtVRs = await q(tgtConn, "SELECT ValidationName, EntityDefinition.QualifiedApiName, Active FROM ValidationRule WHERE Active = true LIMIT 100", true);
  if (srcVRs.ok && tgtVRs.ok) {
    r.validationRules = diffByKey(srcVRs.records, tgtVRs.records,
      rec => (rec.EntityDefinition?.QualifiedApiName || '') + '.' + rec.ValidationName);
  }

  // Apex Triggers
  const srcTriggers = await q(srcConn, "SELECT Name, TableEnumOrId, Status FROM ApexTrigger WHERE Status = 'Active' AND NamespacePrefix = null LIMIT 100", true);
  const tgtTriggers = await q(tgtConn, "SELECT Name, TableEnumOrId, Status FROM ApexTrigger WHERE Status = 'Active' AND NamespacePrefix = null LIMIT 100", true);
  if (srcTriggers.ok && tgtTriggers.ok) {
    r.apexTriggers = diffByKey(srcTriggers.records, tgtTriggers.records, rec => rec.Name);
  }

  return r;
}

async function compareIntegration(srcConn, tgtConn) {
  const r = {};

  // Auth Providers
  const srcAP = await q(srcConn, "SELECT DeveloperName, FriendlyName, ProviderType FROM AuthProvider ORDER BY FriendlyName LIMIT 50");
  const tgtAP = await q(tgtConn, "SELECT DeveloperName, FriendlyName, ProviderType FROM AuthProvider ORDER BY FriendlyName LIMIT 50");
  if (srcAP.ok && tgtAP.ok) {
    r.authProviders = diffByKey(srcAP.records, tgtAP.records,
      rec => rec.DeveloperName,
      (s, t) => s.ProviderType === t.ProviderType
    );
  }

  // Named Credentials via metadata.list
  const listMeta = async (conn, type) => {
    try {
      const result = await conn.metadata.list([{ type }]);
      const items = Array.isArray(result) ? result : result ? [result] : [];
      return { ok: true, records: items };
    } catch (e) { return { ok: false, error: e.message?.substring(0, 100) }; }
  };

  const srcNC = await listMeta(srcConn, 'NamedCredential');
  const tgtNC = await listMeta(tgtConn, 'NamedCredential');
  if (srcNC.ok && tgtNC.ok) {
    r.namedCredentials = diffByKey(srcNC.records, tgtNC.records, rec => rec.fullName);
  }

  // Connected Apps
  const srcCA = await listMeta(srcConn, 'ConnectedApp');
  const tgtCA = await listMeta(tgtConn, 'ConnectedApp');
  if (srcCA.ok && tgtCA.ok) {
    r.connectedApps = diffByKey(srcCA.records, tgtCA.records, rec => rec.fullName);
  }

  return r;
}

async function compareAgentforce(srcConn, tgtConn) {
  const r = {};

  // Agents
  const srcAgents = await q(srcConn, "SELECT DeveloperName, MasterLabel FROM BotDefinition ORDER BY MasterLabel");
  const tgtAgents = await q(tgtConn, "SELECT DeveloperName, MasterLabel FROM BotDefinition ORDER BY MasterLabel");
  if (srcAgents.ok && tgtAgents.ok) {
    r.agents = diffByKey(srcAgents.records, tgtAgents.records, rec => rec.DeveloperName);
  }

  // Actions via metadata.list
  const listMeta = async (conn, type) => {
    try {
      const result = await conn.metadata.list([{ type }]);
      const items = Array.isArray(result) ? result : result ? [result] : [];
      return { ok: true, records: items };
    } catch (e) { return { ok: false, error: e.message?.substring(0, 100) }; }
  };

  const srcActions = await listMeta(srcConn, 'GenAiFunction');
  const tgtActions = await listMeta(tgtConn, 'GenAiFunction');
  if (srcActions.ok && tgtActions.ok) {
    r.agentActions = diffByKey(srcActions.records, tgtActions.records, rec => rec.fullName);
  }

  const srcTopics = await listMeta(srcConn, 'GenAiPlanner');
  const tgtTopics = await listMeta(tgtConn, 'GenAiPlanner');
  if (srcTopics.ok && tgtTopics.ok) {
    r.agentTopics = diffByKey(srcTopics.records, tgtTopics.records, rec => rec.fullName);
  }

  const srcPlugins = await listMeta(srcConn, 'GenAiPlugin');
  const tgtPlugins = await listMeta(tgtConn, 'GenAiPlugin');
  if (srcPlugins.ok && tgtPlugins.ok) {
    r.agentPlugins = diffByKey(srcPlugins.records, tgtPlugins.records, rec => rec.fullName);
  }

  return r;
}

// ══════════════════════════════════════════════
// COMPARATOR REGISTRY
// ══════════════════════════════════════════════
const COMPARATORS = {
  objects: compareObjects,
  security: compareSecurity,
  automation: compareAutomation,
  integration: compareIntegration,
  agentforce: compareAgentforce,
};

const ALL_SCOPES = Object.keys(COMPARATORS);

// ══════════════════════════════════════════════
// ENDPOINT
// ══════════════════════════════════════════════

// GET /api/orgs/compare?source=36&target=100&scope=objects,security (or 'all')
router.get('/compare', authMiddleware, async (req, res) => {
  try {
    const sourceId = req.query.source;
    const targetId = req.query.target;
    if (!sourceId || !targetId) return res.status(400).json({ error: 'source and target org IDs required' });

    const srcOrg = await getOrgById(sourceId);
    const tgtOrg = await getOrgById(targetId);
    if (!srcOrg) return res.status(404).json({ error: 'Source org not found' });
    if (!tgtOrg) return res.status(404).json({ error: 'Target org not found' });

    const srcConn = await connectToOrg(srcOrg);
    const tgtConn = await connectToOrg(tgtOrg);

    const scopeParam = (req.query.scope || 'all').toLowerCase();
    const scopes = scopeParam === 'all' ? ALL_SCOPES : scopeParam.split(',').map(s => s.trim());

    const diff = {
      source: { id: srcOrg.id, name: srcOrg.name },
      target: { id: tgtOrg.id, name: tgtOrg.name },
      timestamp: new Date().toISOString(),
      scopes
    };

    for (const scope of scopes) {
      if (COMPARATORS[scope]) {
        diff[scope] = await COMPARATORS[scope](srcConn, tgtConn);
      }
    }

    res.json(diff);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
