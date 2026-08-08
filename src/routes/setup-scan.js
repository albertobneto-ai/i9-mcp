// src/routes/setup-scan.js — Setup Scanner: Experience Cloud + Agentforce
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { connectToOrg } from '../services/sf-multi.js';
import pool from '../config/db.js';

const router = express.Router();

async function getOrgById(id) {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// Safe query helper — returns records or error object, never throws
async function safeQuery(conn, soql, isTooling = false) {
  try {
    const result = isTooling ? await conn.tooling.query(soql) : await conn.query(soql);
    return { ok: true, totalSize: result.totalSize, records: result.records || [] };
  } catch (e) { return { ok: false, error: e.message?.substring(0, 150) }; }
}

async function safeMetadataRead(conn, type, fullNames) {
  try {
    const result = await conn.metadata.read(type, fullNames);
    const items = Array.isArray(result) ? result : result?.fullName ? [result] : [];
    return { ok: true, records: items };
  } catch (e) { return { ok: false, error: e.message?.substring(0, 150) }; }
}

// ══════════════════════════════════════════════
// EXPERIENCE CLOUD SCANNER
// ══════════════════════════════════════════════
async function scanExperienceCloud(conn) {
  const r = {};

  // Networks (Sites)
  r.networks = await safeQuery(conn, "SELECT Id, Name, Status, UrlPathPrefix, Description FROM Network");

  // Network Member Groups
  r.networkMemberGroups = await safeQuery(conn, "SELECT Id, NetworkId, ParentId FROM NetworkMemberGroup");

  // External Users (Partner + Customer)
  r.externalUsers = await safeQuery(conn,
    "SELECT Id, Username, Name, Profile.Name, UserType, IsActive, ContactId, Contact.Account.Name " +
    "FROM User WHERE UserType IN ('PowerPartner','CustomerSuccess','CspLitePortal','PowerCustomerSuccess') " +
    "ORDER BY IsActive DESC, Name LIMIT 200");

  // Navigation Menu Items
  r.navigationMenuItems = await safeQuery(conn,
    "SELECT Id, Label, Type, Target, Position, NavigationLinkSetId FROM NavigationMenuItem ORDER BY NavigationLinkSetId, Position LIMIT 200");

  // Guest Users
  r.guestUsers = await safeQuery(conn,
    "SELECT Id, Name, Username, ProfileId, Profile.Name FROM User WHERE UserType = 'Guest' AND IsActive = true");

  // Experience Bundles via Tooling
  r.experienceBundles = await safeQuery(conn,
    "SELECT Id, DeveloperName FROM ExperienceBundle", true);

  // Permission Sets assigned to external user profiles
  r.externalPermSets = await safeQuery(conn,
    "SELECT PermissionSet.Name, PermissionSet.Label, AssigneeId, Assignee.Name, Assignee.UserType " +
    "FROM PermissionSetAssignment WHERE Assignee.UserType IN ('PowerPartner','CustomerSuccess','Guest') " +
    "ORDER BY PermissionSet.Name LIMIT 200");

  // Sharing Rules (criteria-based on key objects)
  r.sharingRules = await safeQuery(conn,
    "SELECT Id, Name, SobjectType FROM SharingCriteriaRule WHERE SobjectType IN ('Lead','Account','Contact','Opportunity','Case') LIMIT 100");
  // Fallback
  if (!r.sharingRules.ok) {
    r.sharingRules = await safeQuery(conn,
      "SELECT Id, DeveloperName FROM CriteriaBasedSharingRule LIMIT 100");
  }

  return r;
}

// ══════════════════════════════════════════════
// AGENTFORCE SCANNER
// ══════════════════════════════════════════════
async function scanAgentforce(conn) {
  const r = {};

  // BotDefinition (Agents) — via SOQL (works on v62.0)
  r.agents = await safeQuery(conn,
    "SELECT Id, DeveloperName, MasterLabel FROM BotDefinition ORDER BY MasterLabel");

  // BotVersion — via SOQL
  r.agentVersions = await safeQuery(conn,
    "SELECT Id, DeveloperName, BotDefinitionId, Status FROM BotVersion ORDER BY BotDefinitionId, Status LIMIT 50");

  // GenAiFunction (Agent Actions) — Tooling v63.0+, graceful fail on v62.0
  r.agentActions = await safeQuery(conn,
    "SELECT Id, DeveloperName FROM GenAiFunction LIMIT 200", true);

  // GenAiPlanner (Topics)
  r.agentTopics = await safeQuery(conn,
    "SELECT Id, DeveloperName FROM GenAiPlanner LIMIT 50", true);

  // GenAiPlugin (Skills)
  r.agentPlugins = await safeQuery(conn,
    "SELECT Id, DeveloperName FROM GenAiPlugin LIMIT 50", true);

  // GenAiPlannerFunctionRel (topic→action bindings)
  r.topicActionBindings = await safeQuery(conn,
    "SELECT Id, GenAiFunctionId, GenAiPlannerId FROM GenAiPlannerFunctionRel LIMIT 200", true);

  // EmbeddedServiceConfig — Tooling (works)
  r.embeddedServiceConfigs = await safeQuery(conn,
    "SELECT Id, DeveloperName, MasterLabel, Site FROM EmbeddedServiceConfig", true);

  // Invocable Flows (AutoLaunchedFlow = potential agent actions)
  r.invocableFlows = await safeQuery(conn,
    "SELECT Id, Definition.DeveloperName, ProcessType, Status FROM Flow WHERE ProcessType = 'AutoLaunchedFlow' AND Status = 'Active' LIMIT 200", true);

  // Apex classes with @InvocableMethod
  const apexResult = await safeQuery(conn,
    "SELECT Id, Name, Body FROM ApexClass WHERE Status = 'Active' AND NamespacePrefix = null LIMIT 500", true);
  if (apexResult.ok) {
    r.invocableApexClasses = {
      ok: true,
      records: apexResult.records.filter(c => c.Body && c.Body.includes('@InvocableMethod')).map(c => ({ Id: c.Id, Name: c.Name })),
    };
    r.invocableApexClasses.totalSize = r.invocableApexClasses.records.length;
  } else {
    r.invocableApexClasses = apexResult;
  }

  // Omni-Channel config
  r.serviceChannels = await safeQuery(conn,
    "SELECT Id, DeveloperName, MasterLabel, RelatedEntity FROM ServiceChannel LIMIT 50");

  return r;
}

// ══════════════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════════════

// GET /api/orgs/:id/setup-scan?scope=experience,agentforce (or 'all')
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

// Shortcuts
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
