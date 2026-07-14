export const rules = [
  {
    id: 'flow-status-change',
    matches: (diffs) => diffs.some(d => d.path === 'Flow.status'),
    describe: (diffs) => {
      const d = diffs.find(d => d.path === 'Flow.status');
      return [`Status do Flow alterado de \`${d.oldValue}\` para \`${d.newValue}\``];
    },
    severity: 'critical'
  },
  {
    id: 'flow-api-version',
    matches: (diffs) => diffs.some(d => d.path === 'Flow.apiVersion'),
    describe: (diffs) => {
      const d = diffs.find(d => d.path === 'Flow.apiVersion');
      return [`apiVersion alterada de ${d.oldValue} para ${d.newValue}`];
    },
    severity: 'info'
  },
  {
    id: 'flow-decision-threshold',
    matches: (diffs) => diffs.some(d => d.path && d.path.match && d.path.match(/rightValue|numberValue|stringValue/)),
    describe: (diffs) => diffs.filter(d => d.path?.match?.(/rightValue|numberValue|stringValue/)).map(d =>
      `Valor em decisão alterado: \`${d.path}\` de ${d.oldValue} para ${d.newValue} — pode afetar regras de negócio`
    ),
    severity: 'warning'
  },
  {
    id: 'flow-new-element',
    matches: (diffs) => diffs.some(d => d.kind === 'added' && d.path?.match?.(/decisions|assignments|recordCreates|recordUpdates|screens/)),
    describe: (diffs) => diffs.filter(d => d.kind === 'added' && d.path?.match?.(/decisions|assignments|recordCreates|recordUpdates|screens/)).map(d =>
      `Novo elemento adicionado: \`${d.path}\``
    ),
    severity: 'warning'
  }
];
