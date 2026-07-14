/**
 * Formata findings do Vector Agent em Markdown.
 * @param {string} componentName
 * @param {string} componentType
 * @param {Array} findings  [{ ruleId, description, severity }]
 * @returns {string}
 */
export function formatMarkdown(componentName, componentType, findings) {
  if (!findings.length) {
    return `## ${componentType}: ${componentName}\n\nNenhuma diferença significativa detectada.\n`;
  }

  const lines = [
    `## ${componentType}: ${componentName}`,
    '',
    `**${findings.length} alteração(ões) detectada(s)**`,
    ''
  ];

  const bySeverity = { critical: [], warning: [], info: [] };
  for (const f of findings) {
    const sev = bySeverity[f.severity] || bySeverity.info;
    sev.push(f);
  }

  const icons = { critical: '🔴', warning: '🟡', info: '🔵' };

  for (const [sev, items] of Object.entries(bySeverity)) {
    if (!items.length) continue;
    lines.push(`### ${icons[sev]} ${sev.toUpperCase()} (${items.length})`);
    lines.push('');
    for (const item of items) {
      lines.push(`- **[${item.ruleId}]** ${item.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
