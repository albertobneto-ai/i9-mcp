#!/usr/bin/env python3
"""
generate-parity.py — Gera org-parity.html com dados reais HOMOL↔PROD
Uso dentro do Claude: exec(open('generate-parity.py').read()) ou python3 generate-parity.py

Pré-requisitos:
  pip install requests (já disponível no ambiente Claude)

Passos:
  1. Login SOAP em HOMOL e PROD
  2. 8 queries Tooling API (CustomObject, CustomField, VR, Flow, ApexClass, ApexTrigger, PS, LWC)
  3. Resolve TableEnumOrId → nome legível (EntityDefinition + FullName fallback)
  4. Diff em 4 buckets (Igual, Divergente, Só HOMOL, Só PROD)
  5. Injeta dados no template (parity-template.html)
  6. Salva em /mnt/user-data/outputs/org-parity.html

Para usar em nova conversa:
  1. Baixar template: GET /api/github/repo/i9-mcp/files?path=scripts/parity-template.html
  2. Baixar este script: GET /api/github/repo/i9-mcp/files?path=scripts/generate-parity.py
  3. Executar
  4. Push resultado para client/dist/org-parity.html
  5. Heroku build manual
"""
import requests, json, base64
from datetime import datetime

# ═══ CONFIG ═══
HOMOL = {"user": "alberto.bottaro@aircompany.ai.algar.hml", "pwd": "Nicework@00019VdH0vY55hCKD76lvLfk84vM0", "url": "https://test.salesforce.com"}
PROD  = {"user": "alberto.bottaro@aircompany.algar.prod", "pwd": "Nicework@2026IDj5W6E5Ca6lr9nU1nr2lNTB7", "url": "https://login.salesforce.com"}

QUERIES = {
    "CustomObject": "SELECT Id, DeveloperName FROM CustomObject WHERE ManageableState='unmanaged' ORDER BY DeveloperName",
    "CustomField": "SELECT Id, DeveloperName, TableEnumOrId, EntityDefinition.QualifiedApiName FROM CustomField WHERE ManageableState='unmanaged' ORDER BY TableEnumOrId, DeveloperName",
    "ValidationRule": "SELECT Id, ValidationName, EntityDefinitionId, Active FROM ValidationRule WHERE ManageableState='unmanaged' ORDER BY ValidationName",
    "Flow": "SELECT Id, DeveloperName, ActiveVersionId FROM FlowDefinition ORDER BY DeveloperName",
    "ApexClass": "SELECT Id, Name, Status FROM ApexClass WHERE ManageableState='unmanaged' ORDER BY Name",
    "ApexTrigger": "SELECT Id, Name, Status FROM ApexTrigger WHERE ManageableState='unmanaged' ORDER BY Name",
    "PermissionSet": "SELECT Id, Name, Label FROM PermissionSet WHERE IsCustom=true AND ManageableState='unmanaged' ORDER BY Name",
    "LWC": "SELECT Id, DeveloperName FROM LightningComponentBundle WHERE ManageableState='unmanaged' ORDER BY DeveloperName",
}

CAT_MAP = {"CustomObject":"objects","CustomField":"fields","ValidationRule":"vr","Flow":"flows","ApexClass":"apex","ApexTrigger":"apex","PermissionSet":"ps","LWC":"lwc"}
TYPE_MAP = {"CustomObject":"CustomObject","CustomField":"CustomField","ValidationRule":"ValidationRule","Flow":"Flow","ApexClass":"Apex Class","ApexTrigger":"Apex Trigger","PermissionSet":"PermissionSet","LWC":"LWC"}

# ═══ HELPERS ═══
def soap_login(cfg):
    xml = f'<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com"><soapenv:Body><urn:login><urn:username>{cfg["user"]}</urn:username><urn:password>{cfg["pwd"]}</urn:password></urn:login></soapenv:Body></soapenv:Envelope>'
    r = requests.post(f"{cfg['url']}/services/Soap/u/62.0", headers={"Content-Type":"text/xml","SOAPAction":"login"}, data=xml, timeout=30)
    return r.text.split("<sessionId>")[1].split("</sessionId>")[0], r.text.split("<serverUrl>")[1].split("/services/Soap")[0]

def tooling_query(inst, sid, soql):
    r = requests.get(f"{inst}/services/data/v62.0/tooling/query", params={"q":soql}, headers={"Authorization":f"Bearer {sid}"}, timeout=30)
    if r.status_code != 200: return []
    data = r.json(); recs = data.get("records",[])
    while not data.get("done",True) and data.get("nextRecordsUrl"):
        r2 = requests.get(f"{inst}{data['nextRecordsUrl']}", headers={"Authorization":f"Bearer {sid}"}, timeout=30)
        if r2.status_code == 200: data = r2.json(); recs.extend(data.get("records",[]))
        else: break
    return recs

def resolve_object_names(raw, h_inst, h_sid, p_inst, p_sid):
    """Resolve TableEnumOrId → readable object name"""
    tid_map = {}
    # Pass 1: EntityDefinition.QualifiedApiName
    for rec in raw["CustomField"]["homol"] + raw["CustomField"]["prod"]:
        ed = rec.get("EntityDefinition") or {}
        n = ed.get("QualifiedApiName")
        t = rec.get("TableEnumOrId","")
        if n and t: tid_map[t] = n
    # Pass 2: FullName fallback for unresolved (Data Cloud 9sd objects etc.)
    unresolved = {}
    for rec in raw["CustomField"]["homol"] + raw["CustomField"]["prod"]:
        t = rec.get("TableEnumOrId","")
        if t not in tid_map and t not in unresolved: unresolved[t] = rec["Id"]
    for tid, fid in unresolved.items():
        for inst, sid in [(h_inst, h_sid), (p_inst, p_sid)]:
            if tid in tid_map: break
            r = requests.get(f"{inst}/services/data/v62.0/tooling/query",
                params={"q": f"SELECT FullName FROM CustomField WHERE Id='{fid}'"},
                headers={"Authorization": f"Bearer {sid}"}, timeout=15)
            if r.status_code == 200:
                recs = r.json().get("records",[])
                if recs and "." in recs[0].get("FullName",""):
                    tid_map[tid] = recs[0]["FullName"].split(".")[0]
    return tid_map

def compute_diff(raw, tid_map):
    """Compute parity diff across all categories"""
    def oname(rec):
        t = rec.get("TableEnumOrId","")
        return tid_map.get(t) or (rec.get("EntityDefinition") or {}).get("QualifiedApiName") or t
    def kf(cat, rec):
        if cat=="CustomObject": return rec.get("DeveloperName","?")+"__c"
        if cat=="CustomField": return f"{oname(rec)}.{rec.get('DeveloperName','?')}"
        if cat=="ValidationRule": return rec.get("ValidationName","?")
        if cat=="Flow": return rec.get("DeveloperName","?")
        if cat in("ApexClass","ApexTrigger"): return rec.get("Name","?")
        if cat=="PermissionSet": return rec.get("Name","?")
        if cat=="LWC": return rec.get("DeveloperName","?")
    def inf(cat, rec):
        if cat=="CustomObject": return "Custom Object"
        if cat=="CustomField": return oname(rec)
        if cat=="ValidationRule": return "Active" if rec.get("Active") else "Inactive"
        if cat=="Flow": return "Active" if rec.get("ActiveVersionId") else "Inactive"
        if cat in("ApexClass","ApexTrigger"): return rec.get("Status","?")
        if cat=="PermissionSet": return rec.get("Label","?")
        if cat=="LWC": return "ok"
    
    items = []; counts = {"total":0,"matched":0,"homol-only":0,"prod-only":0,"divergent":0}; iid = 1
    for cat in ["CustomObject","CustomField","ValidationRule","Flow","ApexClass","ApexTrigger","PermissionSet","LWC"]:
        hm = {kf(cat,r):r for r in raw[cat]["homol"]}
        pm = {kf(cat,r):r for r in raw[cat]["prod"]}
        for k in sorted(set(hm)|set(pm)):
            ih, ip = k in hm, k in pm
            hi = inf(cat,hm[k]) if ih else None
            pi = inf(cat,pm[k]) if ip else None
            s = "matched" if(ih and ip and hi==pi) else("divergent" if(ih and ip) else("homol-only" if ih else "prod-only"))
            counts["total"] += 1; counts[s] += 1
            obj = k.split(".")[0] if(cat=="CustomField" and "." in k) else(k if cat=="CustomObject" else "\u2014")
            if s != "matched":
                dd = f"HOMOL: {hi} / PROD: {pi}" if s=="divergent" else(f"Existe em HOMOL ({hi}), ausente em PROD" if s=="homol-only" else f"Existe em PROD ({pi}), ausente em HOMOL")
                items.append({"id":iid,"c":CAT_MAP[cat],"n":k,"t":TYPE_MAP[cat],"o":obj,"s":s,"h":hi,"p":pi,"d":dd})
            iid += 1
    return items, counts

def generate_html(template_path, items, counts, output_path):
    """Inject data into template and save"""
    tmpl = open(template_path).read()
    pct = round((counts["matched"]/counts["total"])*100, 1)
    ts = datetime.now().strftime("%d/%m/%Y %H:%M")
    ij = json.dumps(items, ensure_ascii=False, separators=(',',':'))
    
    html = tmpl.replace("__PARITY_DATA__", ij)
    html = html.replace("__TOTAL__", str(counts["total"]))
    html = html.replace("__MATCHED__", str(counts["matched"]))
    html = html.replace("__DIVERGENT__", str(counts["divergent"]))
    html = html.replace("__HOMOL_ONLY__", str(counts["homol-only"]))
    html = html.replace("__PROD_ONLY__", str(counts["prod-only"]))
    html = html.replace("__PCT__", str(pct))
    html = html.replace("__TIMESTAMP__", ts)
    
    with open(output_path, "w") as f:
        f.write(html)
    return html, ts, pct

# ═══ MAIN ═══
def run():
    print("1. Login...", flush=True)
    h_sid, h_inst = soap_login(HOMOL)
    p_sid, p_inst = soap_login(PROD)
    print("   OK")
    
    print("2. Querying 8 categories...", flush=True)
    raw = {}
    for cat, soql in QUERIES.items():
        print(f"   {cat}...", end=" ", flush=True)
        raw[cat] = {"homol": tooling_query(h_inst, h_sid, soql), "prod": tooling_query(p_inst, p_sid, soql)}
        print(f"H={len(raw[cat]['homol'])} P={len(raw[cat]['prod'])}")
    
    print("3. Resolving object names...", flush=True)
    tid_map = resolve_object_names(raw, h_inst, h_sid, p_inst, p_sid)
    all_t = set(r.get("TableEnumOrId","") for r in raw["CustomField"]["homol"]+raw["CustomField"]["prod"])
    print(f"   {sum(1 for t in all_t if t in tid_map)}/{len(all_t)} resolved")
    
    print("4. Computing diff...", flush=True)
    items, counts = compute_diff(raw, tid_map)
    pct = round((counts["matched"]/counts["total"])*100, 1)
    print(f"   Total:{counts['total']} Matched:{counts['matched']}({pct}%) Div:{counts['divergent']} H:{counts['homol-only']} P:{counts['prod-only']}")
    print(f"   Non-matched items: {len(items)}")
    
    print("5. Generating HTML...", flush=True)
    html, ts, pct = generate_html("/tmp/parity-template.html", items, counts, "/mnt/user-data/outputs/org-parity.html")
    print(f"   {len(html)} bytes → /mnt/user-data/outputs/org-parity.html")
    print(f"   Verificado em {ts}")
    
    return html, items, counts

if __name__ == "__main__":
    run()
