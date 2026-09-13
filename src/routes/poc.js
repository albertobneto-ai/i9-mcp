// src/routes/poc.js — Sessões dos protótipos (Lightning e mobile) persistidas no Postgres.
// Rota pública e estreita, no mesmo espírito de routes/uc.js: aceita um código de sessão e
// um objeto de estado, e grava em tabela própria. Não expõe credenciais, repositório nem
// qualquer outra parte da API. O estado é o que a própria página já mantém em memória.
import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// O protótipo também é servido pelo domínio everi9.albertobottaro.info, então a sessão
// chega de outra origem. Liberação estreita: só estes hosts, só os métodos usados aqui.
const ORIGENS = new Set([
  'https://everi9.albertobottaro.info',
  'https://everi9.com',
  'https://www.everi9.com',
  'https://portal.albertobottaro.info',
  'https://i9-mcp-da48589780b2.herokuapp.com',
]);
router.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ORIGENS.has(o)) {
    res.set('Access-Control-Allow-Origin', o);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,PUT,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const MAX_BYTES = 400 * 1024;          // estado de uma sessão é pequeno; corta abuso
const CODIGO = /^[A-Za-z0-9_-]{4,40}$/; // código legível, sem caminho nem espaço
const PROTOS = ['lightning', 'mobile'];

export async function initPocTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS poc_sessoes (
    id serial PRIMARY KEY,
    codigo varchar(40) NOT NULL,
    proto varchar(20) NOT NULL DEFAULT 'lightning',
    rotulo varchar(120),
    estado jsonb NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    UNIQUE (codigo)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS poc_sessoes_atualizado
    ON poc_sessoes (atualizado_em DESC)`);
}

function codigoValido(req, res) {
  const c = String(req.params.codigo || req.body?.codigo || '').trim();
  if (!CODIGO.test(c)) { res.status(400).json({ error: 'código inválido' }); return null; }
  return c;
}

// grava (cria ou substitui) uma sessão
router.put('/sessoes/:codigo', async (req, res) => {
  const codigo = codigoValido(req, res); if (!codigo) return;
  const { estado, proto, rotulo } = req.body || {};
  if (!estado || typeof estado !== 'object') return res.status(400).json({ error: 'estado obrigatório' });
  const texto = JSON.stringify(estado);
  if (texto.length > MAX_BYTES) return res.status(413).json({ error: 'estado grande demais' });
  const p = PROTOS.includes(proto) ? proto : 'lightning';
  const r = String(rotulo || '').slice(0, 120) || null;
  try {
    await pool.query(
      `INSERT INTO poc_sessoes (codigo, proto, rotulo, estado)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (codigo) DO UPDATE
         SET estado = EXCLUDED.estado, proto = EXCLUDED.proto,
             rotulo = COALESCE(EXCLUDED.rotulo, poc_sessoes.rotulo),
             atualizado_em = now()`,
      [codigo, p, r, texto]
    );
    res.json({ ok: true, codigo, bytes: texto.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// lê uma sessão
router.get('/sessoes/:codigo', async (req, res) => {
  const codigo = codigoValido(req, res); if (!codigo) return;
  try {
    const { rows } = await pool.query(
      'SELECT codigo, proto, rotulo, estado, atualizado_em FROM poc_sessoes WHERE codigo = $1', [codigo]);
    if (!rows.length) return res.status(404).json({ error: 'sessão não encontrada' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// lista as sessões recentes, sem o estado
router.get('/sessoes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT codigo, proto, rotulo, atualizado_em,
              pg_column_size(estado) AS bytes
         FROM poc_sessoes ORDER BY atualizado_em DESC LIMIT 30`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// apaga uma sessão
router.delete('/sessoes/:codigo', async (req, res) => {
  const codigo = codigoValido(req, res); if (!codigo) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM poc_sessoes WHERE codigo = $1', [codigo]);
    res.json({ ok: true, apagadas: rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
