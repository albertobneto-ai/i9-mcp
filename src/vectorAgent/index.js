// ============================================================================
// I9 ORG EXPLORER — Vector Agent (motor determinístico, sem IA)
// Spec v2.1 · Seção 10.6
// ============================================================================

import { parseXml } from './parsers/xml.js';
import { parseCodeDiff } from './parsers/apex.js';
import { formatMarkdown } from './formatters/markdown.js';
import { formatJson } from './formatters/json.js';

// Import rules
import { rules as sharedRules } from './rules/_shared.js';
import { rules as flowRules } from './rules/Flow.js';
import { rules as apexRules } from './rules/ApexClass.js';
import { rules as psRules } from './rules/PermissionSet.js';
import { rules as vrRules } from './rules/ValidationRule.js';
import { rules as layoutRules } from './rules/Layout.js';

const RULES_BY_TYPE = {
  Flow: flowRules,
  ApexClass: apexRules,
  ApexTrigger: apexRules,
  PermissionSet: psRules,
  ValidationRule: vrRules,
  Layout: layoutRules,
};

const XML_TYPES = new Set([
  'Flow', 'PermissionSet', 'ValidationRule', 'Layout',
  'CustomField', 'CustomObject', 'Bot', 'BotVersion',
  'GenAiPlannerBundle', 'GenAiPlugin', 'GenAiFunction'
]);
const CODE_TYPES = new Set(['ApexClass', 'ApexTrigger', 'LightningComponentBundle']);

/**
 * Diff estrutural entre dois objetos (recursivo, produz lista de mudanças).
 */
function deepDiff(obj1, obj2, path = '') {
  const diffs = [];
  if (obj1 === obj2) return diffs;
  if (obj1 === null || obj1 === undefined) {
    diffs.push({ kind: 'added', path, oldValue: null, newValue: obj2 });
    return diffs;
  }
  if (obj2 === null || obj2 === undefined) {
    diffs.push({ kind: 'removed', path, oldValue: obj1, newValue: null });
    return diffs;
  }
  if (typeof obj1 !== typeof obj2) {
    diffs.push({ kind: 'changed', path, oldValue: String(obj1), newValue: String(obj2) });
    return diffs;
  }
  if (typeof obj1 !== 'object') {
    if (obj1 !== obj2) diffs.push({ kind: 'changed', path, oldValue: String(obj1), newValue: String(obj2) });
    return diffs;
  }
  if (Array.isArray(obj1) && Array.isArray(obj2)) {
    const max = Math.max(obj1.length, obj2.length);
    for (let i = 0; i < max; i++) {
      diffs.push(...deepDiff(obj1[i], obj2[i], `${path}[${i}]`));
    }
    return diffs;
  }
  const allKeys = new Set([...Object.keys(obj1 || {}), ...Object.keys(obj2 || {})]);
  for (const key of allKeys) {
    const childPath = path ? `${path}.${key}` : key;
    diffs.push(...deepDiff(obj1[key], obj2[key], childPath));
  }
  return diffs;
}

/**
 * Analisa diferenças entre gold e dest para um componente.
 *
 * @param {Object} params
 * @param {string} params.component_name
 * @param {string} params.component_type
 * @param {string|null} params.gold_content
 * @param {string|null} params.dest_content
 * @returns {{ markdown: string, structured: Array }}
 */
export function analyze({ component_name, component_type, gold_content, dest_content }) {
  const findings = [];

  // Absent/extra: relatório simples
  if (!gold_content && !dest_content) {
    return { markdown: formatMarkdown(component_name, component_type, []), structured: [] };
  }
  if (!dest_content) {
    findings.push({ ruleId: 'absent', description: `Componente ausente no destino`, severity: 'warning', tipo: 'pattern_detected' });
    return { markdown: formatMarkdown(component_name, component_type, findings), structured: formatJson(findings) };
  }
  if (!gold_content) {
    findings.push({ ruleId: 'extra', description: `Componente existe apenas no destino (extra)`, severity: 'info', tipo: 'pattern_detected' });
    return { markdown: formatMarkdown(component_name, component_type, findings), structured: formatJson(findings) };
  }

  let structuralDiffs = [];

  // Router por tipo
  if (XML_TYPES.has(component_type)) {
    // Parse XML de ambos e comparar estruturalmente
    const goldObj = parseXml(gold_content);
    const destObj = parseXml(dest_content);
    structuralDiffs = deepDiff(goldObj, destObj);
  } else if (CODE_TYPES.has(component_type)) {
    // Diff por linha com heurísticas
    const codeDiffs = parseCodeDiff(gold_content, dest_content);
    structuralDiffs = codeDiffs.map(d => ({
      kind: d.type === 'line_removed' ? 'line_removed' : 'line_added',
      path: `line:${d.line}`,
      oldValue: d.type === 'line_removed' ? d.content : null,
      newValue: d.type === 'line_added' ? d.content : null,
      content: d.content
    }));

    // Detect throw-to-debug pattern
    const hasThrowRemoved = codeDiffs.some(d => d.type === 'line_removed' && d.content?.match?.(/throw\b/));
    const hasDebugAdded = codeDiffs.some(d => d.type === 'line_added' && d.content?.match?.(/System\.debug/i));
    if (hasThrowRemoved && hasDebugAdded) {
      structuralDiffs.push({ kind: 'code_pattern', pattern: 'throw_to_debug' });
    }
  } else {
    // Fallback: tratar como texto
    structuralDiffs = deepDiff(gold_content, dest_content);
  }

  // Aplicar regras específicas do tipo
  const typeRules = RULES_BY_TYPE[component_type] || [];
  for (const rule of typeRules) {
    try {
      if (rule.matches(structuralDiffs)) {
        const descriptions = rule.describe(structuralDiffs);
        const descs = Array.isArray(descriptions) ? descriptions : [descriptions];
        for (const desc of descs) {
          findings.push({
            ruleId: rule.id,
            description: desc,
            severity: rule.severity,
            tipo: rule.id.includes('added') ? 'line_added' : rule.id.includes('removed') ? 'line_removed' : 'pattern_detected'
          });
        }
      }
    } catch (e) { /* Rule execution error — skip silently */ }
  }

  // Aplicar regras genéricas (_shared)
  for (const rule of sharedRules) {
    try {
      if (rule.matches(structuralDiffs)) {
        const descriptions = rule.describe(structuralDiffs);
        const descs = Array.isArray(descriptions) ? descriptions : [descriptions];
        for (const desc of descs) {
          // Avoid duplicates from type-specific rules
          if (!findings.some(f => f.description === desc)) {
            findings.push({
              ruleId: rule.id,
              description: desc,
              severity: rule.severity,
              tipo: rule.id.includes('added') ? 'field_change' : 'pattern_detected'
            });
          }
        }
      }
    } catch (e) { /* skip */ }
  }

  // Se nenhuma regra matchou mas há diffs, reportar count genérico
  if (!findings.length && structuralDiffs.length) {
    findings.push({
      ruleId: 'generic-diff',
      description: `${structuralDiffs.length} diferença(s) detectada(s) sem regra específica`,
      severity: 'info',
      tipo: 'field_change'
    });
  }

  return {
    markdown: formatMarkdown(component_name, component_type, findings),
    structured: formatJson(findings)
  };
}
