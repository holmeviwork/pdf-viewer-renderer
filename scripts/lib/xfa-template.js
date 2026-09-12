// Reads type/alignment/description hints out of a PDF's embedded XFA form
// definition (LiveCycle/Acrobat forms carry this alongside the flattened
// AcroForm that pdf-lib's form API exposes). AcroForm alone has no concept
// of "this is a date", "this is a right-aligned amount", or "this field
// means B1 Immateriella anläggningstillgångar" - XFA does, via each
// field's <ui> element, <format><picture> clause, <para hAlign>/<vAlign>,
// and <assist><toolTip>.

const { PDFName, PDFArray, PDFDict, decodePDFRawStream } = require('pdf-lib');

// Reads /AcroForm/XFA (an array of alternating packet-name/stream pairs)
// and returns the decoded "template" packet's XML, or null if there's no
// XFA data, no template packet, or anything about the structure is
// unexpected.
function extractXfaTemplate(pdfDoc) {
  try {
    const acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    const xfaEntry = acroForm.get(PDFName.of('XFA'));
    if (!xfaEntry) return null;

    const xfaArr = pdfDoc.context.lookup(xfaEntry, PDFArray);
    for (let i = 0; i < xfaArr.size(); i += 2) {
      if (xfaArr.lookup(i).toString() !== '(template)') continue;
      const stream = pdfDoc.context.lookup(xfaArr.get(i + 1));
      const bytes = decodePDFRawStream(stream).decode();
      return Buffer.from(bytes).toString('utf8');
    }
  } catch {
    return null;
  }
  return null;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXmlEntities(str) {
  return str.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name]);
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
//
// This walks the template's tag stream (a lightweight tokenizer, not a
// full XML parser - sufficient because this XML is machine-generated and
// well-formed) tracking <subform>/<exclGroup> nesting and counting
// same-named siblings at each level, to compute that path per <field> and
// capture its opening tag (attributes) and body.
function buildFieldBodiesByPath(xml) {
  const stack = [{ path: '', counts: new Map() }];
  const fields = new Map(); // path -> { tagAttrs, body }
  let openField = null; // { path, tagAttrs, bodyStart }

  function childPath(frame, name) {
    const index = frame.counts.get(name) || 0;
    frame.counts.set(name, index + 1);
    const segment = `${name}[${index}]`;
    return frame.path ? `${frame.path}.${segment}` : segment;
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
      } else {
        openField = { path, tagAttrs: tag, bodyStart: match.index + tag.length };
      }
    } else if (CONTAINER_ELEMENTS.has(elName)) {
      const path = childPath(frame, attr(tag, 'name') || '');
      if (!isSelfClosing) stack.push({ path, counts: new Map() });
    }
  }

  return fields;
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
  const fieldsByPath = buildFieldBodiesByPath(xml);

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

module.exports = { extractXfaTemplate, parseFieldTypes };
