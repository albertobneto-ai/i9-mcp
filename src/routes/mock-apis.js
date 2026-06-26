import { Router } from 'express';
const router = Router();

// ══════════════════════════════════════════════════
// MOCK APIs — Endpoints para teste de Named Credentials
// Simula Neoway, Receita Federal, Blacklist Anatel,
// WhatsApp ASC e Landing Page inbound
// ══════════════════════════════════════════════════

// ── NEOWAY: GET /empresa/:cnpj ──
router.get('/neoway/empresa/:cnpj', (req, res) => {
  const cnpj = req.params.cnpj.replace(/\D/g, '');
  const mocks = {
    '71208516000174': { // Algar Telecom
      data: {
        porte: 'Grande', faixa_funcionarios: 'Acima de 5.000',
        ticket_potencial: 850000, situacao_cadastral: 'Ativa',
        logradouro: 'Rua José Alves Garcia', numero: '415',
        bairro: 'Osvaldo Rezende', cidade: 'Uberlândia',
        estado: 'MG', cep: '38400098', complemento: 'Bloco A',
        segmento: 'Corporativo'
      }
    },
    '11111111000111': { // Parcial
      data: {
        porte: 'Micro', faixa_funcionarios: '1 a 10',
        situacao_cadastral: 'Ativa', cidade: 'São Paulo', estado: 'SP'
      }
    },
    '99999999000199': { // Baixada
      data: { situacao_cadastral: 'Baixada', porte: '', cidade: '', estado: '' }
    },
  };
  const mock = mocks[cnpj];
  if (!mock) return res.status(404).json({ error: 'CNPJ não encontrado na base Neoway', cnpj });
  res.json(mock);
});

// ── RECEITA FEDERAL: GET /cnpj/:cnpj ──
router.get('/rf/cnpj/:cnpj', (req, res) => {
  const cnpj = req.params.cnpj.replace(/\D/g, '');
  const mocks = {
    '71208516000174': {
      situacao: 'Ativa', nome: 'ALGAR TELECOM S/A',
      municipio: 'Uberlândia', uf: 'MG', abertura: '1954-11-05',
      natureza_juridica: '2046 - Sociedade Anônima Aberta',
      cnae_fiscal: '6110803', cnae_fiscal_descricao: 'Serviço telefônico fixo comutado'
    },
    '11111111000111': {
      situacao: 'Ativa', nome: 'EMPRESA TESTE LTDA',
      municipio: 'São Paulo', uf: 'SP'
    },
    '99999999000199': { situacao: 'Baixada', nome: 'EMPRESA BAIXADA LTDA' },
    '88888888000188': null, // Timeout simulation
  };
  if (cnpj === '88888888000188') return setTimeout(() => res.status(504).json({ error: 'Timeout' }), 16000);
  if (cnpj === '00000000000000') return res.status(404).json({ error: 'CNPJ não encontrado' });
  const mock = mocks[cnpj] || { situacao: 'Ativa', nome: `MOCK EMPRESA ${cnpj}`, municipio: 'Brasília', uf: 'DF' };
  res.json(mock);
});

// ── BLACKLIST ANATEL: GET /blacklist/telefone/:phone/elegibilidade ──
router.get('/blacklist/telefone/:phone/elegibilidade', (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const blocked = ['11999990000', '21888880000', '31777770000'];
  const isBlocked = blocked.includes(phone);
  res.json({
    resultado: {
      telefone: phone,
      elegivel: !isBlocked,
      status: isBlocked ? 'Ilegível' : 'Elegível',
      motivo: isBlocked ? 'Número registrado no Do Not Disturb (Anatel)' : null,
      consultado_em: new Date().toISOString()
    }
  });
});

// ── WHATSAPP ASC: POST /whatsapp/lead ──
router.post('/whatsapp/lead', (req, res) => {
  const { nome, telefone, empresa, cnpj, frase_origem, historico } = req.body || {};
  res.status(201).json({
    success: true,
    lead: {
      FirstName: nome?.split(' ')[0] || 'Lead',
      LastName: nome?.split(' ').slice(1).join(' ') || 'WhatsApp',
      Phone: telefone, Company: empresa || 'Não informada',
      CNPJ__c: cnpj, FraseOrigemASC__c: frase_origem,
      HistoricoWhatsApp__c: historico, OrigemCanal__c: 'WhatsApp',
      Status: 'Novo'
    },
    message: 'Lead mock criado via ASC WhatsApp'
  });
});

// ── LANDING PAGE: POST /landingpage/lead ──
router.post('/landingpage/lead', (req, res) => {
  const { nome, email, telefone, empresa, cnpj, produto_interesse,
          utm_source, utm_medium, utm_campaign, utm_content, utm_term, segmento } = req.body || {};
  res.status(201).json({
    success: true,
    lead: {
      FirstName: nome?.split(' ')[0] || 'Lead',
      LastName: nome?.split(' ').slice(1).join(' ') || 'LP',
      Email: email, Phone: telefone, Company: empresa,
      CNPJ__c: cnpj, ProdutoInteresse__c: produto_interesse,
      UTMSource__c: utm_source, UTMMedium__c: utm_medium,
      UTMCampaign__c: utm_campaign, UTMContent__c: utm_content,
      UTMTerm__c: utm_term, Segmento__c: segmento,
      OrigemCanal__c: 'Landing page', Status: 'Novo'
    },
    message: 'Lead mock criado via Landing Page'
  });
});

// ── PORTAL ALGAR: POST /portal/lead ──
router.post('/portal/lead', (req, res) => {
  const { nome, email, telefone, empresa, cnpj, produto_interesse,
          tipo_evento, url_origem, etapa_carrinho, request_id } = req.body || {};
  res.status(201).json({
    success: true,
    lead: {
      FirstName: nome?.split(' ')[0] || 'Lead',
      LastName: nome?.split(' ').slice(1).join(' ') || 'Portal',
      Email: email, Phone: telefone, Company: empresa,
      CNPJ__c: cnpj, ProdutoInteresse__c: produto_interesse,
      TipoEventoSite__c: tipo_evento, UrlOrigem__c: url_origem,
      EtapaCarrinho__c: etapa_carrinho,
      Portal_Request_Id__c: request_id || crypto.randomUUID?.() || Date.now().toString(),
      OrigemCanal__c: 'Portal Algar', Status: 'Novo'
    },
    message: 'Lead mock criado via Portal Algar'
  });
});

// ── MICROSOFT GRAPH: GET /me (identity check) ──
router.get('/microsoft/me', (req, res) => {
  res.json({
    displayName: 'Mock User Algar',
    mail: 'mock.user@algar.com.br',
    id: 'mock-graph-user-id-001'
  });
});

// ── HEALTH CHECK ──
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Mock APIs — Lead Integration',
    endpoints: [
      'GET /neoway/empresa/:cnpj',
      'GET /rf/cnpj/:cnpj',
      'GET /blacklist/telefone/:phone/elegibilidade',
      'POST /whatsapp/lead',
      'POST /landingpage/lead',
      'POST /portal/lead',
      'GET /microsoft/me'
    ],
    mock_cnpjs: {
      '71208516000174': 'Algar Telecom (ATIVA, Grande)',
      '11111111000111': 'Empresa parcial (ATIVA, Micro)',
      '99999999000199': 'Empresa BAIXADA',
      '88888888000188': 'Timeout 16s',
      '00000000000000': '404 Not Found'
    },
    timestamp: new Date().toISOString()
  });
});

export default router;
