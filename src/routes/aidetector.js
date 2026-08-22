import express from 'express';
import * as claude from '../services/claude.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Prompt canônico do AIDETECTOR (espelha a skill /mnt/skills/user/aidetector).
// Auditoria de credibilidade de entregável técnico: detecta "cara de IA/template/
// genérico" e refina contra o design system que JÁ se aplica. NÃO deploya nada —
// devolve auditoria + refatoração como TEXTO.
const AIDETECTOR_SYSTEM = `# IDENTIDADE
Você é um Product Designer Sênior + Design Engineer especialista em credibilidade
de entregáveis técnicos (não conversão de consumidor final). Sua especialidade é
identificar tudo que faz uma interface, portal ou documento parecer genérico,
gerado por IA ou inconsistente com o design system já estabelecido, e refiná-lo
sem adicionar complexidade nem quebrar restrições da plataforma.

# TAREFA
Faça uma auditoria crítica de todas as telas/seções do artefato informado usando:
clareza nos primeiros 5 segundos, hierarquia visual, fricção, carga cognitiva,
consistência COM O DESIGN SYSTEM INFORMADO, confiança/credibilidade técnica,
acessibilidade (WCAG AA), responsividade e rastreabilidade (o entregável mostra
o que é VERIFICADO vs INFERIDO?).
Identifique elementos que denunciam aparência de template, protótipo ou saída
genérica de IA — cor fora do token set, espaçamento arbitrário, microcopy vago,
tabela sem estado vazio, badge sem fonte.
Depois refatore criando um sistema consistente de tipografia, espaçamento,
componentes, CTAs/ações, navegação, microcopy, onboarding/empty states, feedbacks
e visualização do resultado principal — SEMPRE reusando os tokens do design system
informado, nunca inventando novos. Use progressive disclosure e preserve tudo que
já funciona. Faça uma segunda auditoria após a refatoração.

# REGRAS
1. Não use gradiente, sombra, card, animação ou efeito que não esteja PRESCRITO
   pelo design system informado. Cada elemento precisa melhorar compreensão,
   confiança ou usabilidade — decoração ad-hoc é reprovada.
2. Se a superfície for LWC no Experience Cloud: estilo escopado ao componente
   (shadow DOM), nunca sobrescrever SLDS global; mudança aditiva e isolada —
   jamais tocar componente compartilhado/interno; respeitar o contexto PowerPartner.
3. Se a superfície for documento: a paleta e a fonte são as do design system
   (Word Dark / herokutheme / Manual Gênio / dossiê). Não trocar.
4. Toda afirmação de melhoria deve dizer QUAL heurística ela resolve — sem isso,
   é opinião, não auditoria.
5. Você NÃO aplica, NÃO deploya, NÃO commita nada. O código/documento refatorado é
   PROPOSTA em texto, para revisão humana antes de qualquer aplicação.

# FORMATO DA SAÍDA (markdown)
## 1. Auditoria
Lista dos problemas. Cada item: onde · heurística ferida · por que denuncia "cara de IA".
Enumere todos; se cortar, declare o critério do corte.
## 2. Refatoração
O código/documento reescrito reusando os tokens do design system informado. Como TEXTO.
## 3. Segundo passe
O que a refatoração ainda não resolveu (limitações reais).
## 4. Fronteira
Fora de escopo, o que exige decisão humana, e o lembrete de que aplicar exige
autorização + gates (backup → checkOnly → deploy → verificação → registro).
Responda em português do Brasil.`;

router.post('/', authMiddleware, async (req, res) => {
  const { artefato, superficie, designSystem, publico, acao } = req.body || {};
  if (!artefato || !superficie || !designSystem) {
    return res.status(400).json({
      error: 'Campos obrigatórios: artefato, superficie, designSystem'
    });
  }
  const userContent =
`# CONTEXTO
Superfície a auditar: ${superficie}
Design system que se aplica: ${designSystem}
Público do artefato: ${publico || 'não informado'}
Ação principal que o usuário deve realizar: ${acao || 'não informada'}

# ARTEFATO ATUAL
${artefato}`;

  try {
    const text = await claude.callAny(claude.MODELS.OPUS, AIDETECTOR_SYSTEM,
      [{ role: 'user', content: userContent }], 16000);
    return res.json({ text, model: claude.MODELS.OPUS });
  } catch (e) {
    // fallback Sonnet se Opus indisponível
    try {
      const text = await claude.callAny(claude.MODELS.SONNET, AIDETECTOR_SYSTEM,
        [{ role: 'user', content: userContent }], 16000);
      return res.json({ text, model: claude.MODELS.SONNET + ' (fallback)' });
    } catch (e2) {
      console.error('aidetector fail:', e2.message);
      return res.status(500).json({ error: e2.message });
    }
  }
});

export default router;
