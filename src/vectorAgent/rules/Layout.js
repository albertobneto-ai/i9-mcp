export const rules = [
  {
    id: 'layout-section-change',
    matches: (diffs) => diffs.some(d => d.path?.match?.(/layoutSections/)),
    describe: (diffs) => {
      const secs = diffs.filter(d => d.path?.match?.(/layoutSections/));
      return [`${secs.length} alteração(ões) em seções do layout`];
    },
    severity: 'info'
  },
  {
    id: 'layout-required-field',
    matches: (diffs) => diffs.some(d => d.path?.match?.(/required/) && d.newValue === 'true'),
    describe: (diffs) => diffs.filter(d => d.path?.match?.(/required/) && d.newValue === 'true').map(d =>
      `Campo tornado obrigatório: \`${d.path}\``
    ),
    severity: 'warning'
  }
];
