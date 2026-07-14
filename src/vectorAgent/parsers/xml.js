// Lightweight XML-to-Object parser (zero dependencies)
// Suficiente para Salesforce Metadata XML

export function parseXml(xmlStr) {
  if (!xmlStr || typeof xmlStr !== 'string') return null;
  const str = xmlStr.trim();
  try {
    return parseNode(str, 0).node;
  } catch (e) {
    return { _parseError: e.message, _raw: str.substring(0, 500) };
  }
}

function parseNode(s, pos) {
  // Skip whitespace and XML declarations/comments
  while (pos < s.length) {
    pos = skipWhitespace(s, pos);
    if (s.startsWith('<?', pos)) { pos = s.indexOf('?>', pos) + 2; continue; }
    if (s.startsWith('<!--', pos)) { pos = s.indexOf('-->', pos) + 3; continue; }
    break;
  }
  if (pos >= s.length || s[pos] !== '<') return { node: s.substring(pos).trim(), pos: s.length };

  const tagEnd = s.indexOf('>', pos);
  if (tagEnd === -1) return { node: null, pos: s.length };

  const tagContent = s.substring(pos + 1, tagEnd);

  // Self-closing tag
  if (tagContent.endsWith('/')) {
    const name = tagContent.replace(/\/.*/, '').split(/\s/)[0];
    return { node: { [name]: null }, pos: tagEnd + 1 };
  }

  const tagName = tagContent.split(/[\s/>]/)[0];
  const closeTag = `</${tagName}>`;

  // Find matching close tag (handle nesting)
  let depth = 1, searchPos = tagEnd + 1;
  while (depth > 0 && searchPos < s.length) {
    const nextOpen = s.indexOf(`<${tagName}`, searchPos);
    const nextClose = s.indexOf(closeTag, searchPos);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Check it's actually an opening tag (not a different tag starting with same prefix)
      const charAfter = s[nextOpen + tagName.length + 1];
      if (charAfter === '>' || charAfter === ' ' || charAfter === '/') {
        depth++;
      }
      searchPos = nextOpen + tagName.length + 1;
    } else {
      depth--;
      if (depth === 0) {
        const inner = s.substring(tagEnd + 1, nextClose).trim();
        const endPos = nextClose + closeTag.length;

        // Check if inner contains child elements
        if (inner.includes('<')) {
          const children = parseChildren(inner);
          return { node: { [tagName]: children }, pos: endPos };
        } else {
          return { node: { [tagName]: inner || null }, pos: endPos };
        }
      }
      searchPos = nextClose + closeTag.length;
    }
  }
  return { node: { [tagName]: s.substring(tagEnd + 1).trim() }, pos: s.length };
}

function parseChildren(inner) {
  const result = {};
  let pos = 0;
  while (pos < inner.length) {
    pos = skipWhitespace(inner, pos);
    if (pos >= inner.length) break;
    if (inner[pos] !== '<') { pos++; continue; }
    if (inner.startsWith('<!--', pos)) { pos = inner.indexOf('-->', pos) + 3; continue; }

    const { node, pos: newPos } = parseNode(inner, pos);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k in result) {
          if (!Array.isArray(result[k])) result[k] = [result[k]];
          result[k].push(v);
        } else {
          result[k] = v;
        }
      }
    }
    pos = newPos;
    if (newPos === pos) pos++; // Safety: avoid infinite loop
  }
  return result;
}

function skipWhitespace(s, pos) {
  while (pos < s.length && /\s/.test(s[pos])) pos++;
  return pos;
}
