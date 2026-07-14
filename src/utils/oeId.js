// ============================================================================
// I9 ORG EXPLORER — Geração do OE_ID
// Spec v2.1 · Seção 8
// ============================================================================

/**
 * Gera o próximo OE-ID sequencial (OE-0001, OE-0002, ...).
 * Consulta o maior OE-ID existente em deploy_runs e incrementa.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} pgClient
 * @returns {Promise<string>}
 */
export async function nextOeId(pgClient) {
  const res = await pgClient.query(
    `SELECT oe_id FROM deploy_runs
     WHERE oe_id LIKE 'OE-%'
     ORDER BY id DESC LIMIT 1`
  );

  if (!res.rows.length) return 'OE-0001';

  const last = parseInt(res.rows[0].oe_id.split('-')[1], 10);
  return 'OE-' + String(last + 1).padStart(4, '0');
}
