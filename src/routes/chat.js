import express from 'express';
import * as claude from '../services/claude.js';
import * as grok from '../services/grok.js';
import pool from '../config/db.js';

const router = express.Router();

const SYSTEM_PROMPT = `Você é o SF Agent, um assistente especialista em Salesforce (Sales Cloud, Service Cloud, Data Cloud, Revenue Cloud, Agentforce, MuleSoft).

Regras:
- Responda em português do Brasil
- Use terminologia técnica Salesforce quando relevante
- Seja direto e objetivo
- Formate com markdown quando útil
- Para perguntas técnicas, priorize configuração nativa (OOTB) > Flow > Apex
- Quando relevante, cite objetos padrão, APIs e boas práticas`;

router.post('/', async (req, res) => {
  try {
    const { messages, conversationId, model } = req.body;
    if (!messages || !Array.isArray(messages))
      return res.status(400).json({ error: 'messages obrigatorio' });

    const userMsg = messages[messages.length - 1]?.content || '';
    
    // Build conversation context
    const apiMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    let response, modelUsed, modelLabel;

    try {
      // Primary: Claude Sonnet 4.6
      response = await claude.call(SYSTEM_PROMPT, apiMessages);
      modelUsed = 'claude-sonnet-4-6';
      modelLabel = 'Claude Sonnet 4.6';
    } catch (claudeErr) {
      console.error('Claude failed, falling back to Grok:', claudeErr.message);
      try {
        response = await grok.call(SYSTEM_PROMPT, apiMessages);
        modelUsed = 'grok-4.20';
        modelLabel = 'Grok 4.20';
      } catch (grokErr) {
        console.error('Grok also failed:', grokErr.message);
        return res.status(500).json({ error: 'Nenhum modelo disponivel' });
      }
    }

    // Save conversation
    let convId = conversationId;
    try {
      const title = userMsg.substring(0, 80) || 'Conversa';
      const fullMsgs = [...messages, { role: 'assistant', content: response }];
      if (convId) {
        await pool.query(
          'UPDATE conversations SET messages = $1, title = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4',
          [JSON.stringify(fullMsgs), title, convId, req.user.id]
        );
      } else {
        const r = await pool.query(
          'INSERT INTO conversations (user_id, title, messages) VALUES ($1, $2, $3) RETURNING id',
          [req.user.id, title, JSON.stringify(fullMsgs)]
        );
        convId = r.rows[0].id;
      }
    } catch (dbErr) { console.error('Conv save failed:', dbErr.message); }

    res.json({
      choices: [{ message: { content: response } }],
      modelo_usado: modelUsed,
      modelo_label: modelLabel,
      tipo: 'chat',
      conversationId: convId
    });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
