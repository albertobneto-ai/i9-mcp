// Proxy GitHub mínimo — criado para persistir comentários de revisão (uc-vpn-node)
import { Router } from 'express';
const router = Router();
const GH = 'https://api.github.com';
const OWNER = 'albertobneto-ai';
const hdrs = () => ({
  'Authorization': `Bearer ${process.env.GH_TOKEN}`,
  'User-Agent': 'i9-mcp',
  'Accept': 'application/vnd.github+json'
});

// GET /api/github/repo/:repo/files?path=...  → conteúdo (base64, formato GitHub)
router.get('/repo/:repo/files', async (req, res) => {
  try {
    const { repo } = req.params; const { path } = req.query;
    if (!path) return res.status(400).json({ error: 'path obrigatório' });
    const url = `${GH}/repos/${OWNER}/${repo}/contents/${String(path).split('/').map(encodeURIComponent).join('/')}`;
    const r = await fetch(url, { headers: hdrs() });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/github/repo/:repo/file  {path, content(string), message}  → cria/atualiza
router.post('/repo/:repo/file', async (req, res) => {
  try {
    const { repo } = req.params; const { path, content, message } = req.body || {};
    if (!path || content === undefined) return res.status(400).json({ error: 'path e content obrigatórios' });
    const url = `${GH}/repos/${OWNER}/${repo}/contents/${String(path).split('/').map(encodeURIComponent).join('/')}`;
    let sha;
    const cur = await fetch(url, { headers: hdrs() });
    if (cur.ok) { const j = await cur.json(); sha = j.sha; }
    const body = {
      message: message || `chore: update ${path}`,
      content: Buffer.from(String(content), 'utf8').toString('base64'),
      ...(sha ? { sha } : {})
    };
    const r = await fetch(url, { method: 'PUT', headers: { ...hdrs(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    res.json({ ok: true, path, sha: j.content && j.content.sha });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
