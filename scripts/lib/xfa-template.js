// Reads type/alignment/description hints out of a PDF's embedded XFA form
// definition (LiveCycle/Acrobat forms carry this alongside the flattened
// AcroForm that pdf-lib's form API exposes). AcroForm alone has no concept
// of "this is a date", "this is a right-aligned amount", or "this field
// means B1 Immateriella anläggningstillgångar" - XFA does, via each
// field's <ui> element, <format><picture> clause, <para hAlign>/<vAlign>,
// and <assist><toolTip>.

const { PDFName, PDFArray, PDFDict, decodePDFRawStream } = require('pdf-lib');
const { decodeXmlEntities } = require('./xml-entities');

// Reads /AcroForm/XFA (an array of alternating packet-name/stream pairs)
// and returns the decoded XML of the named packet (default "(template)" -
// the form definition; "(datasets)" holds the actual bound data values),
// or null if there's no XFA data, no packet with that name, or anything
// about the structure is unexpected.
function extractXfaPacket(pdfDoc, packetName = '(template)') {
  try {
    const acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    const xfaEntry = acroForm.get(PDFName.of('XFA'));
    if (!xfaEntry) return null;

    const xfaArr = pdfDoc.context.lookup(xfaEntry, PDFArray);
    for (let i = 0; i < xfaArr.size(); i += 2) {
      if (xfaArr.lookup(i).toString() !== packetName) continue;
      const stream = pdfDoc.context.lookup(xfaArr.get(i + 1));
      const bytes = decodePDFRawStream(stream).decode();
      return Buffer.from(bytes).toString('utf8');
    }
  } catch {
    return null;
  }
  return null;
}

function extractXfaTemplate(pdfDoc) {
  return extractXfaPacket(pdfDoc, '(template)');
}

function extractXfaDatasets(pdfDoc) {
  return extractXfaPacket(pdfDoc, '(datasets)');
}

function attr(tagText, attrName) {
  const match = tagText.match(new RegExp(`\\b${attrName}="([^"]*)"`));
  return match ? match[1] : null;
}

const TAG_RE = /<[^>]+>/g;
const CONTAINER_ELEMENTS = new Set(['subform', 'exclGroup']);

// A field's XFA *short* name (e.g. "numBelopp") is not unique on its own:
// repeating line-item forms reuse the same field/subform names once per
// row (one PDF here has 61 fields all named "numBelopp"). What's unique
// is the fully-qualified, dot-separated, bracket-indexed path - the exact
// same "SOM path" format AcroForm already uses for field.getName(), e.g.
// "BlankettExternFormular[0].Sida1[0]....subPunkt6Rad6[0].numBelopp[0]".
// An <exclGroup> (radio button group) gets a path the same way a subform
// does, and that path exactly matches the AcroForm radio field it
// flattens to - confirmed against several PDFs' actual field.getName().
//
// This walks the template's tag stream (a lightweight tokenizer, not a
// full XML parser - sufficient because this XML is machine-generated and
// well-formed) tracking <subform>/<exclGroup> nesting and counting
// same-named siblings at each level, to compute that path per <field> and
// capture its opening tag (attributes) and body. It also records, per
// <exclGroup>, the paths of its direct <field> children (in document
// order) - AcroForm flattens each exclGroup option's own XFA field into
// just an unnamed widget/kid, dropping its name/caption entirely, so
// that's otherwise nowhere else to recover it from (see
// extractExclGroupMembers below).
//
// Returns { fields: Map<path, {tagAttrs, body}>, exclGroupChildren: Map<exclGroupPath, path[]> }.
function buildFieldBodiesByPath(xml) {
  const stack = [{ path: '', type: null, counts: new Map() }];
  const fields = new Map(); // path -> { tagAttrs, body }
  const exclGroupChildren = new Map(); // exclGroupPath -> [childFieldPath, ...]
  let openField = null; // { path, tagAttrs, bodyStart, parentFrame }

  function childPath(frame, name) {
    const index = frame.counts.get(name) || 0;
    frame.counts.set(name, index + 1);
    const segment = `${name}[${index}]`;
    return frame.path ? `${frame.path}.${segment}` : segment;
  }

  function recordField(path, parentFrame) {
    if (parentFrame.type === 'exclGroup') {
      if (!exclGroupChildren.has(parentFrame.path)) exclGroupChildren.set(parentFrame.path, []);
      exclGroupChildren.get(parentFrame.path).push(path);
    }
  }

  let match;
  while ((match = TAG_RE.exec(xml))) {
    const tag = match[0];
    if (tag.startsWith('<?') || tag.startsWith('<!--')) continue;

    const isClosing = tag.startsWith('</');
    const isSelfClosing = /\/>$/.test(tag);
    const nameMatch = tag.match(/^<\/?\s*([\w:-]+)/);
    const elName = nameMatch ? nameMatch[1] : null;

    if (isClosing) {
      if (elName === 'field' && openField) {
        fields.set(openField.path, { tagAttrs: openField.tagAttrs, body: xml.slice(openField.bodyStart, match.index) });
        recordField(openField.path, openField.parentFrame);
        openField = null;
      } else if (CONTAINER_ELEMENTS.has(elName)) {
        stack.pop();
      }
      continue;
    }

    const frame = stack[stack.length - 1];

    if (elName === 'field') {
      const path = childPath(frame, attr(tag, 'name') || '');
      if (isSelfClosing) {
        fields.set(path, { tagAttrs: tag, body: '' });
        recordField(path, frame);
      } else {
        openField = { path, tagAttrs: tag, bodyStart: match.index + tag.length, parentFrame: frame };
      }
    } else if (CONTAINER_ELEMENTS.has(elName)) {
      const path = childPath(frame, attr(tag, 'name') || '');
      if (!isSelfClosing) stack.push({ path, type: elName, counts: new Map() });
    }
  }

  return { fields, exclGroupChildren };
}

// Returns Map<fullyQualifiedPath, {
//   dataType: 'date'|'int'|'float'|'text'|null,
//   align: 'left'|'center'|'right'|'justify'|null,
//   vAlign: 'top'|'middle'|'bottom'|null,
//   description: string|null,       // <assist><toolTip>
//   picture: string|null,           // raw <format><picture>, e.g. "num{zzzzzzzzzzzz9}"
//   valueType: string|null,         // <value>'s child element name, e.g. "decimal"/"date"
//   fracDigits: number|null,        // <value><decimal fracDigits="...">
//   leadDigits: number|null,        // <value><decimal leadDigits="...">
//   locale: string|null,
//   designWidth: string|null,       // the field's own w="..." (XFA design size, e.g. "27.94mm")
//   designHeight: string|null,      // the field's own h="..."
//   rotate: string|null,
//   access: string|null,            // e.g. "readOnly"/"protected"/"nonInteractive"
// }>
// fullyQualifiedPath matches AcroForm's field.getName() exactly, so
// callers should look fields up by that, not by short name.
function parseFieldTypes(xml) {
  const map = new Map();
  const { fields: fieldsByPath } = buildFieldBodiesByPath(xml);

  for (const [path, { tagAttrs, body }] of fieldsByPath) {
    const uiMatch = body.match(/<ui[^>]*>\s*<(\w+)/);
    const ui = uiMatch ? uiMatch[1] : null;

    const formatMatch = body.match(/<format[^>]*>([\s\S]*?)<\/format/);
    const pictureMatch = formatMatch && formatMatch[1].match(/<picture[^>]*>([^<]*)<\/picture/);
    const picture = pictureMatch ? pictureMatch[1].trim() : null;

    const alignMatch = body.match(/<para[^>]*\bhAlign="(left|center|right|justify)"/);
    const align = alignMatch ? alignMatch[1] : null;

    const vAlignMatch = body.match(/<para[^>]*\bvAlign="(top|middle|bottom)"/);
    const vAlign = vAlignMatch ? vAlignMatch[1] : null;

    const toolTipMatch = body.match(/<toolTip[^>]*>([^<]*)<\/toolTip/);
    const description = toolTipMatch ? decodeXmlEntities(toolTipMatch[1].trim()) : null;

    const locale = attr(tagAttrs, 'locale');
    const designWidth = attr(tagAttrs, 'w');
    const designHeight = attr(tagAttrs, 'h');
    const rotate = attr(tagAttrs, 'rotate');
    const access = attr(tagAttrs, 'access');

    const valueMatch = body.match(/<value[^>]*>\s*<(\w+)([^>]*)\/?>/);
    const valueType = valueMatch ? valueMatch[1] : null;
    const fracDigits = valueType === 'decimal' && attr(valueMatch[2], 'fracDigits') !== null
      ? Number(attr(valueMatch[2], 'fracDigits'))
      : null;
    const leadDigits = valueType === 'decimal' && attr(valueMatch[2], 'leadDigits') !== null
      ? Number(attr(valueMatch[2], 'leadDigits'))
      : null;

    let dataType = null;
    if (ui === 'dateTimeEdit') {
      dataType = 'date';
    } else if (ui === 'numericEdit') {
      dataType = picture && !picture.includes('.') ? 'int' : 'float';
    } else if (ui === 'textEdit') {
      dataType = 'text';
    }

    const info = {
      dataType, align, vAlign, description, picture, valueType, fracDigits, leadDigits,
      locale, designWidth, designHeight, rotate, access,
    };
    if (Object.values(info).some((v) => v !== null)) map.set(path, info);
  }

  return map;
}

// The template's single <variables> block (present once, near the
// document root - not per field) holds LiveCycle's own authoring/
// versioning facts: form title(s), issuing agency, form ID, edition,
// form version, design date, etc. This is a third, independent metadata
// source alongside AcroForm and XMP - internal to how the form was built
// in Designer, rather than PDF- or accessibility-level metadata.
const TEMPLATE_VARIABLE_NAMES = [
  'rubrik1',
  'rubrik2',
  'myndighet',
  'formularid',
  'utgava',
  'formularversion',
  'konstruktionsdatum',
];

function extractTemplateVariables(xml) {
  const block = xml.match(/<variables[^>]*>([\s\S]*?)<\/variables/);
  if (!block) return null;

  const result = {};
  let any = false;
  for (const name of TEMPLATE_VARIABLE_NAMES) {
    const match = block[1].match(new RegExp(`<text name="${name}"[^>]*>([^<]*)<\\/text`));
    result[name] = match ? decodeXmlEntities(match[1].trim()) : null;
    if (result[name]) any = true;
  }
  return any ? result : null;
}

// The tax-period-end month determines a "P1"-"P4" filing period code, per a
// business rule I found reused verbatim (identical script text) across
// every barcode-computing form checked: month 1-4 -> P1, 5-6 -> P2,
// 7-8 -> P3, 9-12 -> P4.
function periodCodeForMonth(month) {
  if (month >= 1 && month <= 4) return 'P1';
  if (month >= 5 && month <= 6) return 'P2';
  if (month >= 7 && month <= 8) return 'P3';
  if (month >= 9 && month <= 12) return 'P4';
  return null;
}

// The "T.o.m." (period end) date barcodes read via a field named "datTom"
// isn't a design-time default - it's bound to actual data (<bind
// match="dataRef" ref="$.Some.Path.DatKod"/>), so its real value lives in
// the XFA "datasets" packet, not the template. Finds the first "datTom"
// field's bind target and looks up that same tag in datasets.
function findDatTomValue(templateXml, datasetsXml) {
  if (!datasetsXml) return null;
  const bindMatch = templateXml.match(/<field name="datTom"[\s\S]*?<bind match="dataRef" ref="\$\.[^"]*\.(\w+)"/);
  if (!bindMatch) return null;
  const tag = bindMatch[1];
  const valueMatch = datasetsXml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}`));
  return valueMatch ? valueMatch[1].trim() : null;
}

// Some pages carry a per-page tracking barcode (XFA <ui><barcode>) that's
// marked non-interactive at runtime (the field's own initialize script sets
// `this.access = "nonInteractive"`), so it never becomes a real, editable
// AcroForm field - it's baked into the page's printed content instead (e.g.
// the "NEM-1-13-2025P4" code visible near a page's barcode image). Since it
// has no AcroForm widget, it's otherwise invisible to this whole pipeline,
// and has no page index of its own - the caller has to work that out (see
// extract-form.js, which matches each barcode's SOM path against real
// fields' paths to find which page shares its deepest container).
//
// Every barcode field observed computes its value the same way, via an
// "initialize" script: `titel + "-" + sidNr + "-" + utgava.value + "-" +
// ar + Period.rawValue` where `ar` is the first 4 digits of the bound
// "datTom" date and Period is that date's P1-P4 filing code (see above).
// `titel`/`sidNr` are usually literals in the barcode's own script
// (`var titel = "X"` or `titel.rawValue = "X"`); some forms compute
// `sidNr` at render time instead via `xfa.layout.page(this)` (the field's
// own page number) - `resolvePageForPath` (the same page-matching a
// caller already does for the barcode itself) supplies that when needed.
// `utgava` comes from the template's <variables> block
// (extractTemplateVariables). Reconstructs the value when every piece is
// present and the script resembles this pattern; otherwise falls back to
// just the field's name, so callers always get *something* rather than a
// wrong guess.
//
// Returns Map<fullyQualifiedPath, string> (a computed value like
// "INK2M-1-33-2025P4", or the bare field name as a fallback).
function findHiddenPageBarcodes(xml, datasetsXml, utgava, resolvePageForPath) {
  const map = new Map();
  const { fields: fieldsByPath } = buildFieldBodiesByPath(xml);
  const datTomValue = findDatTomValue(xml, datasetsXml);

  for (const [path, { body }] of fieldsByPath) {
    const uiMatch = body.match(/<ui[^>]*>\s*<(\w+)/);
    if (!uiMatch || uiMatch[1] !== 'barcode') continue;

    const fieldName = path.split('.').pop().replace(/\[\d+\]$/, '');

    const titelMatch = body.match(/(?:var\s+titel|titel\.rawValue)\s*=\s*"([^"]*)"/);
    const sidNrMatch = body.match(/(?:var\s+sidNr|sidNr\.rawValue)\s*=\s*"([^"]*)"/);
    const usesPageLayout = /xfa\.layout\.page\(this\)/.test(body);
    const usesExpectedFormula = /\bdatTom\b/.test(body) && /\bPeriod\b/.test(body);

    let sidNr = sidNrMatch ? sidNrMatch[1] : null;
    if (!sidNr && usesPageLayout && resolvePageForPath) {
      const pageIdx = resolvePageForPath(path);
      if (pageIdx !== null && pageIdx !== undefined) sidNr = String(pageIdx + 1);
    }

    const dateMatch = datTomValue && /^(\d{4})-(\d{2})-\d{2}$/.exec(datTomValue);
    const period = dateMatch ? periodCodeForMonth(Number(dateMatch[2])) : null;

    const value =
      titelMatch && sidNr && usesExpectedFormula && utgava && dateMatch && period
        ? `${titelMatch[1]}-${sidNr}-${utgava}-${dateMatch[1]}${period}`
        : fieldName;

    map.set(path, value);
  }

  return map;
}

// Each barcode field's script sets a "titel" literal identifying which
// logical section of the form it belongs to - always suffixed with "M"
// (e.g. "INK2M" for the main SKV 2002 form, "INK2RM" for its repeating
// appendix, "INK2SM" for its specification appendix). Collecting the
// distinct titel values, in the order their fields first appear in the
// template, and stripping that suffix gives the form's section prefixes -
// e.g. ["INK2", "INK2R", "INK2S"] for SKV 2002. Used to derive companion
// .xls filenames (see xls-filenames.js) without hardcoding them per form.
function extractSectionPrefixes(xml) {
  const { fields: fieldsByPath } = buildFieldBodiesByPath(xml);
  const sections = [];
  const seen = new Set();

  for (const [, { body }] of fieldsByPath) {
    const uiMatch = body.match(/<ui[^>]*>\s*<(\w+)/);
    if (!uiMatch || uiMatch[1] !== 'barcode') continue;

    const titelMatch = body.match(/(?:var\s+titel|titel\.rawValue)\s*=\s*"([^"]*)"/);
    if (!titelMatch) continue;

    const section = titelMatch[1].replace(/M$/, '');
    if (!seen.has(section)) {
      seen.add(section);
      sections.push(section);
    }
  }

  return sections;
}

// AcroForm flattens each XFA <exclGroup> (radio button group) into a
// single AcroForm radio field, and each option's own <field> inside that
// group becomes just an unnamed widget/kid, identified only by its export
// ("on") value - the option's own field name, caption (visible label),
// and the fact it even had a name at all is dropped at the AcroForm layer
// and doesn't appear anywhere in the standard field tree. This walks the
// exclGroup's direct <field> children (found via buildFieldBodiesByPath)
// and pulls, per option:
//   - name: the field's own short XFA name (e.g. "Ksr4103" - note this
//     is sometimes identical across every option in the same group, in
//     which case it genuinely doesn't disambiguate them; report it as-is
//     rather than inventing a fake unique name)
//   - caption: <caption><value><text> (visible label, e.g.
//     "Jag har ägt bostaden med samma ägarförhållanden som år 2024.")
//   - exportValue: <items>'s value - seen as either <items><text> or
//     <items><integer> in the wild, so both are accepted
//
// Returns Map<exclGroupPath, Array<{ name, caption, exportValue }>> -
// exclGroupPath is computed the same way as any field/subform path, and
// matches the flattened AcroForm radio field's own field.getName().
function extractExclGroupMembers(xml) {
  const { fields: fieldsByPath, exclGroupChildren } = buildFieldBodiesByPath(xml);
  const result = new Map();

  for (const [exclGroupPath, childPaths] of exclGroupChildren) {
    const members = childPaths.map((childPath) => {
      const { body } = fieldsByPath.get(childPath) || { body: '' };

      const captionBlock = body.match(/<caption[^>]*>([\s\S]*?)<\/caption/);
      const captionMatch = captionBlock && captionBlock[1].match(/<value[^>]*>[\s\S]*?<text[^>]*>([^<]*)<\/text/);
      const caption = captionMatch ? decodeXmlEntities(captionMatch[1].trim()) : null;

      const itemsBlock = body.match(/<items[^>]*>([\s\S]*?)<\/items/);
      const itemsMatch = itemsBlock && itemsBlock[1].match(/<(?:text|integer)[^>]*>([^<]*)<\/(?:text|integer)/);
      const exportValue = itemsMatch ? itemsMatch[1].trim() : null;

      return { name: childPath.split('.').pop().replace(/\[\d+\]$/, ''), caption, exportValue };
    });

    result.set(exclGroupPath, members);
  }

  return result;
}

module.exports = {
  extractXfaTemplate,
  extractXfaDatasets,
  parseFieldTypes,
  extractTemplateVariables,
  findHiddenPageBarcodes,
  extractSectionPrefixes,
  extractExclGroupMembers,
};
