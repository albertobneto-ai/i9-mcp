// src/config/knowledge-base.js — Base de conhecimento do projeto
export const knowledgeBase = `# MCP Salesforce Provisioning — Base de Conhecimento

## Servidor MCP

O servidor MCP roda em Node.js no Heroku e conecta na org Salesforce via jsforce.
URL base: https://mcp-sf-provisioning-462dd29c2455.herokuapp.com

### Endpoints disponíveis

| Endpoint | Método | Descrição |
|---|---|---|
| /test-connection | GET | Verifica conexão com a org (retorna orgId, username, instanceUrl) |
| /api/deploy-b64/{base64} | GET | Deploya manifest JSON codificado em base64 |
| /api/describe/{objectName} | GET | Descreve objeto (campos, record types) |
| /api/scratch-orgs | GET | Lista scratch orgs ativas |
| /api/scratch-orgs/create/{template} | GET | Cria scratch org por workstream |
| /api/scratch-orgs/delete/{orgId} | GET | Deleta scratch org |
| /api/scratch-orgs/login/{id} | GET | Gera link de login da scratch org |
| /api/soql-b64/{base64} | GET | Executa SOQL codificado em base64 |
| /api/execute-apex-b64/{base64} | GET | Executa Apex anônimo codificado em base64 |
| /api/data/composite | POST | Insere múltiplos registros com referência entre objetos |
| /api/data/upsert | POST | Upsert de registros (requer objectName, records, externalIdField) |
| /api/mock-data | POST | Insere dados de mock por cenário |
| /api/delete-records/{obj}/{ids} | GET | Deleta registros por IDs |
| /api/update-records | POST | Atualiza registros |
| /api/metadata-read/{type}/{fullName} | GET | Lê metadado existente |
| /api/metadata-update/{type} | POST | Atualiza metadado existente |
| /api/metadata-create/{type} | POST | Cria metadado NOVO (ex: ReportType) |
| /api/field-history | POST | Ativa Field History Tracking em campos |
| /api/lead-convert-mapping | POST | Deploy de LeadConvertSettings (só Sandbox/Prod) |
| /api/deploy-code | POST | Deploy assíncrono via ZIP (Apex, Flows, Settings) |
| /api/deploy-status/{deployId} | GET | Verifica status de deploy assíncrono |
| /api/move-field-in-layout | POST | Move campo entre seções do layout |
| /api/add-related-list | POST | Adiciona related list ao layout |
| /api/remove-field-from-layout | POST | Remove campo do layout |
| /api/describe-layouts/{object} | GET | Lista layouts e seções de um objeto |
| /api/github/repos | GET | Lista repositórios GitHub |
| /api/github/create-repo | POST | Cria repositório GitHub |
| /api/github/repo/{repo}/file | POST | Cria/atualiza arquivo em qualquer repo |
| /api/github/repo/{repo}/files | POST/GET | Batch de arquivos / listar arquivos |

---

## Formato do Manifest JSON para Deploy

O manifest é a estrutura JSON que o endpoint /api/deploy-b64 aceita para provisionar metadados na org.

### Estrutura base
\`\`\`json
{
  "specName": "Nome_Descritivo",
  "metadata": {
    "customObjects": [],
    "customFields": [],
    "validationRules": [],
    "recordTypes": [],
    "permissionSets": []
  }
}
\`\`\`

### Custom Fields — Tipos e parâmetros obrigatórios

| Tipo | Parâmetros obrigatórios | Opcionais |
|---|---|---|
| Text | length (1-255) | required, externalId, description |
| TextArea | — | description |
| LongTextArea | length (32768), visibleLines (4) | description |
| Number | precision (10), scale (2) | required |
| Currency | precision (10), scale (2) | required |
| Percent | precision (10), scale (2) | required |
| Date | — | required |
| DateTime | — | required |
| Checkbox | — | defaultValue |
| Email | — | required |
| Phone | — | required |
| Url | — | required |
| Picklist | picklist: ["Valor1", "Valor2"] | required |
| MultiselectPicklist | picklist: ["V1", "V2"], visibleLines: 4 | required |
| Lookup | referenceTo: "ObjetoAlvo", relationshipLabel: "Label" | required |

### REGRA CRÍTICA para Picklist
Usar formato array de strings: \`"picklist": ["Valor1", "Valor2", "Valor3"]\`
NÃO usar: \`"picklistValues": [{"fullName": "Valor1"}]\`
O servidor MCP converte o array em valueSet automaticamente.

### Exemplo de campo completo
\`\`\`json
{
  "object": "Lead",
  "fullName": "Lead.Sector__c",
  "label": "Setor",
  "type": "Picklist",
  "picklist": ["Tecnologia", "Telecomunicações", "Varejo", "Indústria", "Serviços"],
  "description": "Setor da empresa"
}
\`\`\`

### Exemplo de Lookup
\`\`\`json
{
  "object": "Opportunity",
  "fullName": "Opportunity.Parent_Account__c",
  "label": "Conta Pai",
  "type": "Lookup",
  "referenceTo": "Account",
  "relationshipLabel": "Oportunidades Filhas"
}
\`\`\`

### Exemplo de Validation Rule
\`\`\`json
{
  "object": "Lead",
  "fullName": "Lead.Validate_CNPJ_Format",
  "active": true,
  "errorConditionFormula": "AND(NOT(ISBLANK(CNPJ__c)), NOT(REGEX(CNPJ__c, '[0-9]{14}')))",
  "errorMessage": "CNPJ deve conter exatamente 14 dígitos numéricos."
}
\`\`\`

### Exemplo de Record Type
\`\`\`json
{
  "object": "Account",
  "fullName": "Account.Customer",
  "label": "Customer",
  "active": true
}
\`\`\`

### Exemplo de Permission Set
\`\`\`json
{
  "fullName": "Lead_Conversion_Access",
  "label": "Lead Conversion Access",
  "description": "Acesso aos campos de conversão",
  "fieldPermissions": [
    {"field": "Lead.Sector__c", "readable": true, "editable": true},
    {"field": "Opportunity.Sector__c", "readable": true, "editable": true}
  ]
}
\`\`\`

---

## Inserção de Dados via API

### Composite (múltiplos registros com referência)
\`\`\`json
POST /api/data/composite
{
  "steps": [
    {
      "objectName": "Account",
      "refPrefix": "acc",
      "records": [
        {"Name": "Empresa Teste", "Industry": "Technology"}
      ]
    },
    {
      "objectName": "Contact",
      "refPrefix": "con",
      "records": [
        {"FirstName": "João", "LastName": "Silva", "AccountId": "@{acc_0}"}
      ]
    }
  ]
}
\`\`\`
O \`@{ref_N}\` referencia o ID do registro N criado no step anterior.

### Field History Tracking
\`\`\`json
POST /api/field-history
{
  "object": "Opportunity",
  "fields": ["Sector__c", "Board__c", "Protocol__c"]
}
\`\`\`

---

## Metadata API — Regras aprendidas

### metadata.create vs metadata.update
- \`POST /api/metadata-create/{type}\` — cria componentes NOVOS (ex: ReportType, PermissionSet)
- \`POST /api/metadata-update/{type}\` — atualiza componentes EXISTENTES
- Se tentar metadata.update em algo que não existe: erro "not found"
- Se tentar metadata.create em algo que já existe: erro de duplicidade

### LeadConvertSettings — Limitação
- \`metadata.read('LeadConvertSettings')\` FUNCIONA em Dev Edition (retorna objectMapping)
- \`metadata.deploy\` de LeadConvertSettings FALHA em Dev Edition ("does not exist")
- FUNCIONA em Sandbox e Production
- Para Dev Edition: configurar Lead Field Mapping manualmente via Setup → Feature Settings → Sales → Leads → Lead Convert Settings

### ListView — Formato de colunas
Colunas usam DOT notation do Salesforce:
- Standard fields: OPPORTUNITY.NAME, ACCOUNT.NAME, OPPORTUNITY.AMOUNT, OPPORTUNITY.CLOSE_DATE
- System fields: CREATED_DATE, LAST_UPDATE, CORE.USERS.ALIAS
- Custom fields: API name direto (Field__c)
- Usar metadata.update, NÃO ZIP deploy (falha)

### Related Lists self-referencial (ex: Account hierarquia)
Metadata API não aceita related list do campo padrão ParentId.
Workaround:
1. Criar campo Lookup custom (ex: Parent_Account__c) com relationshipLabel
2. Mover campo padrão ParentId para seção System Information via /api/move-field-in-layout
3. Usar format "Object.Field__c" para /api/add-related-list

---

## Org Salesforce conectada

- Org ID: 00DgK00000PUJwTUAX
- Tipo: Developer Edition (Hyperforce)
- Username: albertobneto.ce8a76342d1d@agentforce.com
- URL: https://orgfarm-6450ce60e0-dev-ed.develop.my.salesforce.com
- DevHub: ativado (limite 6 scratch orgs)
- API Version: 62.0

### Regra de deploy
Usar a Dev Org diretamente (não criar scratch orgs), a menos que solicitado explicitamente.

---

## Projeto CRM B2B Algar Telecom

### Workstreams
1. Leads & Sales Engagement
2. Salesforce Maps & Visitas
3. Oportunidades & Cotações
4. Order Management (TM Forum)
5. Data Cloud & Neoway
6. Agentforce
7. WhatsApp Messaging

### Princípios de arquitetura
- OOTB-first: Se pode ser configuração nativa, NÃO usar Flow. Se pode ser Flow, NÃO usar Apex.
- MuleSoft como iPaaS para integrações
- Scratch orgs isoladas por workstream (quando necessário)

---

## Aliases PT-BR para objetos Salesforce

| Português | API Name |
|---|---|
| conta, contas, cliente, empresa | Account |
| contato, contatos | Contact |
| lead, leads, prospecto | Lead |
| oportunidade, oportunidades, deal, negócio | Opportunity |
| caso, casos, chamado, ticket, ocorrência | Case |
| campanha, campanhas | Campaign |
| cotação, cotações, proposta | Quote |
| pedido, pedidos, ordem | Order |
| contrato, contratos | Contract |
| produto, produtos | Product2 |
| tarefa, tarefas, atividade | Task |
| evento, eventos, reunião | Event |
| usuário, usuarios | User |
| ativo, ativos | Asset |
| território, territórios | Territory2 |
| relatório, relatórios | Report |
| painel, painéis, dashboard | Dashboard |
| documento, arquivo | ContentDocument |
| email, e-mail | EmailMessage |

Campos custom (__c, __mdt, __e) são usados diretamente sem tradução.

---

## Comandos do Spec AI

| Comando | Descrição |
|---|---|
| /hf | Gera História Funcional (14 seções) |
| /spec | Gera Especificação Técnica (18 seções com Runbook) |
| /ata | Gera Ata de Reunião (11 seções) |
| /deploy | Deploya metadados na org (aceita JSON ou spec) |
| /describe | Consulta objeto na org (aceita PT-BR) |
| /status | Verifica conexão com a org |
| /scratch | Gerencia scratch orgs |
| /mock | Insere dados de teste |
| /help | Lista todos os comandos |
`;
