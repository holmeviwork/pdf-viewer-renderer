#!/usr/bin/env node

// Reads AcroForm PDFs from ./assets and writes, per PDF, a JSON description
// of every page and form field (position, size, type) so a web page can
// render an HTML overlay that lines up with the original PDF.
//
// Usage (same script, available as both `npm run generate` and
// `npm run update`):
//   npm run generate                 Generate schemas for every PDF in
//                                     ./assets that doesn't have one yet.
//                                     For PDFs that already have a schema,
//                                     ask (one by one) whether to update it.
//   npm run update all               Generate/update every PDF in
//                                     ./assets immediately, no prompts.
//   npm run update <name.pdf>        Generate/update just that one PDF,
//                                     no prompt. <name.pdf> may be given
//                                     with or without the .pdf extension.
//
// Schemas are written to public/schemas/<pdf-basename>.json, plus a
// public/schemas/index.json manifest listing all available forms.
//
// See scripts/remove-schema.js (npm run remove) to delete a schema.
// `npm start` does not touch schemas at all - run generate/update first.

const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName } = require('pdf-lib');
const { ROOT, ASSETS_DIR, SCHEMAS_DIR, schemaPathFor, ask, writeManifest } = require('./lib/schema-store');
const {
  extractXfaTemplate,
  extractXfaDatasets,
  parseFieldTypes,
  extractTemplateVariables,
  findHiddenPageBarcodes,
  extractSectionPrefixes,
  extractExclGroupMembers,
} = require('./lib/xfa-template');
const { extractDocumentMetadata } = require('./lib/xmp-metadata');
const { buildXlsFileReferences } = require('./lib/xls-filenames');

function round(n) {
  return Math.round(n * 100) / 100;
}

// PDF coordinates are bottom-left origin; CSS is top-left origin.
function toCssBox(rect, pageHeight) {
  return {
    left: round(rect.x),
    top: round(pageHeight - rect.y - rect.height),
    width: round(rect.width),
    height: round(rect.height),
  };
}

// A description that starts with a section/box number - e.g. "6.6 Avdragen
// A-skatt" or "B1 Immateriella anläggningstillgångar" - carries that number
// ("ruta") as a distinct, useful piece of data. Not every field has one
// (plain labels like "Namn" or tooltips like "Ange med siffror..." don't).
function rutaFromDescription(description) {
  if (!description) return null;
  const match = description.match(/^([\p{L}]*\d+(?:[.,]\d+)*)\s/u);
  return match ? match[1] : null;
}

// The widget's own /TU entry - the PDF spec's "alternate description" for
// accessibility, i.e. the text a screen reader announces for this field.
// Independent of XFA (works on any AcroForm PDF); often mirrors the XFA
// tooltip, but sometimes it's the only description available, and
// sometimes it's just a placeholder falling back to the field's own name.
function screenReaderTextFor(widget) {
  try {
    const tu = widget.dict.get(PDFName.of('TU'));
    return tu ? tu.decodeText() : null;
  } catch {
    return null;
  }
}

function extractField(field, pageIndexByRef, xfaTypes, exclGroupMembers) {
  const type = field.constructor.name;
  const widget = field.acroField.getWidgets()[0];
  if (!widget) return null;

  const pageRef = widget.P();
  const pageIndex = pageRef ? pageIndexByRef.get(pageRef.tag) : undefined;
  if (pageIndex === undefined) return null;

  const rect = widget.getRectangle();
  const xfaInfo = xfaTypes.get(field.getName());
  const description = xfaInfo?.description ?? null;
  const base = {
    name: field.getName(),
    page: pageIndex,
    description,
    ruta: rutaFromDescription(description),
    picture: xfaInfo?.picture ?? null,
    valueType: xfaInfo?.valueType ?? null,
    fracDigits: xfaInfo?.fracDigits ?? null,
    leadDigits: xfaInfo?.leadDigits ?? null,
    vAlign: xfaInfo?.vAlign ?? null,
    locale: xfaInfo?.locale ?? null,
    designWidth: xfaInfo?.designWidth ?? null,
    designHeight: xfaInfo?.designHeight ?? null,
    rotate: xfaInfo?.rotate ?? null,
    access: xfaInfo?.access ?? null,
    font: widget.getDefaultAppearance() ?? null,
    screenReaderText: screenReaderTextFor(widget),
    rectPt: {
      llx: round(rect.x),
      lly: round(rect.y),
      urx: round(rect.x + rect.width),
      ury: round(rect.y + rect.height),
    },
  };

  if (type === 'PDFTextField') {
    const dataType = xfaInfo?.dataType || 'text';
    const align = xfaInfo?.align || (dataType === 'int' || dataType === 'float' ? 'right' : 'left');

    let value = '';
    try {
      // Throws for "rich text" fields with no plain-text value set -
      // pdf-lib can't decode those, but an unset value renders as empty
      // either way, so there's nothing to lose by treating it as ''.
      value = field.getText() ?? '';
    } catch {
      value = '';
    }

    return {
      ...base,
      type: 'text',
      dataType,
      align,
      multiline: field.isMultiline(),
      maxLength: field.getMaxLength() ?? null,
      value,
    };
  }

  if (type === 'PDFCheckBox') {
    return {
      ...base,
      type: 'checkbox',
      checked: field.isChecked(),
    };
  }

  if (type === 'PDFRadioGroup') {
    return {
      ...base,
      type: 'radio',
      options: field.getOptions(),
      selected: field.getSelected() ?? null,
      // The AcroForm layer flattens each XFA <exclGroup> into this single
      // radio field, and each option's own <field name="..."> is dropped
      // down to just its export ("on") value - see extractExclGroupMembers.
      // Recovered here (by full XFA SOM path, which is identical to this
      // field's own name) so each option's real field name/caption survive.
      members: exclGroupMembers.get(field.getName()) ?? null,
    };
  }

  if (type === 'PDFDropdown') {
    return {
      ...base,
      type: 'dropdown',
      options: field.getOptions(),
      selected: field.getSelected(),
    };
  }

  if (type === 'PDFOptionList') {
    return {
      ...base,
      type: 'listbox',
      options: field.getOptions(),
      selected: field.getSelected(),
    };
  }

  // Buttons/signatures aren't inputs a user fills in directly; skip them.
  return null;
}

async function buildSchema(pdfPath) {
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pdfPages = pdfDoc.getPages();

  const xfaTemplate = extractXfaTemplate(pdfDoc);
  const xfaDatasets = xfaTemplate ? extractXfaDatasets(pdfDoc) : null;
  const xfaTypes = xfaTemplate ? parseFieldTypes(xfaTemplate) : new Map();
  const exclGroupMembers = xfaTemplate ? extractExclGroupMembers(xfaTemplate) : new Map();
  const templateVariables = xfaTemplate ? extractTemplateVariables(xfaTemplate) : null;
  const documentMetadata = extractDocumentMetadata(pdfDoc);
  const document =
    documentMetadata || templateVariables ? { ...documentMetadata, ...templateVariables } : null;

  // Companion .xls reference filenames, derived from the same template
  // variables plus each section's barcode "titel" prefix (see
  // extractSectionPrefixes) - only when every required piece is present,
  // so a form missing one of these facts just omits this section rather
  // than guessing.
  const sectionPrefixes = xfaTemplate ? extractSectionPrefixes(xfaTemplate) : [];
  const xlsFileReferences =
    templateVariables?.myndighet &&
    templateVariables?.formularid &&
    templateVariables?.utgava &&
    templateVariables?.formularversion &&
    templateVariables?.konstruktionsdatum &&
    sectionPrefixes.length > 0
      ? buildXlsFileReferences(
          templateVariables.myndighet,
          templateVariables.formularid,
          templateVariables.utgava,
          templateVariables.formularversion,
          templateVariables.konstruktionsdatum,
          sectionPrefixes,
        )
      : null;

  const pageIndexByRef = new Map();
  pdfPages.forEach((page, index) => pageIndexByRef.set(page.ref.tag, index));

  const form = pdfDoc.getForm();

  // Each PDF page maps 1:1 to a top-level XFA page subform (e.g. "Sida1")
  // - every AcroForm field's fully-qualified name carries that subform as
  // its second dot-segment (after the root form), so any one field on a
  // page reveals that page's subform. Note some forms flow a single page
  // subform across multiple physical PDF pages (its content just spills
  // onto a second page) - in that case both pages correctly report the
  // same xfaSubform, which is an accurate reflection of the source, not a
  // bug.
  //
  // The hidden per-page barcode has no AcroForm widget/page of its own
  // (see findHiddenPageBarcodes), so its page can't be read off directly.
  // Instead, walk up its SOM path's ancestor containers (deepest first)
  // until one matches a container that a *real* field also lives in -
  // that real field's already-known page is then the barcode's page too.
  const pageIndexToSubformRaw = new Map();
  const containerToPage = new Map();
  for (const field of form.getFields()) {
    const widget = field.acroField.getWidgets()[0];
    if (!widget) continue;
    const pageRef = widget.P();
    const pageIdx = pageRef ? pageIndexByRef.get(pageRef.tag) : undefined;
    if (pageIdx === undefined) continue;

    const segments = field.getName().split('.');
    if (segments.length > 1 && !pageIndexToSubformRaw.has(pageIdx)) {
      pageIndexToSubformRaw.set(pageIdx, segments[1]);
    }
    for (let i = segments.length - 1; i >= 1; i--) {
      containerToPage.set(segments.slice(0, i).join('.'), pageIdx);
    }
  }

  function pageForPath(fullPath) {
    const segments = fullPath.split('.');
    for (let i = segments.length - 1; i >= 1; i--) {
      const prefix = segments.slice(0, i).join('.');
      if (containerToPage.has(prefix)) return containerToPage.get(prefix);
    }
    return null;
  }

  const hiddenBarcodeByPage = new Map();
  if (xfaTemplate) {
    const barcodes = findHiddenPageBarcodes(xfaTemplate, xfaDatasets, templateVariables?.utgava, pageForPath);
    for (const [barcodePath, value] of barcodes) {
      const pageIdx = pageForPath(barcodePath);
      if (pageIdx !== null && !hiddenBarcodeByPage.has(pageIdx)) {
        hiddenBarcodeByPage.set(pageIdx, value);
      }
    }
  }

  const pages = pdfPages.map((page, index) => {
    const rawSubform = pageIndexToSubformRaw.get(index) ?? null;
    return {
      index,
      width: round(page.getWidth()),
      height: round(page.getHeight()),
      xfaSubform: rawSubform ? rawSubform.replace(/\[\d+\]$/, '') : null,
      hiddenPageBarcode: hiddenBarcodeByPage.get(index) ?? null,
    };
  });

  const fields = form
    .getFields()
    .map((field) => {
      const meta = extractField(field, pageIndexByRef, xfaTypes, exclGroupMembers);
      if (!meta) return null;

      const widgets = field.acroField.getWidgets();
      const pageHeight = pages[meta.page].height;
      const boxes = widgets.map((w) => toCssBox(w.getRectangle(), pageHeight));

      // Fields normally have one widget (one on-page box). A handful of
      // radio groups may have several (one per option) - keep them all,
      // including each widget's own PDF-space rect (meta.rectPt, from
      // extractField, only ever reflects the group's first widget - not
      // useful once the sidebar reports per-option data instead of
      // group-wide data).
      if (boxes.length === 1) return { ...meta, box: boxes[0] };
      const rectPts = widgets.map((w) => {
        const r = w.getRectangle();
        return { llx: round(r.x), lly: round(r.y), urx: round(r.x + r.width), ury: round(r.y + r.height) };
      });
      return { ...meta, boxes, rectPts };
    })
    .filter(Boolean);

  return {
    source: path.relative(ROOT, pdfPath),
    file: path.basename(pdfPath),
    generatedAt: new Date().toISOString(),
    document,
    xlsFileReferences,
    pages,
    fields,
  };
}

async function generateForPdf(pdfPath) {
  const schema = await buildSchema(pdfPath);
  const outPath = schemaPathFor(pdfPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(schema, null, 2));
  console.log(
    `  -> ${schema.fields.length} fields across ${schema.pages.length} page(s), wrote ${path.relative(ROOT, outPath)}`,
  );
}

function listPdfFiles() {
  return fs
    .readdirSync(ASSETS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .map((f) => path.join(ASSETS_DIR, f));
}

function resolvePdfArg(target) {
  const base = path.basename(target);
  const candidates = [base, base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`];

  const files = fs.readdirSync(ASSETS_DIR);
  for (const candidate of candidates) {
    const match = files.find((f) => f.toLowerCase() === candidate.toLowerCase());
    if (match) return path.join(ASSETS_DIR, match);
  }

  throw new Error(
    `Could not find "${target}" in ${path.relative(ROOT, ASSETS_DIR)}. Available files:\n` +
      files.map((f) => `  - ${f}`).join('\n'),
  );
}

// Generates/updates every PDF immediately, no prompts. Used by
// `npm run update all`. One bad PDF is logged and skipped rather than
// aborting the rest (see the rich-text-field crash fix history).
async function generateAllForced(pdfFiles) {
  let hadFailure = false;

  for (const pdfPath of pdfFiles) {
    const name = path.basename(pdfPath);
    try {
      const existed = fs.existsSync(schemaPathFor(pdfPath));
      console.log(`${existed ? 'Updating' : 'Generating'} schema for ${name}...`);
      await generateForPdf(pdfPath);
    } catch (err) {
      hadFailure = true;
      console.error(`Failed to generate schema for ${name}: ${err.message}`);
    }
  }

  if (hadFailure) process.exitCode = 1;
}

async function main() {
  fs.mkdirSync(SCHEMAS_DIR, { recursive: true });
  const target = process.argv[2];

  if (target === 'all') {
    const pdfFiles = listPdfFiles();
    if (pdfFiles.length === 0) {
      console.log(`No PDFs found in ${path.relative(ROOT, ASSETS_DIR)}`);
      return;
    }
    await generateAllForced(pdfFiles);
  } else if (target) {
    const pdfPath = resolvePdfArg(target);
    const existed = fs.existsSync(schemaPathFor(pdfPath));
    console.log(`${existed ? 'Updating' : 'Generating'} schema for ${path.basename(pdfPath)}...`);
    await generateForPdf(pdfPath);
  } else {
    const pdfFiles = listPdfFiles();
    if (pdfFiles.length === 0) {
      console.log(`No PDFs found in ${path.relative(ROOT, ASSETS_DIR)}`);
      return;
    }

    let hadFailure = false;

    for (const pdfPath of pdfFiles) {
      const name = path.basename(pdfPath);
      const schemaExists = fs.existsSync(schemaPathFor(pdfPath));

      try {
        if (!schemaExists) {
          console.log(`Generating schema for new form: ${name}`);
          await generateForPdf(pdfPath);
          continue;
        }

        const answer = await ask(`Schema for "${name}" already exists. Update it? (y/N) `);
        if (answer === 'y' || answer === 'yes') {
          console.log(`Updating schema for ${name}...`);
          await generateForPdf(pdfPath);
        } else {
          console.log(`Skipped ${name}`);
        }
      } catch (err) {
        hadFailure = true;
        console.error(`Failed to generate schema for ${name}: ${err.message}`);
      }
    }

    if (hadFailure) process.exitCode = 1;
  }

  writeManifest();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
