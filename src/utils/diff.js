// ============================================================================
// I9 ORG EXPLORER — Lógica de Diff (LCS, sem IA)
// Spec v2.1 · Seção 6
// ============================================================================

/**
 * Calcula diff entre duas strings usando LCS (Longest Common Subsequence).
 * Retorna array de operações: ['eq'|'del'|'add', line]
 *
 * 'eq'  = linha presente em ambos (inalterada)
 * 'del' = linha presente apenas em `a` (gold) — será removida do destino
 * 'add' = linha presente apenas em `b` (destino) — será adicionada
 *
 * @param {string|null} a - conteúdo da gold
 * @param {string|null} b - conteúdo do destino
 * @returns {Array<[string, string]>}
 */
export function computeLcsDiff(a, b) {
  const A = (a || '').split('\n');
  const B = (b || '').split('\n');
  const m = A.length;
  const n = B.length;

  // Tabela DP bottom-up
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Backtrack para gerar operações
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      ops.push(['eq', A[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(['del', A[i]]);
      i++;
    } else {
      ops.push(['add', B[j]]);
      j++;
    }
  }
  while (i < m) ops.push(['del', A[i++]]);
  while (j < n) ops.push(['add', B[j++]]);

  return ops;
}

/**
 * Determina o status de comparação entre gold e destino.
 *
 * @param {string|null} srcContent - conteúdo da gold
 * @param {string|null} tgtContent - conteúdo do destino
 * @returns {'na'|'absent'|'extra'|'ok'|'diff'}
 */
export function diffStatus(srcContent, tgtContent) {
  if (srcContent === null && tgtContent === null) return 'na';
  if (tgtContent === null) return 'absent';
  if (srcContent === null) return 'extra';
  return srcContent === tgtContent ? 'ok' : 'diff';
}

/**
 * Agrupa operações LCS em segmentos (eq ou hunk).
 * Cada hunk é um trecho contíguo de del+add que o usuário pode
 * aplicar ou ignorar individualmente no merge seletivo.
 *
 * @param {Array<[string, string]>} ops - saída de computeLcsDiff
 * @returns {Array<{type:'eq', lines:string[]} | {type:'hunk', dels:string[], adds:string[]}>}
 */
export function groupOpsIntoSegments(ops) {
  const segments = [];
  let i = 0;

  while (i < ops.length) {
    if (ops[i][0] === 'eq') {
      const lines = [];
      while (i < ops.length && ops[i][0] === 'eq') {
        lines.push(ops[i][1]);
        i++;
      }
      segments.push({ type: 'eq', lines });
    } else {
      const dels = [];
      const adds = [];
      while (i < ops.length && ops[i][0] !== 'eq') {
        if (ops[i][0] === 'del') dels.push(ops[i][1]);
        else adds.push(ops[i][1]);
        i++;
      }
      segments.push({ type: 'hunk', dels, adds });
    }
  }

  return segments;
}

/**
 * Aplica somente os hunks cujos índices estão em hunkIndexes.
 * Os demais hunks mantêm a versão do destino (adds).
 * Retorna a string mesclada final.
 *
 * Semântica:
 *   - hunk aplicado  → usa `dels` (linhas da gold)
 *   - hunk rejeitado → usa `adds` (linhas do destino)
 *   - segmentos `eq` → sempre mantidos
 *
 * @param {string} currentContent - conteúdo atual do destino
 * @param {string} goldContent    - conteúdo da gold (fonte)
 * @param {number[]} hunkIndexes  - índices dos hunks a aplicar (0-based)
 * @returns {string}
 */
export function applyHunks(currentContent, goldContent, hunkIndexes) {
  const ops = computeLcsDiff(currentContent, goldContent);
  const segments = groupOpsIntoSegments(ops);
  const out = [];
  let hunkCounter = 0;

  segments.forEach(seg => {
    if (seg.type === 'eq') {
      out.push(...seg.lines);
    } else {
      const useGold = hunkIndexes.includes(hunkCounter);
      // Se useGold, traz as linhas da gold (dels = o que a gold tem a mais / diferente)
      // Se não, mantém as linhas do destino (adds = o que o destino tem)
      out.push(...(useGold ? seg.dels : seg.adds));
      hunkCounter++;
    }
  });

  return out.join('\n');
}
