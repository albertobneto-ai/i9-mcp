/**
 * Formata findings do Vector Agent como structured JSON.
 * @param {Array} findings
 * @returns {Array}
 */
export function formatJson(findings) {
  return findings.map((f, i) => ({
    trecho: i + 1,
    tipo: f.tipo || 'pattern_detected',
    description: f.description,
    severity: f.severity,
    ruleId: f.ruleId
  }));
}
