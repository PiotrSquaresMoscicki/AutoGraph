// Minimal DOT subset parser/serializer for the editor's source-of-truth model.
// We intentionally support only what the editor itself produces:
//   digraph G {
//     id [label="..."];
//     id -> id [label="..."];
//   }
// Plain `id;` and `id -> id;` (no attributes) are also accepted.

export function serialize(model) {
  const lines = ['digraph G {'];
  for (const node of model.nodes) {
    lines.push(`  ${quoteId(node.id)} [label=${quoteString(node.label)}];`);
  }
  for (const edge of model.edges) {
    const attr = edge.label != null && edge.label !== ''
      ? ` [label=${quoteString(edge.label)}]`
      : '';
    lines.push(`  ${quoteId(edge.from)} -> ${quoteId(edge.to)}${attr};`);
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

// Parse a minimal DOT document and return { nodes, edges }.
// Throws on syntax it doesn't recognize.
export function parse(src) {
  const tokens = tokenize(src);
  let i = 0;

  function peek() { return tokens[i]; }
  function next() { return tokens[i++]; }
  function expect(type, value) {
    const t = next();
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(
        `Parse error: expected ${value ?? type}` +
        (t ? ` but got '${t.value}'` : ' but reached end of input')
      );
    }
    return t;
  }

  // Optional "strict"
  if (peek() && peek().type === 'ident' && peek().value.toLowerCase() === 'strict') next();
  // graph keyword
  const kw = next();
  if (!kw || kw.type !== 'ident' || !['digraph', 'graph'].includes(kw.value.toLowerCase())) {
    throw new Error("Parse error: expected 'digraph' or 'graph' at start");
  }
  // optional graph id
  if (peek() && peek().type === 'ident') next();
  expect('punct', '{');

  const nodes = [];
  const edges = [];
  const seenNodes = new Set();

  function ensureNode(id, label) {
    if (!seenNodes.has(id)) {
      seenNodes.add(id);
      nodes.push({ id, label: label ?? id });
    } else if (label != null) {
      // Update label if a later statement provides one.
      const n = nodes.find((n) => n.id === id);
      if (n) n.label = label;
    }
  }

  while (peek() && !(peek().type === 'punct' && peek().value === '}')) {
    const id1Tok = next();
    if (id1Tok.type !== 'ident') {
      throw new Error(`Parse error: unexpected '${id1Tok.value}'`);
    }
    const id1 = id1Tok.value;

    if (peek() && peek().type === 'punct' && peek().value === '->') {
      next();
      const id2Tok = expect('ident');
      const id2 = id2Tok.value;
      const attrs = parseAttrList();
      ensureNode(id1);
      ensureNode(id2);
      edges.push({ from: id1, to: id2, label: attrs.label ?? '' });
    } else {
      const attrs = parseAttrList();
      ensureNode(id1, attrs.label);
    }
    if (peek() && peek().type === 'punct' && peek().value === ';') next();
  }
  expect('punct', '}');

  function parseAttrList() {
    const out = {};
    if (!(peek() && peek().type === 'punct' && peek().value === '[')) return out;
    next(); // [
    while (peek() && !(peek().type === 'punct' && peek().value === ']')) {
      const k = expect('ident').value;
      expect('punct', '=');
      const v = next();
      if (v.type !== 'ident' && v.type !== 'string') {
        throw new Error(`Parse error: expected attribute value for '${k}'`);
      }
      out[k] = v.value;
      if (peek() && peek().type === 'punct' && (peek().value === ',' || peek().value === ';')) next();
    }
    expect('punct', ']');
    return out;
  }

  return { nodes, edges };
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    // line comments
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // block comments
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // strings
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) { value += src[j + 1]; j += 2; }
        else { value += src[j]; j++; }
      }
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    // -> arrow
    if (c === '-' && src[i + 1] === '>') {
      tokens.push({ type: 'punct', value: '->' });
      i += 2;
      continue;
    }
    if ('{}[]=,;'.includes(c)) {
      tokens.push({ type: 'punct', value: c });
      i++;
      continue;
    }
    // identifier / number
    if (/[A-Za-z_0-9.]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z_0-9.]/.test(src[j])) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Tokenizer: unexpected character '${c}' at ${i}`);
  }
  return tokens;
}

function quoteId(id) {
  if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(id)) return id;
  return quoteString(id);
}

function quoteString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
