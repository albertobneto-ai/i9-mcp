export const rules = [
  {
    id: 'vr-deactivated',
    matches: (diffs) => diffs.some(d => d.path?.match?.(/active/) && d.newValue === 'false'),
    describe: () => ['Validation Rule DESATIVADA — registros podem ser salvos sem esta validação'],
    severity: 'critical'
  },
  {
    id: 'vr-formula-change',
    matches: (diffs) => diffs.some(d => d.path?.match?.(/errorConditionFormula/)),
    describe: () => ['Fórmula da VR alterada — validar lógica de negócio'],
    severity: 'warning'
  },
  {
    id: 'vr-error-message-change',
    matches: (diffs) => diffs.some(d => d.path?.match?.(/errorMessage/)),
    describe: () => ['Mensagem de erro alterada'],
    severity: 'info'
  }
];
