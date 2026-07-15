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

// ── SERASA (via MuleSoft PartyManagement): GET /serasa/parties/:cnpj/data-registration ──
// Contrato = parser de SerasaConsultaPorCnpj.cls / SerasaCalloutService.cls (body.organization.*)
// Uso temporario: NC MuleSoftPartyManagementProcessAPIv1 aponta aqui enquanto Mule HML esta 500
router.get('/serasa/parties/:cnpj/data-registration', (req, res) => {
  const cnpj = req.params.cnpj.replace(/\D/g, '');

  if (cnpj === '88888888000188') {
    return setTimeout(() => res.status(504).json({ error: 'Gateway Timeout' }), 16000);
  }
  if (cnpj === '00000000000000') {
    return res.status(404).json({ error: 'Party not found', documentNumber: cnpj });
  }

  const mocks = {
    '71208516000174': { // Algar Telecom — cenario completo
      organization: {
        legalName: 'ALGAR TELECOM S/A',
        tradeName: 'ALGAR TELECOM',
        situation: 'ATIVA',
        situationDate: '2005-11-03',
        specialSituation: null,
        openingDate: '1954-11-05',
        size: 'GRANDE',
        branchType: 'M',
        mainActivity: { code: '61.10-8', text: 'Servicos de telecomunicacoes por fio' },
        legalNature: { code: '2054', text: 'Sociedade Anonima Fechada' },
        tax: {
          sintegra: { code: '702235524', state: 'MG', situation: 'HABILITADO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Rua Jose Alves Garcia', number: '415', district: 'Brasil',
          complement: null, zipCode: '38400-668', city: 'Uberlandia', state: 'MG'
        }
      }
    },
    '33444555000181': { // Caminho feliz limpo — Ltda ATIVA, sem duplicado na org
      organization: {
        legalName: 'TECNOVA SOLUCOES DIGITAIS LTDA',
        tradeName: 'TECNOVA',
        situation: 'ATIVA',
        situationDate: '2018-04-10',
        specialSituation: null,
        openingDate: '2015-08-20',
        size: 'MEDIO',
        branchType: 'M',
        mainActivity: { code: '62.01-5', text: 'Desenvolvimento de programas de computador sob encomenda' },
        legalNature: { code: '2062', text: 'Sociedade Empresaria Limitada' },
        tax: {
          sintegra: { code: '312445678', state: 'MG', situation: 'HABILITADO' },
          simples: { situation: 'P' }
        },
        address: {
          street: 'Av Joao Naves de Avila', number: '1331', district: 'Tibery',
          complement: 'Sala 402', zipCode: '38408-100', city: 'Uberlandia', state: 'MG'
        }
      }
    },
    '71208516000255': { // Algar FILIAL — testa branchType F -> nivelConta Filial
      organization: {
        legalName: 'ALGAR TELECOM S/A',
        tradeName: 'ALGAR TELECOM FILIAL UBERABA',
        situation: 'ATIVA',
        situationDate: '2010-05-12',
        specialSituation: null,
        openingDate: '2010-05-12',
        size: 'GRANDE',
        branchType: 'F',
        mainActivity: { code: '61.10-8', text: 'Servicos de telecomunicacoes por fio' },
        legalNature: { code: '2054', text: 'Sociedade Anonima Fechada' },
        tax: {
          sintegra: { code: '702998877', state: 'MG', situation: 'HABILITADO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Av Leopoldino de Oliveira', number: '2500', district: 'Centro',
          complement: null, zipCode: '38010-000', city: 'Uberaba', state: 'MG'
        }
      }
    },
    '44555666000181': { // GOVERNO — NJ 1023 deriva TipoCliente GOVERNO ESTADUAL
      organization: {
        legalName: 'SECRETARIA DE ESTADO DE FAZENDA DE MINAS GERAIS',
        tradeName: 'SEF-MG',
        situation: 'ATIVA',
        situationDate: '1995-01-01',
        specialSituation: null,
        openingDate: '1975-03-01',
        size: 'GRANDE',
        branchType: 'M',
        mainActivity: { code: '84.11-6', text: 'Administracao publica em geral' },
        legalNature: { code: '1023', text: 'Orgao Publico do Poder Executivo Estadual' },
        tax: {
          sintegra: { code: null, state: 'MG', situation: 'ISENTO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Rodovia Papa Joao Paulo II', number: '4001', district: 'Serra Verde',
          complement: 'Cidade Administrativa', zipCode: '31630-901', city: 'Belo Horizonte', state: 'MG'
        }
      }
    },
    '55666777000181': { // SUSPENSA — outro sabor de inativa (LWC bloqueia save)
      organization: {
        legalName: 'COMERCIAL SUSPENSA EIRELI',
        tradeName: 'SUSPENSA COM',
        situation: 'SUSPENSA',
        situationDate: '2024-11-20',
        specialSituation: null,
        openingDate: '2019-07-04',
        size: 'PEQUENO',
        branchType: 'M',
        mainActivity: { code: '47.11-3', text: 'Comercio varejista' },
        legalNature: { code: '2305', text: 'Empresa Individual de Responsabilidade Limitada' },
        tax: {
          sintegra: { code: '445001122', state: 'SP', situation: 'SUSPENSO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Rua Suspensa', number: '77', district: 'Centro',
          complement: null, zipCode: '01310-100', city: 'Sao Paulo', state: 'SP'
        }
      }
    },
    '10111213000144': { // Distribuidora SP — caminho feliz GRANDE
      organization: {
        legalName: 'DISTRIBUIDORA PAULISTA DE ALIMENTOS S/A',
        tradeName: 'DISPAL',
        situation: 'ATIVA',
        situationDate: '2012-03-15',
        specialSituation: null,
        openingDate: '1998-06-22',
        size: 'GRANDE',
        branchType: 'M',
        mainActivity: { code: '46.39-7', text: 'Comercio atacadista de produtos alimenticios em geral' },
        legalNature: { code: '2054', text: 'Sociedade Anonima Fechada' },
        tax: {
          sintegra: { code: '110042998877', state: 'SP', situation: 'HABILITADO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Av dos Bandeirantes', number: '3500', district: 'Vila Olimpia',
          complement: 'Galpao 12', zipCode: '04553-900', city: 'Sao Paulo', state: 'SP'
        }
      }
    },
    '20212223000120': { // Industria MG — caminho feliz MEDIO
      organization: {
        legalName: 'METALURGICA TRIANGULO MINEIRO LTDA',
        tradeName: 'METALTRI',
        situation: 'ATIVA',
        situationDate: '2016-09-01',
        specialSituation: null,
        openingDate: '2008-02-14',
        size: 'MEDIO',
        branchType: 'M',
        mainActivity: { code: '25.11-0', text: 'Fabricacao de estruturas metalicas' },
        legalNature: { code: '2062', text: 'Sociedade Empresaria Limitada' },
        tax: {
          sintegra: { code: '312998877', state: 'MG', situation: 'HABILITADO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Distrito Industrial', number: '850', district: 'Industrial',
          complement: null, zipCode: '38402-349', city: 'Uberlandia', state: 'MG'
        }
      }
    },
    '30313233000105': { // Logistica RJ — caminho feliz GRANDE
      organization: {
        legalName: 'TRANSPORTES E LOGISTICA CARIOCA S/A',
        tradeName: 'LOGCARIOCA',
        situation: 'ATIVA',
        situationDate: '2010-11-30',
        specialSituation: null,
        openingDate: '2003-05-10',
        size: 'GRANDE',
        branchType: 'M',
        mainActivity: { code: '49.30-2', text: 'Transporte rodoviario de carga' },
        legalNature: { code: '2054', text: 'Sociedade Anonima Fechada' },
        tax: {
          sintegra: { code: '78556644', state: 'RJ', situation: 'HABILITADO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Av Brasil', number: '15000', district: 'Ramos',
          complement: 'Patio 3', zipCode: '21030-001', city: 'Rio de Janeiro', state: 'RJ'
        }
      }
    },
    '40414243000190': { // Empresario Individual — MICRO Simples Participante
      organization: {
        legalName: 'JOSE CARLOS FERREIRA ME',
        tradeName: 'JC INFORMATICA',
        situation: 'ATIVA',
        situationDate: '2021-01-10',
        specialSituation: null,
        openingDate: '2021-01-10',
        size: 'MICRO',
        branchType: 'M',
        mainActivity: { code: '95.11-8', text: 'Reparacao e manutencao de computadores' },
        legalNature: { code: '2135', text: 'Empresario Individual' },
        tax: {
          sintegra: { code: null, state: 'GO', situation: 'ISENTO' },
          simples: { situation: 'P' }
        },
        address: {
          street: 'Rua 7', number: '120', district: 'Setor Central',
          complement: null, zipCode: '74023-010', city: 'Goiania', state: 'GO'
        }
      }
    },
    '50515253000176': { // GOVERNO MUNICIPAL — NJ 1244 Municipio
      organization: {
        legalName: 'MUNICIPIO DE UBERLANDIA',
        tradeName: 'PREFEITURA DE UBERLANDIA',
        situation: 'ATIVA',
        situationDate: '1990-01-01',
        specialSituation: null,
        openingDate: '1970-01-01',
        size: 'GRANDE',
        branchType: 'M',
        mainActivity: { code: '84.11-6', text: 'Administracao publica em geral' },
        legalNature: { code: '1244', text: 'Municipio' },
        tax: {
          sintegra: { code: null, state: 'MG', situation: 'ISENTO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Av Anselmo Alves dos Santos', number: '600', district: 'Santa Monica',
          complement: 'Centro Administrativo', zipCode: '38408-150', city: 'Uberlandia', state: 'MG'
        }
      }
    },
    '60616263000151': { // GOVERNO FEDERAL — NJ 1104 Autarquia Federal
      organization: {
        legalName: 'AGENCIA NACIONAL DE TELECOMUNICACOES',
        tradeName: 'ANATEL',
        situation: 'ATIVA',
        situationDate: '1997-11-05',
        specialSituation: null,
        openingDate: '1997-11-05',
        size: 'GRANDE',
        branchType: 'M',
        mainActivity: { code: '84.11-6', text: 'Administracao publica em geral' },
        legalNature: { code: '1104', text: 'Autarquia Federal' },
        tax: {
          sintegra: { code: null, state: 'DF', situation: 'ISENTO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'SAUS Quadra 6', number: 'Bloco F', district: 'Asa Sul',
          complement: null, zipCode: '70070-940', city: 'Brasilia', state: 'DF'
        }
      }
    },
    '70717273000137': { // INAPTA — bloqueia save (outro sabor de inativa)
      organization: {
        legalName: 'COMERCIO INAPTO DE ROUPAS LTDA',
        tradeName: 'INAPTA MODAS',
        situation: 'INAPTA',
        situationDate: '2023-08-15',
        specialSituation: null,
        openingDate: '2017-04-20',
        size: 'PEQUENO',
        branchType: 'M',
        mainActivity: { code: '47.81-4', text: 'Comercio varejista de vestuario' },
        legalNature: { code: '2062', text: 'Sociedade Empresaria Limitada' },
        tax: {
          sintegra: { code: '445887766', state: 'PR', situation: 'CANCELADO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Rua XV de Novembro', number: '890', district: 'Centro',
          complement: null, zipCode: '80020-310', city: 'Curitiba', state: 'PR'
        }
      }
    },
    '80818283000112': { // RECUPERACAO JUDICIAL — ATIVA com specialSituation
      organization: {
        legalName: 'CONSTRUTORA HORIZONTE EM RECUPERACAO S/A',
        tradeName: 'HORIZONTE',
        situation: 'ATIVA',
        situationDate: '2025-02-28',
        specialSituation: 'RECUPERACAO JUDICIAL',
        openingDate: '1995-07-18',
        size: 'GRANDE',
        branchType: 'M',
        mainActivity: { code: '41.20-4', text: 'Construcao de edificios' },
        legalNature: { code: '2054', text: 'Sociedade Anonima Fechada' },
        tax: {
          sintegra: { code: '062334455', state: 'BA', situation: 'HABILITADO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Av Tancredo Neves', number: '1632', district: 'Caminho das Arvores',
          complement: 'Torre Sul', zipCode: '41820-020', city: 'Salvador', state: 'BA'
        }
      }
    },
    '90919293000106': { // Cooperativa — NJ 2143
      organization: {
        legalName: 'COOPERATIVA AGROPECUARIA DO CERRADO',
        tradeName: 'COOPCERRADO',
        situation: 'ATIVA',
        situationDate: '2005-06-12',
        specialSituation: null,
        openingDate: '1989-10-05',
        size: 'MEDIO',
        branchType: 'M',
        mainActivity: { code: '01.13-0', text: 'Cultivo de cana-de-acucar' },
        legalNature: { code: '2143', text: 'Cooperativa' },
        tax: {
          sintegra: { code: '103445566', state: 'MG', situation: 'HABILITADO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Rodovia BR-050 km 78', number: 'SN', district: 'Zona Rural',
          complement: null, zipCode: '38400-974', city: 'Uberlandia', state: 'MG'
        }
      }
    },
    '12131415000183': { // Associacao Privada — NJ 3999, IE isenta
      organization: {
        legalName: 'ASSOCIACAO COMERCIAL E INDUSTRIAL DE UBERLANDIA',
        tradeName: 'ACIUB',
        situation: 'ATIVA',
        situationDate: '1985-03-20',
        specialSituation: null,
        openingDate: '1933-08-15',
        size: 'PEQUENO',
        branchType: 'M',
        mainActivity: { code: '94.11-1', text: 'Atividades de organizacoes associativas patronais' },
        legalNature: { code: '3999', text: 'Associacao Privada' },
        tax: {
          sintegra: { code: null, state: 'MG', situation: 'ISENTO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Av Afonso Pena', number: '777', district: 'Centro',
          complement: '5 andar', zipCode: '38400-128', city: 'Uberlandia', state: 'MG'
        }
      }
    },
    '99999999000199': { // BAIXADA — LWC deve bloquear save (get inativa)
      organization: {
        legalName: 'EMPRESA BAIXADA LTDA',
        tradeName: 'BAIXADA',
        situation: 'BAIXADA',
        situationDate: '2020-06-30',
        specialSituation: null,
        openingDate: '2001-02-15',
        size: 'PEQUENO',
        branchType: 'M',
        mainActivity: { code: '47.11-3', text: 'Comercio varejista' },
        legalNature: { code: '2062', text: 'Sociedade Empresaria Limitada' },
        tax: {
          sintegra: { code: '000111222', state: 'SP', situation: 'BAIXADO' },
          simples: { situation: 'N' }
        },
        address: {
          street: 'Rua Encerrada', number: '99', district: 'Centro',
          complement: null, zipCode: '01000-000', city: 'Sao Paulo', state: 'SP'
        }
      }
    },
    '11111111000111': { // Parcial — testa nulls no LWC
      organization: {
        legalName: 'EMPRESA TESTE LTDA',
        tradeName: null,
        situation: 'ATIVA',
        openingDate: null,
        size: 'MICRO',
        branchType: 'M'
      }
    }
  };

  const mock = mocks[cnpj];
  if (!mock) {
    // Espelha o Mule HML atual: 500 generico — batch noturno se comporta igual a hoje
    return res.status(500).json({
      message: 'Internal Server Error',
      correlationId: 'mock-' + Date.now().toString(36)
    });
  }
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
      'GET /microsoft/me',
      'GET /serasa/parties/:cnpj/data-registration'
    ],
    mock_cnpjs: {
      '71208516000174': 'Algar Telecom (ATIVA, Grande)',
      '11111111000111': 'Empresa parcial (ATIVA, Micro)',
      '99999999000199': 'Empresa BAIXADA',
      '88888888000188': 'Timeout 16s',
      '33444555000181': 'Serasa: TECNOVA Ltda ATIVA (caminho feliz)',
      '71208516000255': 'Serasa: Algar FILIAL',
      '44555666000181': 'Serasa: Governo Estadual (SEF-MG)',
      '55666777000181': 'Serasa: SUSPENSA',
      '10111213000144': 'Serasa: Distribuidora SP', '20212223000120': 'Serasa: Industria MG',
      '30313233000105': 'Serasa: Logistica RJ', '40414243000190': 'Serasa: MEI Simples',
      '50515253000176': 'Serasa: Gov Municipal', '60616263000151': 'Serasa: Gov Federal ANATEL',
      '70717273000137': 'Serasa: INAPTA', '80818283000112': 'Serasa: Recuperacao Judicial',
      '90919293000106': 'Serasa: Cooperativa', '12131415000183': 'Serasa: Associacao',
      '00000000000000': '404 Not Found'
    },
    timestamp: new Date().toISOString()
  });
});

export default router;
