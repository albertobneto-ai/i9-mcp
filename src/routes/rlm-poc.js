// src/routes/rlm-poc.js — POC Pricing Headless RLM (arqevery)
// Demonstra o padrão "callout server-side direto": este backend faz o papel
// do app server do SFCC, chamando as Connect APIs do Revenue Cloud na org
// via HTTPS + Bearer token, sem middleware intermediário. Mede a latência
// de cada chamada (tempo backend <-> org).
import { Router } from 'express';
import pool from '../config/db.js';
import { connectToOrg } from '../services/sf-multi.js';

const router = Router();
const ORG_ID = 36; // arqevery
const API_V = 'v67.0';
const CATALOG_NAME = 'Catalogo Algar B2B POC';
const STANDARD_PRICEBOOK = '01sHp00000B3oLxIAJ';
const CONTEXT_NAME = 'RLM_SalesTransactionContext';

async function getConn() {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [ORG_ID]);
  if (!r.rows.length) throw new Error('Org ' + ORG_ID + ' não cadastrada');
  return connectToOrg(r.rows[0]);
}

// fetch cru contra a org com medição de tempo; nunca lança em 4xx/5xx
async function sfCall(conn, method, pathUrl, body) {
  const t0 = Date.now();
  let httpStatus = 0, parsed = null, raw = '';
  try {
    const resp = await fetch(conn.instanceUrl + pathUrl, {
      method,
      headers: {
        Authorization: 'Bearer ' + conn.accessToken,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    httpStatus = resp.status;
    raw = await resp.text();
    try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  } catch (e) {
    parsed = { transportError: e.message };
  }
  return { ms: Date.now() - t0, httpStatus, body: parsed };
}

function classify(check) {
  const b = check.body;
  const txt = JSON.stringify(b || '');
  if (check.httpStatus === 200 && !txt.includes('"severity":"Error"')) return 'ok';
  if (txt.includes('SF-Pricing-00004')) return 'blocked_procedure';
  if (txt.includes('context') || txt.includes('Context')) return 'blocked_context';
  if (txt.includes('SF-Pricing-00002')) return 'ok_engine'; // engine respondeu, validou input
  return 'error';
}

// ── GET /api/rlm-poc/status — diagnóstico vivo das 3 APIs headless ──
router.get('/status', async (req, res) => {
  try {
    const conn = await getConn();
    const cat = await resolveCatalog(conn);

    const [catalogs, products, pricing] = await Promise.all([
      sfCall(conn, 'POST', `/services/data/${API_V}/connect/cpq/catalogs`, { limit: 5 }),
      sfCall(conn, 'POST', `/services/data/${API_V}/connect/cpq/products`,
        cat ? { catalogId: cat.id, limit: 5 } : { limit: 5 }),
      sfCall(conn, 'POST', `/services/data/${API_V}/connect/core-pricing/pricing`, {
        contextDefinitionId: CONTEXT_NAME,
        contextMappingId: CONTEXT_NAME,
        jsonDataString: '{}',
      }),
    ]);

    res.json({
      org: 'arqevery (org_id=36)',
      instance: conn.instanceUrl,
      apiVersion: API_V,
      checks: [
        { name: 'Product Discovery — Catalog List', path: '/connect/cpq/catalogs', ...catalogs, state: classify(catalogs) },
        { name: 'Product Discovery — Products List', path: '/connect/cpq/products', ...products, state: classify(products) },
        { name: 'Salesforce Pricing — Headless', path: '/connect/core-pricing/pricing', ...pricing, state: classify(pricing) },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function resolveCatalog(conn) {
  try {
    const q = await conn.query(
      `SELECT Id, Name FROM ProductCatalog WHERE Name = '${CATALOG_NAME}' LIMIT 1`);
    if (!q.records.length) return null;
    return { id: q.records[0].Id, name: q.records[0].Name };
  } catch { return null; }
}

// ── GET /api/rlm-poc/vitrine — produtos reais do catálogo POC (SOQL) ──
router.get('/vitrine', async (req, res) => {
  try {
    const conn = await getConn();
    const t0 = Date.now();
    const cat = await resolveCatalog(conn);
    if (!cat) return res.json({ catalog: null, products: [], ms: Date.now() - t0 });

    const pcp = await conn.query(
      `SELECT ProductId, Product.Name, Product.ProductCode, ProductCategory.Name
         FROM ProductCategoryProduct
        WHERE ProductCategory.CatalogId = '${cat.id}' LIMIT 50`);
    const ids = pcp.records.map(r => `'${r.ProductId}'`).join(',');
    let prices = {};
    if (ids) {
      const pbe = await conn.query(
        `SELECT Product2Id, UnitPrice FROM PricebookEntry
          WHERE Product2Id IN (${ids}) AND Pricebook2Id = '${STANDARD_PRICEBOOK}' AND IsActive = true`);
      pbe.records.forEach(r => { prices[r.Product2Id] = r.UnitPrice; });
    }
    res.json({
      catalog: cat,
      ms: Date.now() - t0,
      products: pcp.records.map(r => ({
        id: r.ProductId,
        name: r.Product.Name,
        code: r.Product.ProductCode,
        category: r.ProductCategory ? r.ProductCategory.Name : null,
        listPrice: prices[r.ProductId] ?? null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rlm-poc/price — 1 cesta = 1 callout à Pricing headless ──
// body: { items: [{ productId, qty, unitPrice }] }
router.post('/price', async (req, res) => {
  try {
    const items = (req.body && req.body.items) || [];
    if (!items.length) return res.status(400).json({ error: 'Cesta vazia' });
    const conn = await getConn();

    const cartItems = items.map((it, i) => ({
      id: 'lineItem_' + (i + 1),
      line_item_id: 'lineItem_' + (i + 1),
      Quantity: Number(it.qty) || 1,
      PriceType: 'Recurring',
      Frequency: 'Monthly',
      UOM: '',
      businessObjectType: 'CartItem',
      product_id: it.productId,
      UnitPrice: Number(it.unitPrice) || 0,
      NetUnitPrice: 0,
    }));
    const payload = {
      contextDefinitionId: CONTEXT_NAME,
      contextMappingId: CONTEXT_NAME,
      jsonDataString: JSON.stringify({
        Cart: [{
          id: 'cart_poc', cart_id: 'cart_poc',
          PriceBookId: STANDARD_PRICEBOOK,
          businessObjectType: 'Cart',
          CartItem: cartItems,
        }],
      }),
      configurationOverrides: { skipWaterfall: true },
    };

    const call = await sfCall(conn, 'POST',
      `/services/data/${API_V}/connect/core-pricing/pricing`, payload);

    res.json({
      itemCount: items.length,
      calloutMs: call.ms,          // tempo backend <-> org (o número da POC)
      httpStatus: call.httpStatus,
      state: classify(call),
      requestPayload: payload,
      orgResponse: call.body,       // resposta CRUA da org, transparente
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
