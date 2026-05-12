# AutoGraph — Interactive Auto-Layout Graph Editor

AutoGraph is a browser-based graph editor that uses the **pure Graphviz
engine** (via `@hpcc-js/wasm` and `d3-graphviz`) to automatically lay out
graphs for readability. The graph state is maintained entirely as a standard
Graphviz **DOT** string — every interaction parses the SVG event, updates the
underlying DOT source, and triggers a re-render.

## Features

- **Auto-layout** with the Graphviz `dot` engine — no manual node placement.
- **Mouse, trackpad, and touch** input via D3 / Pointer Events:
  - Wheel = vertical pan, **Shift + wheel** = horizontal pan,
    **Ctrl/⌘ + wheel** = zoom.
  - **Pinch-to-zoom** on touchpads and touch screens.
- **Canvas interactions**
  - Double-click / double-tap empty space → new node.
  - Drag from a node to empty space → new node + edge.
  - Drag from a node to another node → new edge.
  - Single click / tap a node → select (highlight persists across re-renders).
  - Double-click / double-tap a node or edge → floating HTML input to edit the
    `label` attribute in the DOT source.
- **Undo / Redo** stack (Ctrl/⌘+Z, Ctrl/⌘+Y / Ctrl/⌘+Shift+Z). Stack resets on
  page refresh, per the spec.
- **Focus Mode**: isolate the selected node by generating a temporary DOT
  containing only the node, its ancestors, and its descendants. The main DOT
  is preserved in memory.
- **DOT code editor** (CodeMirror 6, hidden by default) with two-way binding:
  typing updates the graph, graph mutations update the editor.
- **Save / Load** `.dot` / `.gv` files from the local filesystem.
- **Touch-friendly UI**: every toolbar button is at least 44×44 px.

## Source layout

```
src/
  main.js     Entry point — wires together state, renderer, editor and UI
  dot.js      Lightweight DOT parser, serializer and structural mutations
  graph.js    d3-graphviz renderer + canvas interaction (pointer events)
  zoom.js     Custom d3-zoom filter (wheel-pan, ctrl-zoom, pinch-zoom)
  editor.js   CodeMirror 6 DOT editor
  state.js    Undo / redo stack (array of DOT strings)
  io.js       Save / load DOT files
  style.css   Responsive dark theme; mobile-first
```

## Getting Started

### Prerequisites

- Node.js (v18+) and npm.

### Install & run

```bash
npm install
npm run dev      # development server with hot reload
npm run build    # production build into dist/
npm run preview  # preview the production build
```

The dev server runs at `http://localhost:5173`.

## How interactions map to DOT

| Action                                         | Mutation                          |
| ---------------------------------------------- | --------------------------------- |
| Double-tap empty space                         | append `nN [label="nN"];`         |
| Drag node → empty space                        | append node *and* edge            |
| Drag node → other node                         | append edge `a -> b;`             |
| Double-tap node / edge label, edit text, Enter | update `label="..."` attribute    |
| Focus mode                                     | regenerate DOT with subgraph only |
| DOT editor typing                              | replace entire DOT source         |

The renderer is debounced and re-uses the previous viewport transform, so the
camera (zoom / pan) stays stable across mutations. D3 listeners are torn down
and reinstalled on each render to avoid duplicate event firing.

## License

See the repository's licensing terms.

