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

// ══════════════════════════════════════════════
// EXPERIENCE CLOUD SCANNER
// ══════════════════════════════════════════════

async function scanExperienceCloud(conn) {
  const results = {};

  // 1. Networks (Sites) — ativos, URLs, status
  try {
    const networks = await conn.query("SELECT Id, Name, Status, UrlPathPrefix, Description FROM Network WHERE Status = 'Live' OR Status = 'Active'");
    results.networks = networks.records.map(n => ({ id: n.Id, name: n.Name, status: n.Status, urlPrefix: n.UrlPathPrefix, description: n.Description }));
  } catch (e) { results.networks = { error: e.message }; }

  // 2. NetworkMemberGroups — quem tem acesso a cada site
  try {
    const members = await conn.query("SELECT Id, NetworkId, ParentId FROM NetworkMemberGroup");
    results.networkMemberGroups = members.records.map(m => ({ id: m.Id, networkId: m.NetworkId, parentId: m.ParentId }));
  } catch (e) { results.networkMemberGroups = { error: e.message }; }

  // 3. External Users (Partner + Customer)
  try {
    const extUsers = await conn.query("SELECT Id, Username, Name, Profile.Name, UserType, IsActive, ContactId, Contact.AccountId, Contact.Account.Name FROM User WHERE UserType IN ('PowerPartner','CustomerSuccess','CspLitePortal','PowerCustomerSuccess') ORDER BY IsActive DESC, Name LIMIT 200");
    results.externalUsers = { totalSize: extUsers.totalSize, records: extUsers.records.map(u => ({ id: u.Id, username: u.Username, name: u.Name, profileName: u.Profile?.Name, userType: u.UserType, isActive: u.IsActive, contactId: u.ContactId, accountName: u.Contact?.Account?.Name })) };
  } catch (e) { results.externalUsers = { error: e.message }; }

  // 4. Sharing Sets
  try {
    const conn2 = conn;
    const sharingSetMeta = await conn2.tooling.query("SELECT Id, DeveloperName, MasterLabel FROM SharingSet");
    results.sharingSets = sharingSetMeta.records || [];
  } catch (e) {
    // SharingSet might not be queryable via Tooling, try metadata
    try {
      const ss = await conn.metadata.read('SharingSet', '*');
      results.sharingSets = Array.isArray(ss) ? ss : ss?.fullName ? [ss] : [];
    } catch (e2) { results.sharingSets = { error: e.message + ' / ' + e2.message }; }
  }

  // 5. Navigation Menu Items
  try {
    const navItems = await conn.query("SELECT Id, Label, Type, Target, Position, NavigationLinkSetId FROM NavigationMenuItem ORDER BY NavigationLinkSetId, Position LIMIT 200");
    results.navigationMenuItems = navItems.records;
  } catch (e) { results.navigationMenuItems = { error: e.message }; }

  // 6. Experience Bundles (via Tooling API)
  try {
    const bundles = await conn.tooling.query("SELECT Id, DeveloperName, MasterLabel, NamespacePrefix FROM ExperienceBundle");
    results.experienceBundles = bundles.records || [];
  } catch (e) { results.experienceBundles = { error: e.message }; }

  // 7. Guest User Profile analysis
  try {
    const guestUsers = await conn.query("SELECT Id, Name, Username, ProfileId, Profile.Name FROM User WHERE UserType = 'Guest' AND IsActive = true");
    results.guestUsers = guestUsers.records.map(u => ({ id: u.Id, name: u.Name, username: u.Username, profileId: u.ProfileId, profileName: u.Profile?.Name }));
  } catch (e) { results.guestUsers = { error: e.message }; }

  // 8. Sharing Rules per key objects
  try {
    const sharingRules = await conn.tooling.query("SELECT Id, DeveloperName, SobjectType FROM SharingRules WHERE SobjectType IN ('Lead','Account','Contact','Opportunity','Case') LIMIT 100");
    results.sharingRules = sharingRules.records || [];
  } catch (e) {
    // Fallback: query CriteriaBasedSharingRule
    try {
      const cbsr = await conn.query("SELECT Id, DeveloperName, SobjectType FROM CriteriaBasedSharingRule LIMIT 100");
      results.sharingRules = cbsr.records || [];
    } catch (e2) { results.sharingRules = { error: e.message }; }
  }

  // 9. Custom Permissions assigned to External profiles
  try {
    const customPerms = await conn.query("SELECT Id, Parent.Name, Parent.Profile.Name, Parent.IsOwnedByProfile, SetupEntityId, SetupEntity.DeveloperName FROM SetupEntityAccess WHERE SetupEntity.Type = 'CustomPermission' AND Parent.Profile.UserType IN ('PowerPartner','CustomerSuccess','Guest') LIMIT 200");
    results.externalCustomPermissions = customPerms.records || [];
  } catch (e) { results.externalCustomPermissions = { error: e.message }; }

  return results;
}

// ══════════════════════════════════════════════
// AGENTFORCE SCANNER
// ══════════════════════════════════════════════

async function scanAgentforce(conn) {
  const results = {};

  // 1. BotDefinition (Agents)
  try {
    const bots = await conn.tooling.query("SELECT Id, DeveloperName, MasterLabel, Status FROM BotDefinition ORDER BY MasterLabel");
    results.agents = bots.records || [];
  } catch (e) { results.agents = { error: e.message }; }

  // 2. BotVersion (versões de cada agent)
  try {
    const versions = await conn.tooling.query("SELECT Id, DeveloperName, BotDefinitionId, Number, Status FROM BotVersion ORDER BY BotDefinitionId, Number DESC LIMIT 50");
    results.agentVersions = versions.records || [];
  } catch (e) { results.agentVersions = { error: e.message }; }

  // 3. GenAiFunction (Agent Actions — custom + standard)
  try {
    const actions = await conn.tooling.query("SELECT Id, DeveloperName, MasterLabel, Description, IsStandard FROM GenAiFunction ORDER BY IsStandard, MasterLabel LIMIT 200");
    results.agentActions = { totalSize: actions.totalSize, records: actions.records || [] };
  } catch (e) { results.agentActions = { error: e.message }; }

  // 4. GenAiPlanner (Topics — instructions + action bindings)
  try {
    const planners = await conn.tooling.query("SELECT Id, DeveloperName, MasterLabel, Description FROM GenAiPlanner ORDER BY MasterLabel LIMIT 50");
    results.agentTopics = planners.records || [];
  } catch (e) { results.agentTopics = { error: e.message }; }

  // 5. GenAiPlugin (Skills / action bundles)
  try {
    const plugins = await conn.tooling.query("SELECT Id, DeveloperName, MasterLabel, Description FROM GenAiPlugin ORDER BY MasterLabel LIMIT 50");
    results.agentPlugins = plugins.records || [];
  } catch (e) { results.agentPlugins = { error: e.message }; }

  // 6. GenAiPlannerFunctionRel (which actions are assigned to which topics)
  try {
    const rels = await conn.tooling.query("SELECT Id, GenAiFunctionId, GenAiPlannerId FROM GenAiPlannerFunctionRel LIMIT 200");
    results.topicActionBindings = rels.records || [];
  } catch (e) { results.topicActionBindings = { error: e.message }; }

  // 7. AiAssistantSettings (Einstein GPT Copilot enabled?)
  try {
    const settings = await conn.tooling.query("SELECT Id, DeveloperName, IsEinsteinGptEnabled FROM AiAssistantSettings LIMIT 5");
    results.aiSettings = settings.records || [];
  } catch (e) {
    // Try via Setup entity
    try {
      const settings2 = await conn.query("SELECT Id, SetupOwnerId FROM SetupEntityAccess WHERE SetupEntity.DeveloperName = 'EinsteinGPTPlatformPerm' LIMIT 5");
      results.aiSettings = { einsteinGptPermAssigned: settings2.totalSize > 0, records: settings2.records };
    } catch (e2) { results.aiSettings = { error: e.message }; }
  }

  // 8. EmbeddedServiceConfig (Service Agent deployments — web chat, messaging)
  try {
    const embedded = await conn.tooling.query("SELECT Id, DeveloperName, MasterLabel, Site FROM EmbeddedServiceConfig LIMIT 20");
    results.embeddedServiceConfigs = embedded.records || [];
  } catch (e) { results.embeddedServiceConfigs = { error: e.message }; }

  // 9. Flows exposed as Agent Actions (invocable flows)
  try {
    const invocableFlows = await conn.tooling.query("SELECT Id, DeveloperName, MasterLabel, ProcessType, Status FROM FlowDefinition WHERE ProcessType = 'AutoLaunchedFlow' AND ActiveVersionId != null LIMIT 100");
    results.invocableFlows = { totalSize: invocableFlows.totalSize, records: invocableFlows.records || [] };
  } catch (e) {
    try {
      const flows2 = await conn.tooling.query("SELECT Id, Definition.DeveloperName, ProcessType, Status FROM Flow WHERE ProcessType = 'AutoLaunchedFlow' AND Status = 'Active' LIMIT 100");
      results.invocableFlows = { totalSize: flows2.totalSize, records: flows2.records || [] };
    } catch (e2) { results.invocableFlows = { error: e.message }; }
  }

  // 10. Apex classes with @InvocableMethod (potential agent actions)
  try {
    const invocableApex = await conn.tooling.query("SELECT Id, Name, Body FROM ApexClass WHERE Status = 'Active' AND NamespacePrefix = null LIMIT 300");
    const withInvocable = (invocableApex.records || []).filter(c => c.Body && c.Body.includes('@InvocableMethod'));
    results.invocableApexClasses = withInvocable.map(c => ({ id: c.Id, name: c.Name }));
  } catch (e) { results.invocableApexClasses = { error: e.message }; }

  return results;
}

// ══════════════════════════════════════════════
// UNIFIED SCAN ENDPOINT
// ══════════════════════════════════════════════

// GET /api/orgs/:id/setup-scan?scope=experience,agentforce (or 'all')
router.get('/:id/setup-scan', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });
    const conn = await connectToOrg(org);

    const scopeParam = (req.query.scope || 'all').toLowerCase();
    const scopes = scopeParam === 'all' ? ['experience', 'agentforce'] : scopeParam.split(',').map(s => s.trim());

    const scan = { org: { id: org.id, name: org.name }, timestamp: new Date().toISOString(), scopes };

    if (scopes.includes('experience')) {
      scan.experienceCloud = await scanExperienceCloud(conn);
    }

    if (scopes.includes('agentforce')) {
      scan.agentforce = await scanAgentforce(conn);
    }

    res.json(scan);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orgs/:id/setup-scan/experience — shortcut
router.get('/:id/setup-scan/experience', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });
    const conn = await connectToOrg(org);
    res.json({ org: { id: org.id, name: org.name }, timestamp: new Date().toISOString(), experienceCloud: await scanExperienceCloud(conn) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orgs/:id/setup-scan/agentforce — shortcut
router.get('/:id/setup-scan/agentforce', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });
    const conn = await connectToOrg(org);
    res.json({ org: { id: org.id, name: org.name }, timestamp: new Date().toISOString(), agentforce: await scanAgentforce(conn) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
