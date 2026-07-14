export const rules = [
  {
    id: 'apex-soql-in-loop',
    matches: (diffs) => diffs.some(d =>
      d.kind === 'line_added' && d.content?.match?.(/\[\s*SELECT\b/i) &&
      diffs.some(d2 => d2.kind === 'line_added' && d2.content?.match?.(/for\s*\(/i))
    ),
    describe: () => ['⚠️ SOQL detectado dentro de loop — potencial governor limit violation'],
    severity: 'critical'
  },
  {
    id: 'apex-without-sharing',
    matches: (diffs) => diffs.some(d =>
      d.kind === 'line_added' && d.content?.match?.(/without\s+sharing/i)
    ),
    describe: () => ['Classe alterada para `without sharing` — validar se acesso irrestrito é intencional'],
    severity: 'warning'
  },
  {
    id: 'apex-throw-to-debug',
    matches: (diffs) => {
      const removed = diffs.filter(d => d.kind === 'line_removed' && d.content?.match?.(/throw\b/));
      const added = diffs.filter(d => d.kind === 'line_added' && d.content?.match?.(/System\.debug/i));
      return removed.length > 0 && added.length > 0;
    },
    describe: () => ['⚠️ `throw` substituído por `System.debug` — erro silenciado'],
    severity: 'critical'
  },
  {
    id: 'apex-dml-added',
    matches: (diffs) => diffs.some(d =>
      d.kind === 'line_added' && d.content?.match?.(/\b(insert|update|delete|upsert)\b/i)
    ),
    describe: (diffs) => diffs.filter(d => d.kind === 'line_added' && d.content?.match?.(/\b(insert|update|delete|upsert)\b/i)).map(d =>
      `Operação DML adicionada: \`${d.content.trim().substring(0, 80)}\``
    ),
    severity: 'warning'
  }
];
