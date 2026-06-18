import express from 'express';
import { getOutboundIP } from './services/sf-multi.js';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import pool from './config/db.js';
import authRoutes from './routes/auth.js';
import orgRoutes from './routes/orgs.js';
import downloadRoutes from './routes/download.js';
import { authMiddleware } from './middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-org-id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'running', server: 'i9-mcp', version: '1.0.1' });
});

// Init DB
app.get('/api/init-db', async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'funcional', session_version INT DEFAULT 1,
      token_limit BIGINT DEFAULT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255), messages JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id)');
    await pool.query(`CREATE TABLE IF NOT EXISTS orgs (
      id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL,
      login_url VARCHAR(255) NOT NULL, username VARCHAR(255) NOT NULL,
      password VARCHAR(255) NOT NULL, security_token VARCHAR(100) DEFAULT '',
      org_type VARCHAR(20) DEFAULT 'sandbox', org_id VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY, user_id INT, kind VARCHAR(40),
      status VARCHAR(20) DEFAULT 'pending', input TEXT,
      result TEXT, error TEXT, meta JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS deploy_log (
      id SERIAL PRIMARY KEY,
      us_number VARCHAR(40),
      component VARCHAR(255),
      action VARCHAR(60),
      description TEXT,
      result VARCHAR(20),
      result_message TEXT,
      org_id INT,
      org_name VARCHAR(100),
      user_id INT,
      user_name VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_deploylog_us ON deploy_log(us_number)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_deploylog_created ON deploy_log(created_at DESC)');
    // Additive: snapshot column for rollback
    try { await pool.query('ALTER TABLE deploy_log ADD COLUMN IF NOT EXISTS previous_state TEXT'); } catch {}
    const check = await pool.query("SELECT id FROM users WHERE email = 'admin@everi9.com'");
    if (check.rows.length === 0) {
      const hash = await bcrypt.hash('admin2026', 10);
      await pool.query("INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)",
        ['Alberto Bottaro', 'admin@everi9.com', hash, 'admin']);
    }
    res.json({ status: 'ok', tables: ['users', 'conversations', 'orgs', 'jobs', 'deploy_log'] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/orgs', orgRoutes);
app.use('/api/download', downloadRoutes);

// Job status polling
app.get('/api/jobs/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, kind, status, result, error, meta FROM jobs WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Job não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// KB Assistant (Haiku) — floating agent endpoint
import { knowledgeBase } from './config/knowledge-base.js';
import { callHaikuWithSearch } from './services/claude.js';
app.post('/api/kb-chat', authMiddleware, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !messages.length) return res.status(400).json({ error: 'messages required' });

    const systemPrompt = `Você é o assistente de conhecimento do projeto Salesforce Algar Telecom B2B. Responda perguntas com base na documentação abaixo. Seja conciso e direto. Se não souber, diga que não tem essa informação na base.

${knowledgeBase}

Regras:
- Responda em português do Brasil
- Seja objetivo (2-4 parágrafos no máximo)
- Use formatação markdown quando útil
- Se a pergunta não for sobre Salesforce ou o projeto, diga educadamente que você é especializado em Salesforce
- Você tem acesso a pesquisa web. Use-a para complementar respostas quando a base de conhecimento não tiver a informação completa
- Ao usar informações da web, mencione brevemente a fonte`;

    const userMsgs = messages.slice(-6); // últimas 6 mensagens para contexto
    const response = await callHaikuWithSearch(systemPrompt, userMsgs, 2048);
    res.json({ choices: [{ message: { content: response } }], model: 'haiku' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Analyze Error — Opus analisa erro + retorna step corrigido para auto-fix
app.post('/api/analyze-error', authMiddleware, async (req, res) => {
  try {
    const { step, error, orgName } = req.body;
    if (!step || !error) return res.status(400).json({ error: 'step e error obrigatórios' });

    const { callRouted } = await import('./services/claude.js');
    const sysPrompt = 'Você é um arquiteto Salesforce especialista em troubleshooting de deploys automatizados via jsforce/Node.js.\n\n' +
      'Analise o erro e sugira correção EXECUTÁVEL no formato que NOSSO orquestrador aceita.\n\n' +
      'RESPONDA neste formato:\n' +
      '1. **Causa:** (1-2 linhas)\n' +
      '2. **Correção:** (o que mudar)\n\n' +
      'Depois, OBRIGATORIAMENTE inclua um bloco com o step corrigido:\n' +
      '```json\n[{"action":"...", ...}]\n```\n\n' +
      '═══ ACTIONS VÁLIDAS (uma destas em cada step) ═══\n' +
      '• create-field — criar CustomField (USAR SEMPRE para campos, não metadata-create). Params: object, field, label, type, length?, picklist?, description?, required?\n' +
      '• metadata-create — criar metadado complexo (NÃO use para CustomField, use create-field). Params: type, body (config completa). Use para: ValidationRule, MatchingRule, DuplicateRule, RecordType, PermissionSet, etc.\n' +
      '• metadata-update — atualizar metadado. Params: type, fullName, body\n' +
      '• metadata-delete — deletar metadado. Params: type, fullName\n' +
      '• apex-class — criar/atualizar Apex Class. Params: name, body\n' +
      '• apex-trigger — criar/atualizar Trigger. Params: name, body, objectName, events\n' +
      '• layout-add-field — adicionar campo a layout. Params: layoutName, fieldName, sectionLabel, behavior\n' +
      '• profile-fls — atualizar FLS de Profile. Params: profileName, fieldPermissions\n' +
      '• activate-rule — ativar MR/DR. Params: ruleType, ruleName\n' +
      '• soql — executar SOQL. Params: query, description?\n' +
      '• validate — validar (Tooling/metadata-read). Params: type, fullName, expectedActive?\n' +
      '• apex — Apex anônimo. Params: code\n' +
      '• manual-step — passo manual descritivo. Params: description, instructions?\n\n' +
      '═══ FORMATOS ESPECIAIS (ATENÇÃO) ═══\n\n' +
      '🔸 Picklist no create-field — use APENAS array de strings:\n' +
      '   { "action":"create-field", "object":"Account", "field":"Origem__c", "label":"Origem", "type":"Picklist", "picklist":["Edição Manual","SERASA","Neoway","MuleSoft","Data Cloud"] }\n' +
      '   NUNCA usar valueSet, valueSetDefinition, fullName/default/label — isso é XML, NÃO funciona via jsforce!\n\n' +
      '🔸 Lookup no create-field:\n' +
      '   { "action":"create-field", "object":"Account", "field":"Parent__c", "label":"Conta Pai", "type":"Lookup", "referenceTo":"Account", "relationshipLabel":"Filhas" }\n\n' +
      '🔸 Number/Currency:\n' +
      '   { "action":"create-field", "object":"Lead", "field":"Score__c", "label":"Score", "type":"Number", "precision":10, "scale":2 }\n\n' +
      '🔸 ValidationRule (via metadata-create):\n' +
      '   { "action":"metadata-create", "metadataType":"ValidationRule", "body":{ "fullName":"Account.NomeRegra", "active":true, "errorConditionFormula":"...", "errorMessage":"..." } }\n\n' +
      '═══ REGRAS ═══\n' +
      '• Se campo não existe → create-field (cria o campo faltante)\n' +
      '• Se SOQL falha por campo inexistente → primeiro create-field, depois soql\n' +
      '• Se objeto não existe → metadata-create CustomObject\n' +
      '• Se Picklist falhou com erro XML/valueSet → REESCREVA com formato array simples acima\n' +
      '• Se NÃO for automatizável (Named Credential, OWD Settings) → escreva "MANUAL" e explique\n' +
      '• Sempre retorne array JSON: [{"action":"..."}], mesmo que seja 1 step só\n' +
      'Português do Brasil. Seja direto.';

    const result = await callRouted('chat', sysPrompt,
      [{ role: 'user', content: 'Org: ' + (orgName || 'N/A') + '\nStep: ' + JSON.stringify(step) + '\nErro: ' + error }],
      2048
    );

    // Extrair JSON do step corrigido
    let fixSteps = null;
    const jsonMatch = result.text.match(/```json\n([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].action) {
          fixSteps = parsed;
        }
      } catch {}
    }

    res.json({
      choices: [{ message: { content: result.text } }],
      model: result.model,
      fixSteps: fixSteps
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload HF — lê .docx e retorna texto + resumo
import mammoth from 'mammoth';
app.post('/api/upload-hf', authMiddleware, async (req, res) => {
  try {
    const { fileBase64, fileName } = req.body;
    if (!fileBase64) return res.status(400).json({ error: 'fileBase64 obrigatório' });

    // Decodifica base64 para buffer
    const buffer = Buffer.from(fileBase64, 'base64');

    // Extrai texto com mammoth
    const result = await mammoth.extractRawText({ buffer });
    const fullText = result.value.trim();

    if (!fullText || fullText.length < 50) {
      return res.json({ error: 'Documento vazio ou muito curto. Verifique o arquivo.' });
    }

    // Resumo rápido com Sonnet
    let summary = '';
    try {
      const { callRouted } = await import('./services/claude.js');
      const sumResult = await callRouted('chat',
        'Você é um analista Salesforce. Resuma a História Funcional abaixo em no máximo 5 linhas. Identifique: título/ID da US, escopo principal, objetos Salesforce envolvidos, e tipo de solução (OOTB, Flow, Apex). Responda em português do Brasil, formato markdown.',
        [{ role: 'user', content: fullText.substring(0, 6000) }],
        512
      );
      summary = sumResult.text;
    } catch (e) {
      summary = '⚠️ Resumo indisponível: ' + e.message;
    }

    res.json({
      text: fullText,
      summary,
      fileName: fileName || 'documento.docx',
      charCount: fullText.length
    });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao processar documento: ' + e.message });
  }
});

// Chat route (lazy load)
let chatRouter = null;
app.use('/api/chat', authMiddleware, async (req, res, next) => {
  if (!chatRouter) {
    const mod = await import('./routes/chat.js');
    chatRouter = mod.default;
  }
  chatRouter(req, res, next);
});

// Static frontend
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), err => {
    if (err) res.status(404).json({ error: 'Frontend not found' });
  });
});

// Global safety nets — prevent any uncaught error from killing the dyno
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const PORT = process.env.PORT || 3000;
app.get('/api/debug/sf-test', async (req, res) => {
  const https = await import('https');
  const start = Date.now();
  try {
    const result = await new Promise((resolve, reject) => {
      const r = https.default.request({
        hostname: 'test.salesforce.com',
        path: '/services/oauth2/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
      }, (response) => {
        let body = '';
        response.on('data', c => body += c);
        response.on('end', () => resolve({ status: response.statusCode, body: body.substring(0, 300), ms: Date.now() - start }));
      });
      r.on('error', e => reject(e));
      r.on('timeout', () => { r.destroy(); reject(new Error('timeout 15s')); });
      r.write('grant_type=password&client_id=SalesforceDevelopmentExperience&client_secret=1384510088588713504&username=alberto.bottaro%40aircompany.ai.arqevery&password=Nicework%400001bpQwYa7Yk0LdA6VVtkvEI5WBJ');
      r.end();
    });
    res.json(result);
  } catch (e) { res.json({ error: e.message, ms: Date.now() - start }); }
});

app.get('/api/debug/ip', async (req, res) => {
  try { const ip = await getOutboundIP(); res.json({ ip }); }
  catch (e) { res.json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`[i9-mcp] SF Agent v1.2 on port ${PORT}`));
