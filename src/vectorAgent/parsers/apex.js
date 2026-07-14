// Code-level diff parser using LCS (reuses diff.js) + pattern detection
import { computeLcsDiff, groupOpsIntoSegments } from '../../utils/diff.js';

export function parseCodeDiff(goldContent, destContent) {
  if (!goldContent && !destContent) return [];

  const ops = computeLcsDiff(goldContent || '', destContent || '');
  const segments = groupOpsIntoSegments(ops);
  const findings = [];

  let lineNum = 0;
  for (const seg of segments) {
    if (seg.type === 'eq') {
      lineNum += seg.lines.length;
      continue;
    }

    // Analyze hunk
    for (const line of seg.dels) {
      lineNum++;
      findings.push({ type: 'line_removed', line: lineNum, content: line.trim() });
    }
    for (const line of seg.adds) {
      lineNum++;
      findings.push({ type: 'line_added', line: lineNum, content: line.trim() });
    }
  }

  return findings;
}
