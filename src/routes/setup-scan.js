// src/routes/setup-scan.js — Setup Scanner: Experience Cloud + Agentforce
// v62.0 for standard queries + metadata.list for GenAi* objects
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { connectToOrg } from '../services/sf-multi.js';
import pool from '../config/db.js';

const router = express.Router();

async function getOrgById(id) {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// Safe SOQL/Tooling query
async function q(conn, soql, isTooling = false) {
  try {
    const result = isTooling ? await conn.tooling.query(soql) : await conn.query(soql);
    return { ok: true, totalSize: result.totalSize, records: result.records || [] };
  } catch (e) { return { ok: false, error: e.message?.substring(0, 150) }; }
}

// Safe metadata.list — lists all components of a given type
async function metaList(conn, typeName) {
  try {
    const result = await conn.metadata.list([{ type: typeName }]);
    const items = Array.isArray(result) ? result : result ? [result] : [];
    return { ok: true, totalSize: items.length, records: items.map(i => ({
      fullName: i.fullName, type: i.type, id: i.id,
      createdDate: i.createdDate, lastModifiedDate: i.lastModifiedDate,
      manageableState: i.manageableState, namespacePrefix: i.namespacePrefix
    })) };
  } catch (e) { return { ok: false, error: e.message?.substring(0, 150) }; }
}

// Safe metadata.read — reads full detail of a component
async function metaRead(conn, typeName, fullName) {
  try {
    const result = await conn.metadata.read(typeName, fullName);
    return { ok: true, data: result };
  } catch (e) { return { ok: false, error: e.message?.substring(0, 150) }; }
}

// ══════════════════════════════════════════════
// EXPERIENCE CLOUD SCANNER
// ══════════════════════════════════════════════
async function scanExperienceCloud(conn) {
  const r = {};
  r.networks = await q(conn, "SELECT Id, Name, Status, UrlPathPrefix, Description FROM Network");
  r.networkMemberGroups = await q(conn, "SELECT Id, NetworkId, ParentId FROM NetworkMemberGroup");
  r.externalUsers = await q(conn,
    "SELECT Id, Username, Name, Profile.Name, UserType, IsActive, ContactId, Contact.Account.Name " +
    "FROM User WHERE UserType IN ('PowerPartner','CustomerSuccess','CspLitePortal','PowerCustomerSuccess') " +
    "ORDER BY IsActive DESC, Name LIMIT 200");
  r.navigationMenuItems = await q(conn,
    "SELECT Id, Label, Type, Target, Position, NavigationLinkSetId FROM NavigationMenuItem ORDER BY NavigationLinkSetId, Position LIMIT 200");
  r.guestUsers = await q(conn,
    "SELECT Id, Name, Username, ProfileId, Profile.Name FROM User WHERE UserType = 'Guest' AND IsActive = true");
  r.externalPermSets = await q(conn,
    "SELECT PermissionSet.Name, PermissionSet.Label, AssigneeId, Assignee.Name, Assignee.UserType " +
    "FROM PermissionSetAssignment WHERE Assignee.UserType IN ('PowerPartner','CustomerSuccess','Guest') " +
    "ORDER BY PermissionSet.Name LIMIT 200");
  r.experienceBundles = await metaList(conn, 'ExperienceBundle');
  r.sharingRules = await q(conn,
    "SELECT Id, Name, SobjectType FROM SharingCriteriaRule WHERE SobjectType IN ('Lead','Account','Contact','Opportunity','Case') LIMIT 100");
  if (!r.sharingRules.ok) {
    r.sharingRules = await q(conn, "SELECT Id, DeveloperName FROM CriteriaBasedSharingRule LIMIT 100");
  }
  return r;
}

// ══════════════════════════════════════════════
// AGENTFORCE SCANNER
// ══════════════════════════════════════════════
async function scanAgentforce(conn) {
  const r = {};

  // Agents via SOQL
  r.agents = await q(conn, "SELECT Id, DeveloperName, MasterLabel FROM BotDefinition ORDER BY MasterLabel");
  r.agentVersions = await q(conn, "SELECT Id, DeveloperName, BotDefinitionId, Status FROM BotVersion ORDER BY BotDefinitionId, Status LIMIT 50");

  // GenAi* via metadata.list (bypasses SOQL/Tooling API version issues)
  r.agentActions = await metaList(conn, 'GenAiFunction');
  r.agentTopics = await metaList(conn, 'GenAiPlanner');
  r.agentPlugins = await metaList(conn, 'GenAiPlugin');

  // Agent full config via metadata.read (for each agent found)
  if (r.agents.ok && r.agents.records.length > 0) {
    const agentDetails = [];
    for (const agent of r.agents.records) {
      const detail = await metaRead(conn, 'Bot', agent.DeveloperName);
      if (detail.ok) {
        const d = detail.data;
        agentDetails.push({
          developerName: d.fullName,
          label: d.label,
          agentType: d.agentType,
          type: d.type,
          description: d.description,
          botUser: d.botUser,
          sessionTimeout: d.sessionTimeout,
          richContentEnabled: d.richContentEnabled,
          versionsCount: Array.isArray(d.botVersions) ? d.botVersions.length : d.botVersions ? 1 : 0
        });
      }
    }
    r.agentConfigs = { ok: true, totalSize: agentDetails.length, records: agentDetails };
  }

  // EmbeddedServiceConfig via metadata.list
  r.embeddedServiceConfigs = await metaList(conn, 'EmbeddedServiceConfig');

  // Invocable Flows
  r.invocableFlows = await q(conn,
    "SELECT Id, Definition.DeveloperName, ProcessType, Status FROM Flow WHERE ProcessType = 'AutoLaunchedFlow' AND Status = 'Active' LIMIT 200", true);

  // Apex with @InvocableMethod
  const apexResult = await q(conn,
    "SELECT Id, Name, Body FROM ApexClass WHERE Status = 'Active' AND NamespacePrefix = null LIMIT 500", true);
  if (apexResult.ok) {
    const filtered = apexResult.records.filter(c => c.Body && c.Body.includes('@InvocableMethod')).map(c => ({ Id: c.Id, Name: c.Name }));
    r.invocableApexClasses = { ok: true, totalSize: filtered.length, records: filtered };
  } else {
    r.invocableApexClasses = apexResult;
  }

  // Service Channels
  r.serviceChannels = await q(conn, "SELECT Id, DeveloperName, MasterLabel, RelatedEntity FROM ServiceChannel LIMIT 50");

  return r;
}

// ══════════════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════════════

router.get('/:id/setup-scan', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const conn = await connectToOrg(org);
    const scopeParam = (req.query.scope || 'all').toLowerCase();
    const scopes = scopeParam === 'all' ? ['experience', 'agentforce'] : scopeParam.split(',').map(s => s.trim());
    const scan = { org: { id: org.id, name: org.name }, timestamp: new Date().toISOString(), scopes };
    if (scopes.includes('experience')) scan.experienceCloud = await scanExperienceCloud(conn);
    if (scopes.includes('agentforce')) scan.agentforce = await scanAgentforce(conn);
    res.json(scan);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/setup-scan/experience', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const conn = await connectToOrg(org);
    res.json({ org: { id: org.id, name: org.name }, timestamp: new Date().toISOString(), experienceCloud: await scanExperienceCloud(conn) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/setup-scan/agentforce', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const conn = await connectToOrg(org);
    res.json({ org: { id: org.id, name: org.name }, timestamp: new Date().toISOString(), agentforce: await scanAgentforce(conn) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
