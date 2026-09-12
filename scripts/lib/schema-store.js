// Shared paths and helpers for the schema-generating/removing scripts.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..', '..');
const ASSETS_DIR = path.join(ROOT, 'assets');
const SCHEMAS_DIR = path.join(ROOT, 'public', 'schemas');

function schemaPathFor(pdfOrSchemaPath) {
  const base = path.basename(pdfOrSchemaPath, path.extname(pdfOrSchemaPath));
  return path.join(SCHEMAS_DIR, `${base}.json`);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function writeManifest() {
  const manifestPath = path.join(SCHEMAS_DIR, 'index.json');
  const entries = fs
    .readdirSync(SCHEMAS_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => {
      const schema = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, f), 'utf8'));
      return {
        schema: f,
        file: schema.file,
        fieldCount: schema.fields.length,
        pageCount: schema.pages.length,
        generatedAt: schema.generatedAt,
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));

  fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2));
}

module.exports = {
  ROOT,
  ASSETS_DIR,
  SCHEMAS_DIR,
  schemaPathFor,
  ask,
  writeManifest,
};
