// Regras genéricas (aplicam a qualquer tipo de metadado)

export const rules = [
  {
    id: 'field-value-change',
    matches: (diffs) => diffs.some(d => d.kind === 'changed'),
    describe: (diffs) => diffs.filter(d => d.kind === 'changed').map(d =>
      `Campo \`${d.path}\` alterado de \`${d.oldValue}\` para \`${d.newValue}\``
    ),
    severity: 'info'
  },
  {
    id: 'field-added',
    matches: (diffs) => diffs.some(d => d.kind === 'added'),
    describe: (diffs) => diffs.filter(d => d.kind === 'added').map(d =>
      `Campo \`${d.path}\` adicionado com valor \`${d.newValue}\``
    ),
    severity: 'info'
  },
  {
    id: 'field-removed',
    matches: (diffs) => diffs.some(d => d.kind === 'removed'),
    describe: (diffs) => diffs.filter(d => d.kind === 'removed').map(d =>
      `Campo \`${d.path}\` removido (valor anterior: \`${d.oldValue}\`)`
    ),
    severity: 'warning'
  },
  {
    id: 'throw-replaced-by-debug',
    matches: (diffs) => diffs.some(d =>
      d.kind === 'code_pattern' && d.pattern === 'throw_to_debug'
    ),
    describe: () => ['⚠️ `throw` substituído por `System.debug` — tratamento de erro enfraquecido'],
    severity: 'critical'
  }
];
