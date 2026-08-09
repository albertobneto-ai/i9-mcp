// src/routes/revenue-cloud.js — F6: Revenue Cloud Scan + Catalog Deploy
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { connectToOrg } from '../services/sf-multi.js';
import pool from '../config/db.js';

const router = express.Router();

async function getOrgById(id) {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function q(conn, soql) {
  try {
    const result = await conn.query(soql);
    return { ok: true, totalSize: result.totalSize, records: result.records || [] };
  } catch (e) { return { ok: false, error: e.message?.substring(0, 150) }; }
}

// ══════════════════════════════════════════════
// REVENUE CLOUD SCAN
// ══════════════════════════════════════════════
// GET /api/orgs/:id/revenue-cloud/scan
router.get('/:id/revenue-cloud/scan', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const conn = await connectToOrg(org);

    const scan = {
      org: { id: org.id, name: org.name },
      timestamp: new Date().toISOString()
    };

    // Catalog structure
    scan.productCatalog = await q(conn,
      "SELECT Id, Name, DeveloperName FROM ProductCatalog ORDER BY Name LIMIT 50");

    scan.productCategory = await q(conn,
      "SELECT Id, Name, DeveloperName, ParentCategoryId, CatalogId FROM ProductCategory ORDER BY Name LIMIT 200");

    scan.productClassification = await q(conn,
      "SELECT Id, Name, DeveloperName FROM ProductClassification ORDER BY Name LIMIT 100");

    // Products
    scan.products = await q(conn,
      "SELECT Id, Name, ProductCode, IsActive, Family, Description FROM Product2 WHERE IsActive = true ORDER BY Name LIMIT 200");

    // Selling Models
    scan.productSellingModel = await q(conn,
      "SELECT Id, Name, SellingModelType, PricingTerm, PricingTermUnit FROM ProductSellingModel ORDER BY Name LIMIT 100");

    scan.productSellingModelOption = await q(conn,
      "SELECT Id, ProductSellingModelId, Product2Id FROM ProductSellingModelOption LIMIT 200");

    // Pricing
    scan.pricebookEntries = await q(conn,
      "SELECT Id, Product2.Name, Pricebook2.Name, UnitPrice, IsActive FROM PricebookEntry WHERE IsActive = true ORDER BY Product2.Name LIMIT 300");

    scan.priceAdjustmentSchedule = await q(conn,
      "SELECT Id, Name, DeveloperName, AdjustmentMethod, AdjustmentType FROM PriceAdjustmentSchedule ORDER BY Name LIMIT 100");

    scan.priceAdjustmentTier = await q(conn,
      "SELECT Id, PriceAdjustmentScheduleId, LowerBound, UpperBound, AdjustmentValue FROM PriceAdjustmentTier ORDER BY PriceAdjustmentScheduleId, LowerBound LIMIT 200");

    // Attributes
    scan.attributeDefinitions = await q(conn,
      "SELECT Id, DeveloperName, MasterLabel, DataType FROM AttributeDefinition ORDER BY MasterLabel LIMIT 200");

    scan.attributePicklist = await q(conn,
      "SELECT Id, DeveloperName, MasterLabel FROM AttributePicklist ORDER BY MasterLabel LIMIT 100");

    scan.attributePicklistValues = await q(conn,
      "SELECT Id, AttributePicklistId, Value, IsDefault FROM AttributePicklistValue ORDER BY AttributePicklistId, Value LIMIT 500");

    // Adjustment Rules
    scan.attrBasedAdjustmentRules = await q(conn,
      "SELECT Id, DeveloperName, MasterLabel FROM AttrBasedAdjustmentRule ORDER BY MasterLabel LIMIT 100");

    scan.attrBasedAdjConditions = await q(conn,
      "SELECT Id, AdjustmentRuleId, AttributeDefinitionId FROM AttrBasedAdjCondition LIMIT 200");

    scan.attrBasedAdjustments = await q(conn,
      "SELECT Id, AdjustmentRuleId, AdjustmentType, AdjustmentValue FROM AttrBasedAdj LIMIT 200");

    // Expression Sets
    scan.expressionSets = await q(conn,
      "SELECT Id, DeveloperName, MasterLabel, UsageType FROM ExpressionSet ORDER BY MasterLabel LIMIT 100");

    scan.expressionSetSteps = await q(conn,
      "SELECT Id, ExpressionSetId, ActionType, Name FROM ExpressionSetStep ORDER BY ExpressionSetId LIMIT 300");

    // Ramps
    scan.productRampSegments = await q(conn,
      "SELECT Id, Name, SegmentStartValue, SegmentEndValue, SegmentValue FROM ProductRampSegment ORDER BY Name LIMIT 200");

    // Cost & Policies
    scan.costbookEntries = await q(conn,
      "SELECT Id, CostbookId, Product2Id, UnitCost FROM CostbookEntry LIMIT 200");

    scan.indexRates = await q(conn,
      "SELECT Id, Name, RateValue FROM IndexRate ORDER BY Name LIMIT 100");

    scan.priceRevisionPolicy = await q(conn,
      "SELECT Id, DeveloperName, MasterLabel FROM PriceRevisionPolicy ORDER BY MasterLabel LIMIT 50");

    scan.prorationPolicy = await q(conn,
      "SELECT Id, DeveloperName, MasterLabel FROM ProrationPolicy ORDER BY MasterLabel LIMIT 50");

    scan.disqualificationRules = await q(conn,
      "SELECT Id, DeveloperName, MasterLabel FROM DisqualificationRule ORDER BY MasterLabel LIMIT 50");

    // Bundle
    scan.bundleAdjustments = await q(conn,
      "SELECT Id, DeveloperName, MasterLabel FROM BundlePolicy ORDER BY MasterLabel LIMIT 50");

    // Quotes & Orders (volume only)
    scan.quoteCount = await q(conn, "SELECT COUNT() FROM Quote");
    scan.quoteLineItemCount = await q(conn, "SELECT COUNT() FROM QuoteLineItem");
    scan.orderCount = await q(conn, "SELECT COUNT() FROM Order");
    scan.orderItemCount = await q(conn, "SELECT COUNT() FROM OrderItem");

    // Summary
    const summary = {};
    for (const [key, val] of Object.entries(scan)) {
      if (typeof val === 'object' && val !== null && 'ok' in val) {
        summary[key] = val.ok ? val.totalSize : 'error';
      }
    }
    scan.summary = summary;

    res.json(scan);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// REVENUE CLOUD CATALOG DEPLOY
// ══════════════════════════════════════════════
// POST /api/orgs/:id/revenue-cloud/deploy-catalog
// Body: { catalog, categories[], products[], attributes[], pricebookEntries[] }
// Deploys in dependency order: Catalog → Category → Product → Attribute → PBE
router.post('/:id/revenue-cloud/deploy-catalog', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    if (org.read_only) return res.status(403).json({ error: 'Org is read-only' });
    const conn = await connectToOrg(org);

    const { catalog, categories, products, attributes, pricebookEntries } = req.body;
    const results = [];

    // Step 1: Catalog
    if (catalog) {
      try {
        const r = await conn.sobject('ProductCatalog').create(catalog);
        results.push({ step: 'catalog', name: catalog.Name, ok: r.success, id: r.id, error: r.success ? null : JSON.stringify(r.errors) });
      } catch (e) { results.push({ step: 'catalog', ok: false, error: e.message?.substring(0, 100) }); }
    }

    // Step 2: Categories
    if (categories && categories.length > 0) {
      for (const cat of categories) {
        try {
          const r = await conn.sobject('ProductCategory').create(cat);
          results.push({ step: 'category', name: cat.Name, ok: r.success, id: r.id, error: r.success ? null : JSON.stringify(r.errors) });
        } catch (e) { results.push({ step: 'category', name: cat.Name, ok: false, error: e.message?.substring(0, 100) }); }
      }
    }

    // Step 3: Products
    if (products && products.length > 0) {
      try {
        const r = await conn.sobject('Product2').create(products);
        const rArr = Array.isArray(r) ? r : [r];
        rArr.forEach((res2, i) => {
          results.push({ step: 'product', name: products[i]?.Name, ok: res2.success, id: res2.id, error: res2.success ? null : JSON.stringify(res2.errors) });
        });
      } catch (e) { results.push({ step: 'products', ok: false, error: e.message?.substring(0, 100) }); }
    }

    // Step 4: Attributes
    if (attributes && attributes.length > 0) {
      for (const attr of attributes) {
        try {
          const r = await conn.sobject('AttributeDefinition').create(attr);
          results.push({ step: 'attribute', name: attr.MasterLabel || attr.DeveloperName, ok: r.success, id: r.id, error: r.success ? null : JSON.stringify(r.errors) });
        } catch (e) { results.push({ step: 'attribute', ok: false, error: e.message?.substring(0, 100) }); }
      }
    }

    // Step 5: PricebookEntries
    if (pricebookEntries && pricebookEntries.length > 0) {
      try {
        const r = await conn.sobject('PricebookEntry').create(pricebookEntries);
        const rArr = Array.isArray(r) ? r : [r];
        rArr.forEach((res2, i) => {
          results.push({ step: 'pricebookEntry', ok: res2.success, id: res2.id, error: res2.success ? null : JSON.stringify(res2.errors) });
        });
      } catch (e) { results.push({ step: 'pricebookEntries', ok: false, error: e.message?.substring(0, 100) }); }
    }

    const ok = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok).length;

    res.json({
      org: { id: org.id, name: org.name },
      summary: { total: results.length, ok, fail },
      results
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
