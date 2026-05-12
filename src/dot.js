// dot.js — Lightweight Graphviz DOT parser, serializer, and structural mutations.
// The DOT string is the source of truth. We parse only when we need structure
// (rendering, focus mode, mutations). Mutations re-serialize in canonical form.

// -----------------------------------------------------------------------------
// Tokenizer / parser
// -----------------------------------------------------------------------------

const ID_RE = /^([A-Za-z_\u0080-\uFFFF][A-Za-z_0-9\u0080-\uFFFF]*|-?(?:\.\d+|\d+(?:\.\d+)?))/;

function stripComments(src) {
  // Block, line, and shell-style comments at line start.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/^[\t ]*#[^\n]*/gm, '');
}

class Tokenizer {
  constructor(src) {
    this.src = src;
    this.i = 0;
  }
  eof() {
    return this.i >= this.src.length;
  }
  skipWs() {
    while (!this.eof() && /\s/.test(this.src[this.i])) this.i++;
  }
  peek() {
    this.skipWs();
    return this.src[this.i];
  }
  // Read an identifier per the DOT grammar.
  readId() {
    this.skipWs();
    if (this.eof()) return null;
    const c = this.src[this.i];

    // Quoted string with optional `"a" + "b"` concatenation.
    if (c === '"') {
      const parts = [];
      while (!this.eof() && this.src[this.i] === '"') {
        this.i++;
        let s = '';
        while (!this.eof() && this.src[this.i] !== '"') {
          if (this.src[this.i] === '\\' && this.i + 1 < this.src.length) {
            s += this.src[this.i + 1];
            this.i += 2;
          } else {
            s += this.src[this.i++];
          }
        }
        this.i++; // closing quote
        parts.push(s);
        const save = this.i;
        this.skipWs();
        if (this.src[this.i] === '+') {
          this.i++;
          this.skipWs();
          if (this.src[this.i] === '"') continue;
        }
        this.i = save;
        break;
      }
      return { kind: 'quoted', value: parts.join('') };
    }

    // HTML-like label <...> (supports nesting).
    if (c === '<') {
      let depth = 0;
      const start = this.i;
      while (!this.eof()) {
        if (this.src[this.i] === '<') depth++;
        else if (this.src[this.i] === '>') {
          depth--;
          if (depth === 0) {
            this.i++;
            break;
          }
        }
        this.i++;
      }
      return { kind: 'html', value: this.src.slice(start, this.i) };
    }

    const m = this.src.slice(this.i).match(ID_RE);
    if (m) {
      this.i += m[0].length;
      return { kind: 'id', value: m[0] };
    }
    return null;
  }

  // Read an attribute list `[ k = v, k2 = v2; ... ]`. Returns { attrs, end }.
  readAttrList() {
    this.skipWs();
    if (this.src[this.i] !== '[') return null;
    this.i++;
    const attrs = {};
    while (!this.eof()) {
      this.skipWs();
      if (this.src[this.i] === ']') {
        this.i++;
        return attrs;
      }
      if (this.src[this.i] === ',' || this.src[this.i] === ';') {
        this.i++;
        continue;
      }
      const k = this.readId();
      if (!k) {
        this.i++;
        continue;
      }
      this.skipWs();
      if (this.src[this.i] !== '=') {
        // Per DOT grammar key must be followed by '=' inside attr list.
        continue;
      }
      this.i++;
      const v = this.readId();
      attrs[k.value] = v ? v.value : '';
    }
    return attrs;
  }
}

/**
 * Parse a DOT string into a lightweight structural model.
 * Returns: { strict, type ('graph'|'digraph'), name, nodes, edges, errors }
 * - nodes: Map<id, { attrs }>
 * - edges: Array<{ source, target, attrs }>
 */
export function parseDot(src) {
  const errors = [];
  const text = stripComments(src);
  const headerRe = /(?:strict\s+)?(graph|digraph)\b/i;
  const headerMatch = text.match(headerRe);
  if (!headerMatch) {
    return {
      strict: false,
      type: 'digraph',
      name: '',
      nodes: new Map(),
      edges: [],
      errors: ['No graph header found'],
    };
  }
  const strict = /\bstrict\b/i.test(text.slice(0, headerMatch.index + 8));
  const type = headerMatch[1].toLowerCase();

  // Read optional name and locate body braces.
  const tk = new Tokenizer(text);
  tk.i = headerMatch.index + headerMatch[0].length;
  tk.skipWs();
  let name = '';
  if (tk.src[tk.i] !== '{') {
    const idTok = tk.readId();
    if (idTok) name = idTok.value;
    tk.skipWs();
  }
  if (tk.src[tk.i] !== '{') {
    return {
      strict,
      type,
      name,
      nodes: new Map(),
      edges: [],
      errors: ['Missing { in graph'],
    };
  }
  tk.i++;
  const bodyStart = tk.i;
  // Find matching closing brace (track string/HTML literals).
  let depth = 1;
  let j = bodyStart;
  while (j < tk.src.length && depth > 0) {
    const ch = tk.src[j];
    if (ch === '"') {
      j++;
      while (j < tk.src.length && tk.src[j] !== '"') {
        if (tk.src[j] === '\\') j += 2;
        else j++;
      }
      j++;
      continue;
    }
    if (ch === '<') {
      let hd = 1;
      j++;
      while (j < tk.src.length && hd > 0) {
        if (tk.src[j] === '<') hd++;
        else if (tk.src[j] === '>') hd--;
        j++;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    j++;
  }
  const bodyEnd = j - 1;
  const body = tk.src.slice(bodyStart, bodyEnd);

  // Walk statements within body.
  const nodes = new Map();
  const edges = [];
  const graphAttrs = {}; // graph-level: a=b;
  const defaultAttrs = { node: {}, edge: {}, graph: {} };
  const inner = new Tokenizer(body);

  const KEYWORDS = new Set(['node', 'edge', 'graph', 'subgraph']);

  while (!inner.eof()) {
    inner.skipWs();
    if (inner.eof()) break;
    const c = inner.src[inner.i];
    if (c === ';' || c === ',') {
      inner.i++;
      continue;
    }
    if (c === '{') {
      // anonymous subgraph — skip balanced
      let d = 1;
      inner.i++;
      while (!inner.eof() && d > 0) {
        if (inner.src[inner.i] === '{') d++;
        else if (inner.src[inner.i] === '}') d--;
        inner.i++;
      }
      continue;
    }
    const startI = inner.i;
    const first = inner.readId();
    if (!first) {
      inner.i++;
      continue;
    }

    // subgraph definition
    if (first.kind === 'id' && first.value.toLowerCase() === 'subgraph') {
      // optional id, then '{', balance braces
      inner.skipWs();
      if (inner.src[inner.i] !== '{') inner.readId();
      inner.skipWs();
      if (inner.src[inner.i] === '{') {
        let d = 1;
        inner.i++;
        while (!inner.eof() && d > 0) {
          if (inner.src[inner.i] === '{') d++;
          else if (inner.src[inner.i] === '}') d--;
          inner.i++;
        }
      }
      continue;
    }

    inner.skipWs();
    const next = inner.src.slice(inner.i, inner.i + 2);

    // Edge statement: a -> b [-> c]* [attrs];
    if (next === '->' || next === '--') {
      const op = next;
      const ends = [first.value];
      while (inner.src.slice(inner.i, inner.i + 2) === op) {
        inner.i += 2;
        const t = inner.readId();
        if (!t) break;
        ends.push(t.value);
        inner.skipWs();
      }
      const attrs = inner.readAttrList() || {};
      for (let k = 0; k < ends.length - 1; k++) {
        const s = ends[k];
        const tg = ends[k + 1];
        // Implicitly declare endpoints as nodes.
        if (!nodes.has(s)) nodes.set(s, { attrs: {} });
        if (!nodes.has(tg)) nodes.set(tg, { attrs: {} });
        edges.push({ source: s, target: tg, attrs: { ...attrs } });
      }
      // consume optional ; ,
      inner.skipWs();
      if (inner.src[inner.i] === ';' || inner.src[inner.i] === ',') inner.i++;
      continue;
    }

    // Attribute assignment at graph level: key = value
    if (inner.src[inner.i] === '=') {
      inner.i++;
      const v = inner.readId();
      graphAttrs[first.value] = v ? v.value : '';
      inner.skipWs();
      if (inner.src[inner.i] === ';' || inner.src[inner.i] === ',') inner.i++;
      continue;
    }

    // Default-attr statement: node [..], edge [..], graph [..]
    if (
      first.kind === 'id' &&
      KEYWORDS.has(first.value.toLowerCase()) &&
      inner.src[inner.i] === '['
    ) {
      const kw = first.value.toLowerCase();
      const da = inner.readAttrList() || {};
      Object.assign(defaultAttrs[kw], da);
      inner.skipWs();
      if (inner.src[inner.i] === ';' || inner.src[inner.i] === ',') inner.i++;
      continue;
    }

    // Node statement: id [attrs];
    const attrs = inner.readAttrList() || {};
    if (nodes.has(first.value)) {
      Object.assign(nodes.get(first.value).attrs, attrs);
    } else {
      nodes.set(first.value, { attrs });
    }
    inner.skipWs();
    if (inner.src[inner.i] === ';' || inner.src[inner.i] === ',') inner.i++;
  }

  return { strict, type, name, nodes, edges, graphAttrs, defaultAttrs, errors };
}

// -----------------------------------------------------------------------------
// Serialization
// -----------------------------------------------------------------------------

function needsQuoting(s) {
  if (s === '' || s === null || s === undefined) return true;
  // Allowed unquoted ID (numbers or simple identifiers).
  if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(s)) return false;
  if (/^-?(?:\.\d+|\d+(?:\.\d+)?)$/.test(s)) return false;
  return true;
}

export function quoteId(s) {
  if (typeof s !== 'string') s = String(s);
  // HTML labels are pass-through if they start with '<' and end with '>'
  if (s.startsWith('<') && s.endsWith('>')) return s;
  if (!needsQuoting(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function emitAttrs(attrs) {
  const keys = Object.keys(attrs);
  if (keys.length === 0) return '';
  const parts = keys.map((k) => `${quoteId(k)}=${quoteId(attrs[k])}`);
  return ' [' + parts.join(', ') + ']';
}

/**
 * Canonical serializer. Emits a clean DOT document from a model object.
 */
export function serializeDot(model) {
  const head =
    (model.strict ? 'strict ' : '') +
    (model.type || 'digraph') +
    (model.name ? ' ' + quoteId(model.name) : '');
  const lines = [head + ' {'];
  const ga = model.graphAttrs || {};
  for (const k of Object.keys(ga)) {
    lines.push(`  ${quoteId(k)}=${quoteId(ga[k])};`);
  }
  const da = model.defaultAttrs || { node: {}, edge: {}, graph: {} };
  for (const kw of ['graph', 'node', 'edge']) {
    const a = da[kw] || {};
    if (Object.keys(a).length) {
      lines.push(`  ${kw}${emitAttrs(a)};`);
    }
  }
  for (const [id, n] of model.nodes) {
    lines.push(`  ${quoteId(id)}${emitAttrs(n.attrs)};`);
  }
  const connector = model.type === 'graph' ? ' -- ' : ' -> ';
  for (const e of model.edges) {
    lines.push(`  ${quoteId(e.source)}${connector}${quoteId(e.target)}${emitAttrs(e.attrs)};`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

// -----------------------------------------------------------------------------
// Mutations (each returns a new DOT string)
// -----------------------------------------------------------------------------

function withModel(dot, fn) {
  const m = parseDot(dot);
  fn(m);
  return serializeDot(m);
}

export function uniqueNodeId(dot, base = 'n') {
  const m = parseDot(dot);
  let i = 1;
  while (m.nodes.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

export function addNode(dot, id, attrs = {}) {
  return withModel(dot, (m) => {
    if (!m.nodes.has(id)) m.nodes.set(id, { attrs: { ...attrs } });
    else Object.assign(m.nodes.get(id).attrs, attrs);
  });
}

export function addEdge(dot, source, target, attrs = {}) {
  return withModel(dot, (m) => {
    if (!m.nodes.has(source)) m.nodes.set(source, { attrs: {} });
    if (!m.nodes.has(target)) m.nodes.set(target, { attrs: {} });
    // Avoid duplicate identical edges in strict graphs.
    const exists = m.edges.some(
      (e) =>
        e.source === source &&
        e.target === target &&
        Object.keys(attrs).length === 0
    );
    if (!exists) m.edges.push({ source, target, attrs: { ...attrs } });
  });
}

export function setNodeLabel(dot, id, label) {
  return withModel(dot, (m) => {
    if (!m.nodes.has(id)) m.nodes.set(id, { attrs: {} });
    const n = m.nodes.get(id);
    if (label === '' || label === null || label === undefined) delete n.attrs.label;
    else n.attrs.label = label;
  });
}

export function setEdgeLabel(dot, source, target, label) {
  return withModel(dot, (m) => {
    const e = m.edges.find((x) => x.source === source && x.target === target);
    if (!e) return;
    if (label === '' || label === null || label === undefined) delete e.attrs.label;
    else e.attrs.label = label;
  });
}

export function removeNode(dot, id) {
  return withModel(dot, (m) => {
    m.nodes.delete(id);
    m.edges = m.edges.filter((e) => e.source !== id && e.target !== id);
  });
}

/**
 * Build a DOT subgraph containing only the given root, plus all ancestors and
 * descendants. Edges are filtered to those whose endpoints are both included.
 */
export function focusDot(dot, rootId) {
  const m = parseDot(dot);
  if (!m.nodes.has(rootId)) return dot;

  // Build forward / reverse adjacency.
  const fwd = new Map();
  const rev = new Map();
  for (const [id] of m.nodes) {
    fwd.set(id, []);
    rev.set(id, []);
  }
  for (const e of m.edges) {
    if (!fwd.has(e.source)) fwd.set(e.source, []);
    if (!rev.has(e.target)) rev.set(e.target, []);
    fwd.get(e.source).push(e.target);
    rev.get(e.target).push(e.source);
  }
  const reach = (start, adj) => {
    const seen = new Set([start]);
    const q = [start];
    while (q.length) {
      const cur = q.shift();
      for (const nx of adj.get(cur) || []) {
        if (!seen.has(nx)) {
          seen.add(nx);
          q.push(nx);
        }
      }
    }
    return seen;
  };
  const desc = reach(rootId, fwd);
  const anc = reach(rootId, rev);
  const keep = new Set([...desc, ...anc]);

  const sub = {
    strict: m.strict,
    type: m.type,
    name: m.name,
    nodes: new Map(),
    edges: [],
    graphAttrs: { ...m.graphAttrs },
    defaultAttrs: {
      node: { ...m.defaultAttrs.node },
      edge: { ...m.defaultAttrs.edge },
      graph: { ...m.defaultAttrs.graph },
    },
  };
  for (const [id, n] of m.nodes) {
    if (keep.has(id)) sub.nodes.set(id, { attrs: { ...n.attrs } });
  }
  for (const e of m.edges) {
    if (keep.has(e.source) && keep.has(e.target)) {
      sub.edges.push({ source: e.source, target: e.target, attrs: { ...e.attrs } });
    }
  }
  return serializeDot(sub);
}

export function getModel(dot) {
  return parseDot(dot);
}

/**
 * Returns the default empty document used when no DOT is provided.
 */
export function emptyDot() {
  return [
    'digraph G {',
    '  rankdir=LR;',
    '  node [shape=box, style="rounded,filled", fillcolor="#2d2d2d", fontcolor="#f0f0f0", color="#b0b0b0"];',
    '  edge [color="#b0b0b0", fontcolor="#f0f0f0"];',
    '  bgcolor="transparent";',
    '  n1 [label="Start"];',
    '  n2 [label="Step 2"];',
    '  n3 [label="Done"];',
    '  n1 -> n2;',
    '  n2 -> n3;',
    '}',
    '',
  ].join('\n');
}
