// src/routes/setup-scan.js — Setup Scanner: Experience Cloud + Agentforce
// Uses v62.0 for standard queries, v63.0 ONLY for GenAi* objects
import express from 'express';
import jsforce from 'jsforce';
import { authMiddleware } from '../middleware/auth.js';
import { connectToOrg } from '../services/sf-multi.js';
import { decrypt } from '../services/crypto.js';
import pool from '../config/db.js';

const router = express.Router();

async function getOrgById(id) {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// Secondary connection at v63.0 — ONLY for GenAi* objects
const v63Connections = {};
async function connectV63(org) {
  const key = 'v63_' + (org.id || org.username);
  if (v63Connections[key]) {
    try { await v63Connections[key].identity(); return v63Connections[key]; }
    catch { delete v63Connections[key]; }
  }
  const conn = new jsforce.Connection({ loginUrl: org.login_url, version: '63.0' });
  const password = decrypt(org.password);
  const token = decrypt(org.security_token);
  await conn.login(org.username, password + (token || ''));
  v63Connections[key] = conn;
  return conn;
}

// Safe query helper
async function q(conn, soql, isTooling = false) {
  try {
    const result = isTooling ? await conn.tooling.query(soql) : await conn.query(soql);
    return { ok: true, totalSize: result.totalSize, records: result.records || [] };
  } catch (e) { return { ok: false, error: e.message?.substring(0, 150) }; }
}

// ══════════════════════════════════════════════
// EXPERIENCE CLOUD SCANNER (v62.0)
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
  r.sharingRules = await q(conn,
    "SELECT Id, Name, SobjectType FROM SharingCriteriaRule WHERE SobjectType IN ('Lead','Account','Contact','Opportunity','Case') LIMIT 100");
  if (!r.sharingRules.ok) {
    r.sharingRules = await q(conn, "SELECT Id, DeveloperName FROM CriteriaBasedSharingRule LIMIT 100");
  }
  return r;
}

// ══════════════════════════════════════════════
// AGENTFORCE SCANNER (v62.0 + v63.0 for GenAi*)
// ══════════════════════════════════════════════
async function scanAgentforce(conn, conn63) {
  const r = {};

  // v62.0 — standard objects
  r.agents = await q(conn, "SELECT Id, DeveloperName, MasterLabel FROM BotDefinition ORDER BY MasterLabel");
  r.agentVersions = await q(conn, "SELECT Id, DeveloperName, BotDefinitionId, Status FROM BotVersion ORDER BY BotDefinitionId, Status LIMIT 50");
  r.invocableFlows = await q(conn,
    "SELECT Id, Definition.DeveloperName, ProcessType, Status FROM Flow WHERE ProcessType = 'AutoLaunchedFlow' AND Status = 'Active' LIMIT 200", true);
  r.serviceChannels = await q(conn, "SELECT Id, DeveloperName, MasterLabel, RelatedEntity FROM ServiceChannel LIMIT 50");

  // Apex with @InvocableMethod
  const apexResult = await q(conn,
    "SELECT Id, Name, Body FROM ApexClass WHERE Status = 'Active' AND NamespacePrefix = null LIMIT 500", true);
  if (apexResult.ok) {
    const filtered = apexResult.records.filter(c => c.Body && c.Body.includes('@InvocableMethod')).map(c => ({ Id: c.Id, Name: c.Name }));
    r.invocableApexClasses = { ok: true, totalSize: filtered.length, records: filtered };
  } else {
    r.invocableApexClasses = apexResult;
  }

  // v63.0 — GenAi* objects (Agentforce-specific)
  if (conn63) {
    r.agentActions = await q(conn63, "SELECT Id, DeveloperName, MasterLabel, Description FROM GenAiFunction ORDER BY MasterLabel LIMIT 200", true);
    r.agentTopics = await q(conn63, "SELECT Id, DeveloperName, MasterLabel, Description FROM GenAiPlanner ORDER BY MasterLabel LIMIT 50", true);
    r.agentPlugins = await q(conn63, "SELECT Id, DeveloperName, MasterLabel FROM GenAiPlugin ORDER BY MasterLabel LIMIT 50", true);
    r.topicActionBindings = await q(conn63, "SELECT Id, GenAiFunctionId, GenAiPlannerId FROM GenAiPlannerFunctionRel LIMIT 200", true);
    r.embeddedServiceConfigs = await q(conn63, "SELECT Id, DeveloperName, MasterLabel, Site FROM EmbeddedServiceConfig LIMIT 20", true);
    r.experienceBundles = await q(conn63, "SELECT Id, DeveloperName FROM ExperienceBundle LIMIT 20", true);
  } else {
    r.agentActions = { ok: false, error: 'v63.0 connection unavailable' };
    r.agentTopics = { ok: false, error: 'v63.0 connection unavailable' };
    r.agentPlugins = { ok: false, error: 'v63.0 connection unavailable' };
    r.topicActionBindings = { ok: false, error: 'v63.0 connection unavailable' };
    r.embeddedServiceConfigs = { ok: false, error: 'v63.0 connection unavailable' };
    r.experienceBundles = { ok: false, error: 'v63.0 connection unavailable' };
  }

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
    let conn63 = null;
    try { conn63 = await connectV63(org); } catch (e) { /* v63 not available, graceful */ }
    const scopeParam = (req.query.scope || 'all').toLowerCase();
    const scopes = scopeParam === 'all' ? ['experience', 'agentforce'] : scopeParam.split(',').map(s => s.trim());
    const scan = { org: { id: org.id, name: org.name }, timestamp: new Date().toISOString(), scopes, apiVersions: { standard: '62.0', genai: conn63 ? '63.0' : 'unavailable' } };
    if (scopes.includes('experience')) scan.experienceCloud = await scanExperienceCloud(conn);
    if (scopes.includes('agentforce')) scan.agentforce = await scanAgentforce(conn, conn63);
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
    let conn63 = null;
    try { conn63 = await connectV63(org); } catch (e) { /* graceful */ }
    res.json({ org: { id: org.id, name: org.name }, timestamp: new Date().toISOString(), apiVersions: { standard: '62.0', genai: conn63 ? '63.0' : 'unavailable' }, agentforce: await scanAgentforce(conn, conn63) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
