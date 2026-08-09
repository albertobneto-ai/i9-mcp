// src/routes/spec-context.js — F4: Spec Context Generator
// Produces structured org context for feeding into /spec and /hf prompts
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

// ══════════════════════════════════════════════
// SPEC CONTEXT — Org context for a specific object
// ══════════════════════════════════════════════
// GET /api/orgs/:id/spec-context/:object
// Returns everything a /spec needs to know about this object in this org
router.get('/:id/spec-context/:object', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const conn = await connectToOrg(org);
    const obj = req.params.object;

    const context = {
      org: { id: org.id, name: org.name },
      object: obj,
      timestamp: new Date().toISOString(),
      status: 'VERIFICADO'
    };

    // 1. Custom Fields
    context.customFields = await q(conn,
      `SELECT QualifiedApiName, DataType, Label, IsRequired FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${obj}' AND IsCustom = true ORDER BY QualifiedApiName LIMIT 300`);

    // 2. Standard Fields (key ones)
    context.standardFields = await q(conn,
      `SELECT QualifiedApiName, DataType, Label, IsRequired FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${obj}' AND IsCustom = false AND IsCompound = false ORDER BY QualifiedApiName LIMIT 200`);

    // 3. Record Types
    context.recordTypes = await q(conn,
      `SELECT Id, Name, DeveloperName, IsActive FROM RecordType WHERE SobjectType = '${obj}' AND IsActive = true ORDER BY Name`);

    // 4. Validation Rules
    context.validationRules = await q(conn,
      `SELECT Id, ValidationName, Active, ErrorMessage FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${obj}' AND Active = true`, true);

    // 5. Flows related to this object
    context.relatedFlows = await q(conn,
      `SELECT Id, Definition.DeveloperName, ProcessType, Status, TriggerType FROM Flow WHERE Status = 'Active' AND (ProcessType = 'AutoLaunchedFlow' OR ProcessType = 'RecordTriggeredFlow') LIMIT 200`, true);
    // Filter flows that reference this object (by name convention)
    if (context.relatedFlows.ok) {
      const objLower = obj.toLowerCase().replace('__c', '');
      context.relatedFlows.records = context.relatedFlows.records.filter(f => {
        const name = (f.Definition?.DeveloperName || '').toLowerCase();
        return name.includes(objLower);
      });
      context.relatedFlows.totalSize = context.relatedFlows.records.length;
    }

    // 6. Apex Triggers
    context.apexTriggers = await q(conn,
      `SELECT Id, Name, Status FROM ApexTrigger WHERE TableEnumOrId = '${obj}' AND Status = 'Active' AND NamespacePrefix = null`, true);

    // 7. Page Layouts
    context.pageLayouts = await q(conn,
      `SELECT Id, Name FROM Layout WHERE EntityDefinitionId = '${obj}' LIMIT 50`, true);

    // 8. FLS Coverage (which PS have access to this object)
    context.flsCoverage = await q(conn,
      `SELECT Parent.Name, Parent.Label, COUNT(Id) fieldCount FROM FieldPermissions WHERE SobjectType = '${obj}' GROUP BY Parent.Name, Parent.Label ORDER BY COUNT(Id) DESC LIMIT 30`);

    // 9. OWD for this object
    context.owd = await q(conn,
      `SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE QualifiedApiName = '${obj}'`);

    // 10. Record count
    try {
      const countResult = await conn.query(`SELECT COUNT() FROM ${obj}`);
      context.recordCount = { ok: true, count: countResult.totalSize };
    } catch (e) {
      context.recordCount = { ok: false, error: e.message?.substring(0, 100) };
    }

    res.json(context);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// SPEC CONTEXT — Multi-object (for specs that span multiple objects)
// ══════════════════════════════════════════════
// GET /api/orgs/:id/spec-context?objects=Lead,Account,Contact
router.get('/:id/spec-context', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const conn = await connectToOrg(org);
    const objectsParam = req.query.objects || 'Lead';
    const objects = objectsParam.split(',').map(o => o.trim());

    const result = {
      org: { id: org.id, name: org.name },
      timestamp: new Date().toISOString(),
      objects: {}
    };

    for (const obj of objects) {
      const ctx = {};

      // Custom Fields
      ctx.customFields = await q(conn,
        `SELECT QualifiedApiName, DataType, Label, IsRequired FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${obj}' AND IsCustom = true ORDER BY QualifiedApiName LIMIT 300`);

      // Record Types
      ctx.recordTypes = await q(conn,
        `SELECT Name, DeveloperName, IsActive FROM RecordType WHERE SobjectType = '${obj}' AND IsActive = true ORDER BY Name`);

      // VRs
      ctx.validationRules = await q(conn,
        `SELECT ValidationName, Active, ErrorMessage FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${obj}' AND Active = true`, true);

      // Triggers
      ctx.apexTriggers = await q(conn,
        `SELECT Name, Status FROM ApexTrigger WHERE TableEnumOrId = '${obj}' AND Status = 'Active' AND NamespacePrefix = null`, true);

      // OWD
      ctx.owd = await q(conn,
        `SELECT InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE QualifiedApiName = '${obj}'`);

      // Record count
      try {
        const c = await conn.query(`SELECT COUNT() FROM ${obj}`);
        ctx.recordCount = c.totalSize;
      } catch (e) { ctx.recordCount = 'error'; }

      result.objects[obj] = ctx;
    }

    // Cross-cutting: PS that have FLS on any of these objects
    result.permissionSets = await q(conn,
      `SELECT Parent.Name, Parent.Label, SobjectType, COUNT(Id) fieldCount FROM FieldPermissions WHERE SobjectType IN ('${objects.join("','")}') GROUP BY Parent.Name, Parent.Label, SobjectType ORDER BY Parent.Label, SobjectType LIMIT 200`);

    // Active Flows across all objects
    const flowResult = await q(conn,
      "SELECT Definition.DeveloperName, ProcessType, TriggerType FROM Flow WHERE Status = 'Active' LIMIT 300", true);
    if (flowResult.ok) {
      const relevantFlows = flowResult.records.filter(f => {
        const name = (f.Definition?.DeveloperName || '').toLowerCase();
        return objects.some(obj => name.includes(obj.toLowerCase().replace('__c', '')));
      });
      result.relatedFlows = { ok: true, totalSize: relevantFlows.length, records: relevantFlows };
    }

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// GAP ANALYSIS — Compare HF requirements against org state
// ══════════════════════════════════════════════
// POST /api/orgs/:id/spec-context/gap
// Body: { objects: ["Lead"], requiredFields: ["Cnpj__c", "NewField__c"], requiredFlows: ["Lead_AutoAssign"] }
router.post('/:id/spec-context/gap', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const conn = await connectToOrg(org);

    const { objects, requiredFields, requiredFlows, requiredVRs } = req.body;
    const gap = {
      org: { id: org.id, name: org.name },
      timestamp: new Date().toISOString(),
      analysis: {}
    };

    // Check required fields
    if (requiredFields && requiredFields.length > 0) {
      const fieldGap = { exists: [], missing: [] };
      for (const field of requiredFields) {
        const parts = field.split('.');
        const obj = parts.length > 1 ? parts[0] : (objects?.[0] || 'Lead');
        const fieldName = parts.length > 1 ? parts[1] : parts[0];
        const check = await q(conn,
          `SELECT QualifiedApiName, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${obj}' AND QualifiedApiName = '${fieldName}'`);
        if (check.ok && check.totalSize > 0) {
          fieldGap.exists.push({ field: `${obj}.${fieldName}`, dataType: check.records[0].DataType, status: 'EXISTE' });
        } else {
          fieldGap.missing.push({ field: `${obj}.${fieldName}`, status: 'CRIAR' });
        }
      }
      gap.analysis.fields = fieldGap;
    }

    // Check required flows
    if (requiredFlows && requiredFlows.length > 0) {
      const flowGap = { exists: [], missing: [] };
      for (const flowName of requiredFlows) {
        const check = await q(conn,
          `SELECT Id, Definition.DeveloperName, Status FROM Flow WHERE Definition.DeveloperName = '${flowName}' AND Status = 'Active'`, true);
        if (check.ok && check.totalSize > 0) {
          flowGap.exists.push({ flow: flowName, status: 'ATIVO' });
        } else {
          flowGap.missing.push({ flow: flowName, status: 'CRIAR' });
        }
      }
      gap.analysis.flows = flowGap;
    }

    // Check required VRs
    if (requiredVRs && requiredVRs.length > 0) {
      const vrGap = { exists: [], missing: [] };
      for (const vrName of requiredVRs) {
        const check = await q(conn,
          `SELECT Id, ValidationName FROM ValidationRule WHERE ValidationName = '${vrName}' AND Active = true`, true);
        if (check.ok && check.totalSize > 0) {
          vrGap.exists.push({ vr: vrName, status: 'ATIVA' });
        } else {
          vrGap.missing.push({ vr: vrName, status: 'CRIAR' });
        }
      }
      gap.analysis.validationRules = vrGap;
    }

    // Summary
    const fields = gap.analysis.fields || { exists: [], missing: [] };
    const flows = gap.analysis.flows || { exists: [], missing: [] };
    const vrs = gap.analysis.validationRules || { exists: [], missing: [] };

    gap.summary = {
      totalChecked: fields.exists.length + fields.missing.length + flows.exists.length + flows.missing.length + vrs.exists.length + vrs.missing.length,
      exists: fields.exists.length + flows.exists.length + vrs.exists.length,
      toCreate: fields.missing.length + flows.missing.length + vrs.missing.length
    };

    res.json(gap);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
