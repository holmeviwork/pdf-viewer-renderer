#!/usr/bin/env node

// Deletes generated form schema(s) from public/schemas.
//
// Usage:
//   npm run remove                Ask, one by one, whether to remove each
//                                  existing schema (y/N per form).
//   npm run remove <name>         Remove that one schema immediately, no
//                                  prompt. <name> may be the PDF name or the
//                                  schema name, with or without extension.
//   npm run remove all            Remove every schema immediately, no
//                                  prompts.
//
// Resolves against the schema files already in public/schemas, not against
// /assets, so a schema can still be removed even if its source PDF was
// deleted in the meantime.

const fs = require('fs');
const path = require('path');
const { ROOT, SCHEMAS_DIR, ask, writeManifest } = require('./lib/schema-store');

function listSchemaFiles() {
  if (!fs.existsSync(SCHEMAS_DIR)) return [];
  return fs.readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json');
}

function resolveSchemaArg(target) {
  const base = path.basename(target, path.extname(target));
  const candidate = `${base}.json`;

  const files = listSchemaFiles();
  const match = files.find((f) => f.toLowerCase() === candidate.toLowerCase());
  if (match) return path.join(SCHEMAS_DIR, match);

  throw new Error(
    `Could not find a schema for "${target}" in ${path.relative(ROOT, SCHEMAS_DIR)}. Available schemas:\n` +
      (files.length ? files.map((f) => `  - ${f}`).join('\n') : '  (none)'),
  );
}

function pdfNameFor(schemaFile) {
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, schemaFile), 'utf8'));
  return schema.file || schemaFile;
}

function removeSchema(schemaPath) {
  fs.unlinkSync(schemaPath);
  console.log(`Removed ${path.relative(ROOT, schemaPath)}`);
}

async function main() {
  const target = process.argv[2];

  if (target === 'all') {
    const schemaFiles = listSchemaFiles();
    if (schemaFiles.length === 0) {
      console.log('No schemas found.');
      return;
    }
    for (const schemaFile of schemaFiles) {
      removeSchema(path.join(SCHEMAS_DIR, schemaFile));
    }
  } else if (target) {
    const schemaPath = resolveSchemaArg(target);
    removeSchema(schemaPath);
  } else {
    const schemaFiles = listSchemaFiles();
    if (schemaFiles.length === 0) {
      console.log('No schemas found.');
      return;
    }

    for (const schemaFile of schemaFiles) {
      const pdfName = pdfNameFor(schemaFile);
      const answer = await ask(`Remove schema for "${pdfName}"? (y/N) `);
      if (answer === 'y' || answer === 'yes') {
        removeSchema(path.join(SCHEMAS_DIR, schemaFile));
      } else {
        console.log(`Skipped ${pdfName}`);
      }
    }
  }

  writeManifest();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
