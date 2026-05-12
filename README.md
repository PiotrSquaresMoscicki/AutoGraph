# static_web_service_template

This repository is meant to be forked and used as base for creating static webpage with no backend meant to be hosted on github pages or other similar environment.

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

The site will be available at `http://localhost:5173`

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

## Project Structure

```
├── index.html      # Entry HTML file
├── public/         # Static assets
├── src/
│   ├── main.js     # Main JavaScript entry
│   └── style.css   # Styles
└── package.json    # Project configuration
```
