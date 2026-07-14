export const rules = [
  {
    id: 'ps-modify-all',
    matches: (diffs) => diffs.some(d =>
      d.path?.match?.(/modifyAllRecords|viewAllRecords/) && d.newValue === 'true'
    ),
    describe: (diffs) => diffs.filter(d => d.path?.match?.(/modifyAllRecords|viewAllRecords/) && d.newValue === 'true').map(d =>
      `Permissão \`${d.path}\` habilitada — acesso amplo concedido`
    ),
    severity: 'critical'
  },
  {
    id: 'ps-field-permission-change',
    matches: (diffs) => diffs.some(d => d.path?.match?.(/fieldPermissions/)),
    describe: (diffs) => {
      const fps = diffs.filter(d => d.path?.match?.(/fieldPermissions/));
      return [`${fps.length} alteração(ões) em Field Permissions`];
    },
    severity: 'info'
  }
];
