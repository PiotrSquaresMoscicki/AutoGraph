# AutoGraph

AutoGraph is a small, client-side graph editor that lets you build directed graphs visually and keeps a live [DOT](https://graphviz.org/doc/info/lang.html) representation in sync with your edits. It runs entirely in the browser (no backend) and is built with [Vite](https://vitejs.dev/) and [@viz-js/viz](https://github.com/mdaines/viz-js) for Graphviz rendering.

## Features

- Visual editing of directed graphs (add / connect / rename / delete nodes and edges).
- Live two-way sync between the graph and its DOT source: edits on either side update the other.
- Optional DOT source pane that can be shown or hidden; the choice is remembered across reloads.
- **Save** the current graph to a `.dot` file.
- **Load** a `.dot` / `.gv` file; invalid files surface a non-blocking error and leave the current graph untouched.

## Getting Started

### Prerequisites

- Node.js (v18 or higher recommended)
- npm

### Installation

```bash
npm install
```

### Development

Start the development server with hot reload:

```bash
npm run dev
```

The site will be available at `http://localhost:5173`.

### Build

Build for production:

```bash
npm run build
```

The built files will be in the `dist` directory.

### Preview

Preview the production build:

```bash
npm run preview
```

## Usage

The header exposes the main file actions and the DOT pane toggle:

- **Save** — download the current graph as a `.dot` file.
- **Load** — open a `.dot` / `.gv` file and replace the current graph.
- **Show DOT / Hide DOT** — toggle the DOT source pane (collapsed by default).

### Mouse

- Double-click empty space — create a new node.
- Drag from a node — start an edge; drop on another node to connect, or on empty space to create and connect a new node.
- Click a node or edge — select it.
- Double-click a node or edge — rename its label inline (`Enter` commits, `Esc` cancels, blur commits).

### Touch

The same drag-to-connect interaction is available on touch devices: press on a
node, drag, and lift on another node (or on empty space) to create an edge.

### Keyboard

- **Delete** / **Backspace** — remove the current selection (ignored while editing text fields).
- **F2** — rename the currently selected node or edge.
- **Enter** — rename the currently selected node or edge.

## Project Structure

```
├── index.html      # Entry HTML file
├── public/         # Static assets
├── src/
│   ├── main.js     # App bootstrap, UI wiring, state, save/load
│   ├── dot.js      # Minimal DOT parse() / serialize()
│   └── style.css   # Styles
└── package.json    # Project configuration
```
