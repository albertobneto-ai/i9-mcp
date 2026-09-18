// src/routes/uc.js — Casos de uso publicados: comentários de revisão.
// Rota pública e estreita: aceita somente o identificador do documento e o texto dos
// comentários, e grava em tabela própria. Não expõe repositório, credencial nem
// qualquer outra parte da API. Substitui o uso do proxy GitHub pelas páginas de UC.
import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// Documentos aceitos. Um caso de uso só passa a receber comentários depois de entrar aqui.
export const UC_DOCS = {
  'UC-VPN-001': { titulo: 'VPN Node', pagina: 'uc-vpn-node.html' },
  'UC-LOC-001': { titulo: 'Locação de Equipamentos', pagina: 'uc-locacao-equipamentos.html' },
  'UC-IA-001': { titulo: 'Inteligência Artificial', pagina: 'uc-inteligencia-artificial.html' },
  'UC-MSG-001': { titulo: 'Message Solution', pagina: 'uc-message-solution.html' },
  'UC-IPT-001': { titulo: 'IP Trânsito', pagina: 'uc-ip-transito.html' },
  'UC-ILK-001': { titulo: 'Internet Link', pagina: 'uc-internet-link.html' },
  'UC-L2L-001': { titulo: 'Lan to Lan', pagina: 'uc-lan-to-lan.html' },
  'UC-WAVELENGTH-001': { titulo: 'Wavelength', pagina: 'uc-wavelength.html' },
  'UC-SDW-001': { titulo: 'SD-WAN', pagina: 'uc-sd-wan.html' },
  'UC-HOS-001': { titulo: 'Hospedagem Dedicada', pagina: 'uc-hospedagem-dedicada.html' },
  'UC-MIR-001': { titulo: 'Monitoramento Inteligente de Rede', pagina: 'uc-monitoramento-inteligente-de-rede-mir.html' },
  'UC-ANTIDDOS-001': { titulo: 'Anti-DDoS', pagina: 'uc-anti-ddos-v2.html' },
};

const MAX_ITENS = 400;
const MAX_TEXTO = 4000;
const MAX_ROTULO = 300;

export async function initUcTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS uc_comentarios (
    id serial PRIMARY KEY,
    documento varchar(40) NOT NULL,
    rodada int NOT NULL,
    comentarios jsonb NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'ABERTA',
    aplicada_em timestamptz,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    UNIQUE (documento, rodada)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS uc_comentarios_doc
    ON uc_comentarios (documento, rodada DESC)`);
}

function doc(req, res) {
  const id = String(req.params.documento || '').toUpperCase();
  if (!UC_DOCS[id]) { res.status(404).json({ error: 'documento desconhecido' }); return null; }
  return id;
}
function rodada(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && n < 1000 ? n : null;
}
// Mantém só o que a página precisa gravar, no tamanho que cabe.
// Comentário vazio significa remover aquele item da rodada.
function limpar(bruto) {
  const out = {}, remover = [];
  const chaves = Object.keys(bruto || {}).slice(0, MAX_ITENS);
  for (const k of chaves) {
    const chave = String(k).slice(0, 80);
    if (!/^[a-z0-9-]+$/i.test(chave)) continue;
    const v = bruto[k] || {};
    const texto = String(v.comentario == null ? v : v.comentario).trim().slice(0, MAX_TEXTO);
    if (!texto) { remover.push(chave); continue; }
    out[chave] = { item: String(v.item || chave).slice(0, MAX_ROTULO), comentario: texto };
  }
  return { manter: out, remover };
}

// GET /api/uc/:documento/comentarios[?rodada=N] → rodada pedida, ou a mais recente
router.get('/:documento/comentarios', async (req, res) => {
  const id = doc(req, res); if (!id) return;
  try {
    const r = req.query.rodada ? rodada(req.query.rodada) : null;
    const q = r
      ? await pool.query(`SELECT * FROM uc_comentarios WHERE documento=$1 AND rodada=$2`, [id, r])
      : await pool.query(`SELECT * FROM uc_comentarios WHERE documento=$1
          ORDER BY rodada DESC LIMIT 1`, [id]);
    if (!q.rows.length) return res.status(404).json({ error: 'sem comentários' });
    const l = q.rows[0];
    res.json({ documento: l.documento, rodada: l.rodada, status: l.status,
      quando: l.atualizado_em, aplicada_em: l.aplicada_em, comentarios: l.comentarios });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/uc/:documento/rodadas → histórico enxuto, para o hub
router.get('/:documento/rodadas', async (req, res) => {
  const id = doc(req, res); if (!id) return;
  try {
    const q = await pool.query(`SELECT rodada, status, atualizado_em, aplicada_em, comentarios
      FROM uc_comentarios WHERE documento=$1 ORDER BY rodada DESC`, [id]);
    res.json({ documento: id, rodadas: q.rows.map(x => ({ rodada: x.rodada, status: x.status,
      quando: x.atualizado_em, aplicada_em: x.aplicada_em,
      total: Object.keys(x.comentarios || {}).length })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/uc/:documento/comentarios {rodada, comentarios} → grava a rodada inteira
router.post('/:documento/comentarios', async (req, res) => {
  const id = doc(req, res); if (!id) return;
  try {
    const r = rodada((req.body || {}).rodada);
    if (!r) return res.status(400).json({ error: 'rodada inválida' });
    const { manter, remover } = limpar((req.body || {}).comentarios);
    if (!Object.keys(manter).length && !remover.length)
      return res.status(400).json({ error: 'nenhum comentário' });
    // merge por item: quem comenta um atributo não apaga o comentário de outro revisor
    const q = await pool.query(`INSERT INTO uc_comentarios (documento, rodada, comentarios)
      VALUES ($1,$2,$3)
      ON CONFLICT (documento, rodada) DO UPDATE
      SET comentarios = (uc_comentarios.comentarios || EXCLUDED.comentarios) - $4::text[],
          atualizado_em = now()
      RETURNING rodada, atualizado_em, comentarios`,
      [id, r, JSON.stringify(manter), remover]);
    res.json({ ok: true, documento: id, rodada: q.rows[0].rodada,
      quando: q.rows[0].atualizado_em,
      total: Object.keys(q.rows[0].comentarios || {}).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/uc/:documento/comentarios/:rodada/aplicar
// O conteúdo do comentário passa a fazer parte do documento: a rodada sai da fila de revisão
// e fica registrada como aplicada, com o vínculo documento → item → texto.
router.post('/:documento/comentarios/:rodada/aplicar', async (req, res) => {
  const id = doc(req, res); if (!id) return;
  try {
    const r = rodada(req.params.rodada);
    if (!r) return res.status(400).json({ error: 'rodada inválida' });
    const q = await pool.query(`UPDATE uc_comentarios
      SET status = 'APLICADA', aplicada_em = now(), atualizado_em = now()
      WHERE documento=$1 AND rodada=$2
      RETURNING rodada, status, aplicada_em, comentarios`, [id, r]);
    if (!q.rows.length) return res.status(404).json({ error: 'rodada não encontrada' });
    const l = q.rows[0];
    res.json({ ok: true, documento: id, rodada: l.rodada, status: l.status,
      aplicada_em: l.aplicada_em, total: Object.keys(l.comentarios || {}).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/uc/:documento/comentarios/:rodada/reabrir — desfaz a aplicação
router.post('/:documento/comentarios/:rodada/reabrir', async (req, res) => {
  const id = doc(req, res); if (!id) return;
  try {
    const r = rodada(req.params.rodada);
    if (!r) return res.status(400).json({ error: 'rodada inválida' });
    const q = await pool.query(`UPDATE uc_comentarios
      SET status = 'ABERTA', aplicada_em = NULL, atualizado_em = now()
      WHERE documento=$1 AND rodada=$2 RETURNING rodada, status`, [id, r]);
    if (!q.rows.length) return res.status(404).json({ error: 'rodada não encontrada' });
    res.json({ ok: true, documento: id, rodada: q.rows[0].rodada, status: q.rows[0].status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
