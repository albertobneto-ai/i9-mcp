#!/usr/bin/env bash
# homol_query.sh — consulta SOMENTE LEITURA na HOMOL via Tooling API.
# Faz login e query na mesma execução (sessão HOMOL expira em minutos).
#
# Uso:
#   ./homol_query.sh inventory                 -> contagem por tipo (só componentes próprios)
#   ./homol_query.sh find <termo>              -> procura o termo em todos os tipos de código
#   ./homol_query.sh fields <Objeto>           -> campos próprios de um objeto
#   ./homol_query.sh deps <NomeComponente>     -> dependências (MetadataComponentDependency)
#   ./homol_query.sh raw "<SOQL Tooling>"      -> query livre (leitura)
#
# NUNCA escreve. Sem POST, PATCH, DELETE.

set -euo pipefail

# Credencial NUNCA fica neste arquivo. Vem do ambiente:
#   export SF_HOMOL_USER="<usuario>"
#   export SF_HOMOL_PWD="<senha><security token>"   # concatenados, sem espaco
USER_HML="${SF_HOMOL_USER:-}"
PASS_HML="${SF_HOMOL_PWD:-}"
if [ -z "$USER_HML" ] || [ -z "$PASS_HML" ]; then
  echo "Credencial ausente: defina SF_HOMOL_USER e SF_HOMOL_PWD no ambiente." >&2
  echo "Nenhuma credencial fica gravada neste repositorio." >&2
  exit 1
fi

login() {
  cat > /tmp/login_homol.xml << XMLEOF
<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body><urn:login>
      <urn:username>${USER_HML}</urn:username>
      <urn:password>${PASS_HML}</urn:password>
  </urn:login></soapenv:Body>
</soapenv:Envelope>
XMLEOF
  local R
  R=$(curl -s https://test.salesforce.com/services/Soap/u/62.0 \
        -H "Content-Type: text/xml" -H "SOAPAction: login" -d @/tmp/login_homol.xml)
  S=$(echo "$R" | grep -oP '(?<=<sessionId>)[^<]+' || true)
  I=$(echo "$R" | grep -oP '(?<=<serverUrl>https://)[^/]+' | sed 's|^|https://|' || true)
  if [ -z "${S:-}" ]; then echo "FALHA no login HOMOL" >&2; exit 1; fi
  echo "$S" > /tmp/homol_session.txt
  echo "$I" > /tmp/homol_instance.txt
}

tq() {
  curl -s --get "$I/services/data/v62.0/tooling/query" \
    --data-urlencode "q=$1" -H "Authorization: Bearer $S"
}

count() {
  tq "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('totalSize','ERRO'))" 2>/dev/null || echo "ERRO"
}

show() {
  tq "$1" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if isinstance(d,list):
    print('  ERRO:', d[0].get('message','?')[:120]); sys.exit()
recs=d.get('records',[])
print(f\"  {d.get('totalSize',0)} registro(s)\")
for r in recs[:60]:
    r.pop('attributes',None)
    print('   ', ' | '.join(f'{k}={v}' for k,v in r.items()))
if d.get('totalSize',0)>60: print('   ... (truncado em 60)')
"
}

login
CMD="${1:-inventory}"

case "$CMD" in
  inventory)
    echo "=== HOMOL — componentes PRÓPRIOS (NamespacePrefix=null) ==="
    printf "  %-28s %s\n" "CustomField"              "$(count 'SELECT COUNT() FROM CustomField WHERE NamespacePrefix=null')"
    printf "  %-28s %s\n" "Layout"                   "$(count 'SELECT COUNT() FROM Layout WHERE NamespacePrefix=null')"
    printf "  %-28s %s\n" "ApexClass"                "$(count 'SELECT COUNT() FROM ApexClass WHERE NamespacePrefix=null')"
    printf "  %-28s %s\n" "PermissionSet"            "$(count 'SELECT COUNT() FROM PermissionSet WHERE NamespacePrefix=null')"
    printf "  %-28s %s\n" "QuickActionDefinition"    "$(count 'SELECT COUNT() FROM QuickActionDefinition WHERE NamespacePrefix=null')"
    printf "  %-28s %s\n" "ValidationRule (ativas)"  "$(count 'SELECT COUNT() FROM ValidationRule WHERE Active=true')"
    printf "  %-28s %s\n" "RecordType"               "$(count 'SELECT COUNT() FROM RecordType')"
    printf "  %-28s %s\n" "Flow (ativos)"            "$(count "SELECT COUNT() FROM Flow WHERE Status='Active'")"
    printf "  %-28s %s\n" "CustomObject"             "$(count 'SELECT COUNT() FROM CustomObject WHERE NamespacePrefix=null')"
    printf "  %-28s %s\n" "FlexiPage"                "$(count 'SELECT COUNT() FROM FlexiPage WHERE NamespacePrefix=null')"
    printf "  %-28s %s\n" "LightningComponentBundle" "$(count 'SELECT COUNT() FROM LightningComponentBundle WHERE NamespacePrefix=null')"
    printf "  %-28s %s\n" "ApexTrigger"              "$(count 'SELECT COUNT() FROM ApexTrigger WHERE NamespacePrefix=null')"
    printf "  %-28s %s\n" "AuraDefinitionBundle"     "$(count 'SELECT COUNT() FROM AuraDefinitionBundle WHERE NamespacePrefix=null')"
    ;;
  find)
    T="${2:?informe o termo}"
    echo "=== Procurando \"$T\" (somente componentes próprios) ==="
    echo "-- ApexClass";               show "SELECT Id,Name FROM ApexClass WHERE NamespacePrefix=null AND Name LIKE '%${T}%'"
    echo "-- ApexTrigger";             show "SELECT Id,Name,TableEnumOrId FROM ApexTrigger WHERE NamespacePrefix=null AND Name LIKE '%${T}%'"
    echo "-- LightningComponentBundle";show "SELECT Id,DeveloperName FROM LightningComponentBundle WHERE NamespacePrefix=null AND DeveloperName LIKE '%${T}%'"
    echo "-- AuraDefinitionBundle";    show "SELECT Id,DeveloperName FROM AuraDefinitionBundle WHERE NamespacePrefix=null AND DeveloperName LIKE '%${T}%'"
    echo "-- Flow (ativos)";           show "SELECT Id,MasterLabel,ProcessType FROM Flow WHERE Status='Active' AND MasterLabel LIKE '%${T}%'"
    echo "-- PermissionSet";           show "SELECT Id,Name,Label FROM PermissionSet WHERE NamespacePrefix=null AND Name LIKE '%${T}%'"
    echo "-- CustomObject";            show "SELECT Id,DeveloperName FROM CustomObject WHERE NamespacePrefix=null AND DeveloperName LIKE '%${T}%'"
    ;;
  fields)
    O="${2:?informe o objeto}"
    echo "=== Campos próprios de ${O} ==="
    show "SELECT Id,DeveloperName,TableEnumOrId FROM CustomField WHERE NamespacePrefix=null AND TableEnumOrId='${O}'"
    ;;
  deps)
    N="${2:?informe o nome do componente}"
    echo "=== Quem depende de ${N} ==="
    show "SELECT MetadataComponentName,MetadataComponentType,RefMetadataComponentName,RefMetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentName='${N}'"
    ;;
  raw)
    show "${2:?informe a SOQL}"
    ;;
  *)
    echo "Comando desconhecido: $CMD" >&2; exit 1;;
esac
