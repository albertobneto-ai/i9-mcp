// src/routes/setup-scan.js — Setup Scanner: Full Org Raio-X
// Scopes: security, automation, objects, integration, users, data, experience, agentforce
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

// Safe metadata.list
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

// ══════════════════════════════════════════════
// F1 — SECURITY
// ══════════════════════════════════════════════
async function scanSecurity(conn) {
  const r = {};

  // Permission Sets
  r.permissionSets = await q(conn,
    "SELECT Id, Name, Label, IsOwnedByProfile, PermissionSetGroupId, License.Name " +
    "FROM PermissionSet WHERE IsOwnedByProfile = false AND NamespacePrefix = null " +
    "ORDER BY Label LIMIT 200");

  // Permission Set Groups
  r.permissionSetGroups = await q(conn,
    "SELECT Id, DeveloperName, MasterLabel, Status " +
    "FROM PermissionSetGroup WHERE NamespacePrefix = null ORDER BY MasterLabel LIMIT 100");

  // Profiles (custom only)
  r.profiles = await q(conn,
    "SELECT Id, Name, UserType FROM Profile ORDER BY Name LIMIT 200");

  // OWD (Organization-Wide Defaults)
  // OWD per key object via EntityDefinition (batch query)
  r.orgWideDefaults = await q(conn,
    "SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel " +
    "FROM EntityDefinition WHERE QualifiedApiName IN ('Lead','Account','Contact','Opportunity','Case') " +
    "ORDER BY QualifiedApiName");

  // Sharing Rules (criteria-based)
  r.sharingRules = await q(conn,
    "SELECT Id, Name, SobjectType FROM SharingCriteriaRule ORDER BY SobjectType LIMIT 200");
  if (!r.sharingRules.ok) {
    r.sharingRules = await q(conn,
      "SELECT Id, DeveloperName FROM CriteriaBasedSharingRule LIMIT 200");
  }

  // FLS Coverage — count of FieldPermissions per PS for key objects
  r.fieldPermissionsCoverage = await q(conn,
    "SELECT Parent.Name, Parent.Label, SobjectType, COUNT(Id) fieldCount " +
    "FROM FieldPermissions WHERE SobjectType IN ('Lead','Account','Contact','Opportunity') " +
    "GROUP BY Parent.Name, Parent.Label, SobjectType ORDER BY Parent.Label, SobjectType LIMIT 500");

  // PS License Assignments
  r.psLicenses = await q(conn,
    "SELECT PermissionSetLicense.DeveloperName, PermissionSetLicense.MasterLabel, COUNT(Id) assignCount " +
    "FROM PermissionSetLicenseAssign GROUP BY PermissionSetLicense.DeveloperName, PermissionSetLicense.MasterLabel " +
    "ORDER BY PermissionSetLicense.MasterLabel LIMIT 100");

  return r;
}

// ══════════════════════════════════════════════
// F1 — AUTOMATION
// ══════════════════════════════════════════════
async function scanAutomation(conn) {
  const r = {};

  // Active Flows
  r.activeFlows = await q(conn,
    "SELECT Id, Definition.DeveloperName, ProcessType, Status, Description " +
    "FROM Flow WHERE Status = 'Active' ORDER BY Definition.DeveloperName LIMIT 300", true);

  // Validation Rules (active)
  r.validationRules = await q(conn,
    "SELECT Id, ValidationName, EntityDefinition.QualifiedApiName, Active, ErrorMessage " +
    "FROM ValidationRule WHERE Active = true ORDER BY EntityDefinition.QualifiedApiName LIMIT 100", true);

  // Apex Triggers
  r.apexTriggers = await q(conn,
    "SELECT Id, Name, TableEnumOrId, Status, UsageAfterDelete, UsageAfterInsert, UsageAfterUpdate, " +
    "UsageBeforeDelete, UsageBeforeInsert, UsageBeforeUpdate " +
    "FROM ApexTrigger WHERE Status = 'Active' AND NamespacePrefix = null ORDER BY Name LIMIT 100", true);

  // Apex Classes (custom only, count)
  r.apexClasses = await q(conn,
    "SELECT COUNT(Id) total FROM ApexClass WHERE NamespacePrefix = null AND Status = 'Active'", true);

  // Scheduled Jobs
  r.scheduledJobs = await q(conn,
    "SELECT Id, CronJobDetail.Name, State, NextFireTime, PreviousFireTime, CronExpression " +
    "FROM CronTrigger WHERE State = 'WAITING' ORDER BY NextFireTime LIMIT 50");

  // Process Builders (legacy — count only)
  r.processBuilders = await q(conn,
    "SELECT COUNT(Id) total FROM Flow WHERE ProcessType = 'Workflow' AND Status = 'Active'", true);

  return r;
}

// ══════════════════════════════════════════════
// F1 — OBJECTS
// ══════════════════════════════════════════════
async function scanObjects(conn) {
  const r = {};

  // Custom Objects
  r.customObjects = await q(conn,
    "SELECT Id, QualifiedApiName, Label, DeveloperName " +
    "FROM EntityDefinition WHERE IsCustomSetting = false AND QualifiedApiName LIKE '%__c' " +
    "AND PublisherId = '<local>' ORDER BY Label LIMIT 200");

  // Custom Fields per key objects
  const keyObjects = ['Lead', 'Account', 'Contact', 'Opportunity', 'Case'];
  const fieldCounts = [];
  for (const obj of keyObjects) {
    const fc = await q(conn,
      `SELECT COUNT(Id) total FROM CustomField WHERE TableEnumOrId = '${obj}'`, true);
    fieldCounts.push({
      object: obj,
      customFields: fc.ok ? (fc.records[0]?.total || fc.totalSize) : 'error'
    });
  }
  r.customFieldsByObject = { ok: true, totalSize: fieldCounts.length, records: fieldCounts };

  // Record Types
  r.recordTypes = await q(conn,
    "SELECT Id, Name, SobjectType, IsActive, DeveloperName " +
    "FROM RecordType WHERE IsActive = true ORDER BY SobjectType, Name LIMIT 200");

  // Page Layouts (via metadata.list)
  r.pageLayouts = await metaList(conn, 'Layout');

  // Compact Layouts
  r.compactLayouts = await metaList(conn, 'CompactLayout');

  return r;
}

// ══════════════════════════════════════════════
// F1 — INTEGRATION
// ══════════════════════════════════════════════
async function scanIntegration(conn) {
  const r = {};

  // Named Credentials
  r.namedCredentials = await metaList(conn, 'NamedCredential');

  // External Credentials
  r.externalCredentials = await metaList(conn, 'ExternalCredential');

  // Auth Providers
  r.authProviders = await q(conn,
    "SELECT Id, DeveloperName, FriendlyName, ProviderType " +
    "FROM AuthProvider ORDER BY FriendlyName LIMIT 50");

  // Connected Apps
  r.connectedApps = await metaList(conn, 'ConnectedApp');

  // Remote Site Settings
  r.remoteSiteSettings = await metaList(conn, 'RemoteSiteSetting');

  // External Data Sources
  r.externalDataSources = await q(conn,
    "SELECT Id, DeveloperName, MasterLabel, Type " +
    "FROM ExternalDataSource ORDER BY MasterLabel LIMIT 50");

  // Platform Event Channels
  r.platformEventChannels = await metaList(conn, 'PlatformEventChannel');

  return r;
}

// ══════════════════════════════════════════════
// F1 — USERS
// ══════════════════════════════════════════════
async function scanUsers(conn) {
  const r = {};

  // Users by Profile (active)
  r.usersByProfile = await q(conn,
    "SELECT Profile.Name, COUNT(Id) userCount " +
    "FROM User WHERE IsActive = true " +
    "GROUP BY Profile.Name ORDER BY COUNT(Id) DESC LIMIT 100");

  // Users by UserType
  r.usersByType = await q(conn,
    "SELECT UserType, COUNT(Id) userCount " +
    "FROM User WHERE IsActive = true " +
    "GROUP BY UserType ORDER BY COUNT(Id) DESC");

  // Total active/inactive
  r.userCounts = await q(conn,
    "SELECT IsActive, COUNT(Id) userCount " +
    "FROM User GROUP BY IsActive");

  // Frozen users
  r.frozenUsers = await q(conn,
    "SELECT UserId FROM UserLogin WHERE IsFrozen = true LIMIT 50");

  // Last login distribution (users who never logged in)
  r.neverLoggedIn = await q(conn,
    "SELECT COUNT(Id) total FROM User WHERE IsActive = true AND LastLoginDate = null");

  // Users logged in last 30 days
  r.recentLogins = await q(conn,
    "SELECT COUNT(Id) total FROM User WHERE IsActive = true AND LastLoginDate = LAST_N_DAYS:30");

  // License consumption
  r.licenses = await q(conn,
    "SELECT Name, TotalLicenses, UsedLicenses, Status " +
    "FROM UserLicense WHERE Status = 'Active' ORDER BY Name LIMIT 50");

  // PS Assignments (top 20 most assigned)
  r.topPsAssignments = await q(conn,
    "SELECT PermissionSet.Name, PermissionSet.Label, COUNT(Id) assignCount " +
    "FROM PermissionSetAssignment WHERE PermissionSet.IsOwnedByProfile = false " +
    "GROUP BY PermissionSet.Name, PermissionSet.Label " +
    "ORDER BY COUNT(Id) DESC LIMIT 20");

  return r;
}

// ══════════════════════════════════════════════
// F1 — DATA
// ══════════════════════════════════════════════
async function scanData(conn) {
  const r = {};
  const objects = ['Lead', 'Account', 'Contact', 'Opportunity', 'Case', 'Task', 'Event', 'Order'];
  const counts = [];

  for (const obj of objects) {
    const c = await q(conn, `SELECT COUNT() FROM ${obj}`);
    counts.push({
      object: obj,
      count: c.ok ? c.totalSize : 'error: ' + (c.error || '').substring(0, 60)
    });
  }

  r.recordCounts = { ok: true, totalSize: counts.length, records: counts };

  // Custom objects with most records (top 10)
  // Can't easily query all custom objects count, so skip for now
  // Would need describe + individual COUNT queries

  return r;
}

// ══════════════════════════════════════════════
// EXPERIENCE CLOUD (existing)
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
// AGENTFORCE (existing)
// ══════════════════════════════════════════════
async function scanAgentforce(conn) {
  const r = {};
  r.agents = await q(conn, "SELECT Id, DeveloperName, MasterLabel FROM BotDefinition ORDER BY MasterLabel");
  r.agentVersions = await q(conn, "SELECT Id, DeveloperName, BotDefinitionId, Status FROM BotVersion ORDER BY BotDefinitionId, Status LIMIT 50");
  r.agentActions = await metaList(conn, 'GenAiFunction');
  r.agentTopics = await metaList(conn, 'GenAiPlanner');
  r.agentPlugins = await metaList(conn, 'GenAiPlugin');

  if (r.agents.ok && r.agents.records.length > 0) {
    const details = [];
    for (const agent of r.agents.records) {
      try {
        const d = await conn.metadata.read('Bot', agent.DeveloperName);
        if (d && d.fullName) {
          details.push({
            developerName: d.fullName, label: d.label, agentType: d.agentType,
            type: d.type, description: d.description,
            versionsCount: Array.isArray(d.botVersions) ? d.botVersions.length : d.botVersions ? 1 : 0
          });
        }
      } catch (e) { /* skip */ }
    }
    r.agentConfigs = { ok: true, totalSize: details.length, records: details };
  }

  r.embeddedServiceConfigs = await metaList(conn, 'EmbeddedServiceConfig');
  r.invocableFlows = await q(conn,
    "SELECT Id, Definition.DeveloperName, ProcessType, Status FROM Flow WHERE ProcessType = 'AutoLaunchedFlow' AND Status = 'Active' LIMIT 200", true);

  const apexResult = await q(conn,
    "SELECT Id, Name, Body FROM ApexClass WHERE Status = 'Active' AND NamespacePrefix = null LIMIT 500", true);
  if (apexResult.ok) {
    const filtered = apexResult.records.filter(c => c.Body && c.Body.includes('@InvocableMethod')).map(c => ({ Id: c.Id, Name: c.Name }));
    r.invocableApexClasses = { ok: true, totalSize: filtered.length, records: filtered };
  } else { r.invocableApexClasses = apexResult; }

  r.serviceChannels = await q(conn, "SELECT Id, DeveloperName, MasterLabel, RelatedEntity FROM ServiceChannel LIMIT 50");
  return r;
}

// ══════════════════════════════════════════════
// SCOPE REGISTRY
// ══════════════════════════════════════════════
const ALL_SCOPES = ['security', 'automation', 'objects', 'integration', 'users', 'data', 'experience', 'agentforce'];

const SCANNERS = {
  security: scanSecurity,
  automation: scanAutomation,
  objects: scanObjects,
  integration: scanIntegration,
  users: scanUsers,
  data: scanData,
  experience: scanExperienceCloud,
  agentforce: scanAgentforce,
};

// ══════════════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════════════

// GET /api/orgs/:id/setup-scan?scope=security,automation (or 'all')
router.get('/:id/setup-scan', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const conn = await connectToOrg(org);
    const scopeParam = (req.query.scope || 'all').toLowerCase();
    const scopes = scopeParam === 'all' ? ALL_SCOPES : scopeParam.split(',').map(s => s.trim());
    const scan = { org: { id: org.id, name: org.name }, timestamp: new Date().toISOString(), scopes };
    for (const scope of scopes) {
      if (SCANNERS[scope]) {
        scan[scope] = await SCANNERS[scope](conn);
      }
    }
    res.json(scan);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dynamic shortcut: GET /api/orgs/:id/setup-scan/:scope
router.get('/:id/setup-scan/:scope', authMiddleware, async (req, res) => {
  try {
    const scope = req.params.scope.toLowerCase();
    if (!SCANNERS[scope]) return res.status(400).json({ error: `Unknown scope: ${scope}. Available: ${ALL_SCOPES.join(', ')}` });
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const conn = await connectToOrg(org);
    const scan = { org: { id: org.id, name: org.name }, timestamp: new Date().toISOString() };
    scan[scope] = await SCANNERS[scope](conn);
    res.json(scan);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
