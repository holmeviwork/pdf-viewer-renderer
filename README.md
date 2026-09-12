# PDF Viewer Renderer

A proof-of-concept tool that reads AcroForm PDFs (built with Adobe
LiveCycle Designer, e.g. Skatteverket's forms) and generates a JSON
description of every page and form field. That JSON is then used to
render a browser-based replica of the PDF: the original pages rendered as
images, with real HTML input fields overlaid exactly where the PDF's own
fields are — selectable/searchable text, type-aware validation, and a
sidebar showing every piece of data extracted from the PDF for the
currently focused field (or general document info when nothing is
focused).

## What it does

- **Extraction** (`scripts/extract-form.js`): reads a PDF's AcroForm
  fields via [`pdf-lib`](https://github.com/Hopding/pdf-lib), and — where
  present — also reads the PDF's embedded **XFA** template XML (the rich
  form definition Adobe Designer forms carry alongside the flattened
  AcroForm) and its **XMP metadata** packet. This surfaces data plain
  AcroForm parsing can't: field data type (text/int/float/date),
  alignment, digit limits, tooltips/descriptions, and document identity
  (title, creator, document/instance UUIDs, template version, etc.).
  The result is written as one JSON schema per PDF.
- **Viewer** (`public/`): a static page that renders each PDF page onto a
  `<canvas>` via [`pdf.js`](https://mozilla.github.io/pdf.js/), overlays a
  real, selectable text layer, and places live HTML form fields
  (`<input>`, `<select>`, `<textarea>`, checkboxes) positioned and sized
  to match the schema. Fields are validated according to what the PDF
  itself specifies (digit-only, decimal-comma, date picker, character
  limits, etc.), and a sidebar shows the full extracted data for whatever
  is focused.

## Requirements

- [Node.js](https://nodejs.org/) 18 or later (no other runtime
  dependencies beyond what's in `package.json`)

## Setup

```bash
npm install
```

Then generate schemas for the PDFs in `/assets` and start the server —
see [Commands](#commands) below.

## Project structure

```
assets/              Source PDFs (drop new forms in here)
public/
  schemas/           Generated JSON schemas, one per PDF, + index.json manifest
  index.html         Viewer page
  viewer.js          Renders PDF pages + overlays interactive form fields
  style.css
scripts/
  extract-form.js    Generates/updates schemas (npm run generate / update)
  remove-schema.js   Deletes schemas (npm run remove)
  lib/
    schema-store.js  Shared paths + manifest helpers
    xfa-template.js  Parses the PDF's embedded XFA template (field type,
                      alignment, tooltips, digit limits, etc.)
    xmp-metadata.js  Parses the PDF's XMP metadata (document identity)
server.js            Minimal static file server (no framework)
```

## Commands

| Command | What it does |
|---|---|
| `npm run generate` | Generates a schema for every PDF in `/assets` that doesn't have one yet. For PDFs that already have a schema, asks (y/N) whether to update it. |
| `npm run update all` | Generates/updates every PDF's schema immediately — no prompts. |
| `npm run update <name.pdf>` | Generates/updates just that one PDF's schema, no prompt. The name may be given with or without the `.pdf` extension. |
| `npm run remove` | Asks (y/N), one by one, whether to delete each existing schema. |
| `npm run remove <name>` | Deletes that one schema immediately, no prompt. |
| `npm run remove all` | Deletes every schema immediately, no prompts. |
| `npm run serve` | Starts the static server (default `http://localhost:4000`). |
| `npm start` | Same as `npm run serve` — does **not** touch schemas. Run `generate`/`update` first if you need fresh ones. |

### Typical first run

```bash
npm install
npm run update all   # generate a schema for every PDF in /assets
npm start             # serve the viewer at http://localhost:4000
```

### Adding a new PDF

Drop the file into `/assets`, then run:

```bash
npm run update your-file.pdf
```

(or `npm run generate`, which will pick up any new PDF automatically and
prompt before touching existing schemas).

## Configuration

`server.js` reads `PORT` from the environment (defaults to `4000`):

```bash
PORT=8080 npm start
```

## Notes

- Schema generation is read-only with respect to the source PDFs — it
  never modifies files in `/assets`.
- If a PDF has no embedded XFA/XMP data (plain AcroForm only), extraction
  still works; fields just fall back to generic text/left-aligned
  behavior since there's no richer metadata to draw from.
