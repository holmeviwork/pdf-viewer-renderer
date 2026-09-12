// Renders each PDF page onto a canvas via pdf.js, then overlays real HTML
// form fields positioned from a schema in public/schemas/ (produced by
// scripts/extract-form.js) so they line up with the original PDF layout.
// public/schemas/index.json lists every available form.

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

const RENDER_SCALE = 1.5; // upscale for crisper canvas rendering

const statusEl = document.getElementById('status');
const pagesEl = document.getElementById('pages');
const pickerLabel = document.getElementById('picker-label');
const picker = document.getElementById('form-picker');
const fieldInfoTitle = document.getElementById('field-info-title');
const fieldInfoContent = document.getElementById('field-info-content');

let currentSchema = null;

async function main() {
  const manifest = await fetch('/schemas/index.json').then((r) => r.json());
  if (manifest.length === 0) {
    statusEl.textContent = 'No form schemas found. Run "npm run generate" first.';
    return;
  }

  if (manifest.length > 1) {
    pickerLabel.hidden = false;
    for (const entry of manifest) {
      const opt = document.createElement('option');
      opt.value = entry.schema;
      opt.textContent = entry.file;
      picker.appendChild(opt);
    }
    picker.addEventListener('change', () => {
      setFormParam(picker.value);
      loadSchema(picker.value);
    });
  }

  const requested = new URLSearchParams(location.search).get('form');
  const initial = manifest.find((e) => e.schema === requested) || manifest[0];
  picker.value = initial.schema;
  await loadSchema(initial.schema);
}

function setFormParam(schemaFile) {
  const params = new URLSearchParams(location.search);
  params.set('form', schemaFile);
  history.replaceState(null, '', `${location.pathname}?${params}`);
}

async function loadSchema(schemaFile) {
  pagesEl.innerHTML = '';
  statusEl.textContent = 'Loading…';

  const schema = await fetch(`/schemas/${schemaFile}`).then((r) => r.json());
  currentSchema = schema;
  showGeneralInfo();

  const pdf = await pdfjsLib.getDocument(`/assets/${schema.file}`).promise;

  const fieldsByPage = new Map();
  for (const field of schema.fields) {
    if (!fieldsByPage.has(field.page)) fieldsByPage.set(field.page, []);
    fieldsByPage.get(field.page).push(field);
  }

  for (const pageInfo of schema.pages) {
    const page = await pdf.getPage(pageInfo.index + 1); // pdf.js is 1-indexed
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.style.width = `${viewport.width}px`;
    pageEl.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pageEl.appendChild(canvas);

    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    // Overlay the real, selectable/searchable text on top of the canvas
    // pixels so users can select/copy text and use browser find (Cmd+F).
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    pageEl.style.setProperty('--scale-factor', RENDER_SCALE);
    pageEl.appendChild(textLayerDiv);

    const textContent = await page.getTextContent();
    await pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
    }).promise;

    const scaleX = viewport.width / pageInfo.width;
    const scaleY = viewport.height / pageInfo.height;

    for (const field of fieldsByPage.get(pageInfo.index) || []) {
      pageEl.appendChild(createFieldElement(field, scaleX, scaleY));
    }

    pagesEl.appendChild(pageEl);
  }

  statusEl.textContent = `${schema.fields.length} fields across ${schema.pages.length} page(s) — loaded from ${schema.file}`;
}

// One sanitizer per dataType: takes the input's current raw value and
// returns the closest valid value. Applied live on the "input" event.
const SANITIZERS = {
  // leadDigits (from the PDF's XFA <value><decimal leadDigits="N">) caps
  // how many digits are allowed before the decimal point - e.g. some
  // fields are deliberately just one digit wide.
  int(raw, leadDigits) {
    const negative = raw.startsWith('-');
    let digits = raw.replace(/[^0-9]/g, '');
    if (leadDigits) digits = digits.slice(0, leadDigits);
    return (negative ? '-' : '') + digits;
  },
  float(raw, leadDigits) {
    const negative = raw.startsWith('-');
    let rest = raw.slice(negative ? 1 : 0).replace(/\./g, ',');
    rest = rest.replace(/[^0-9,]/g, '');
    const firstComma = rest.indexOf(',');
    if (firstComma !== -1) {
      let intPart = rest.slice(0, firstComma);
      const fracPart = rest.slice(firstComma + 1).replace(/,/g, '');
      if (leadDigits) intPart = intPart.slice(0, leadDigits);
      rest = `${intPart},${fracPart}`;
    } else if (leadDigits) {
      rest = rest.slice(0, leadDigits);
    }
    return (negative ? '-' : '') + rest;
  },
  // Unicode letters/digits/spaces plus everyday name/address punctuation;
  // blocks symbols like < > { } @ # $ etc.
  text(raw) {
    return raw.replace(/[^\p{L}\p{N}\s\-.,/&'()]/gu, '');
  },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Every piece of data extracted from the PDF for one field, as
// label/value pairs, in display order. Anything null/undefined/empty is
// left out so the panel only shows what's actually known.
function describeField(field) {
  const box = field.box || (field.boxes && field.boxes[0]);
  const pairs = [
    ['Description', field.description],
    ['Ruta', field.ruta],
    ['Field name', field.name],
    ['Type', field.type],
    ['Data type', field.dataType],
    ['Value type', field.valueType],
    ['Fraction digits', field.fracDigits],
    ['Lead digits', field.leadDigits],
    ['Format picture', field.picture],
    ['Font', field.font],
    ['Alignment', field.align],
    ['Vertical alignment', field.vAlign],
    ['Locale', field.locale],
    ['Rotation', field.rotate],
    ['Access', field.access],
    ['Page', Number.isInteger(field.page) ? field.page + 1 : null],
    ['Value', field.value],
    ['Checked', field.type === 'checkbox' ? String(Boolean(field.checked)) : null],
    ['Selected', field.selected ? [].concat(field.selected).join(', ') : null],
    ['Options', field.options && field.options.length ? field.options.join(', ') : null],
    ['Max length', field.maxLength],
    ['Multiline', field.type === 'text' ? String(Boolean(field.multiline)) : null],
    ['Position', box && `${box.left}, ${box.top} pt`],
    ['Size', box && `${box.width} × ${box.height} pt`],
    ['Design size', field.designWidth && field.designHeight && `${field.designWidth} × ${field.designHeight}`],
    ['PDF rect', field.rectPt && `${field.rectPt.llx}, ${field.rectPt.lly}, ${field.rectPt.urx}, ${field.rectPt.ury}`],
  ];

  return pairs;
}

// Renders label/value pairs as <dt>/<dd> rows, skipping anything
// null/undefined/empty so the panel only shows what's actually known.
function renderPairs(pairs) {
  fieldInfoContent.innerHTML = '';
  for (const [label, value] of pairs) {
    if (value === null || value === undefined || value === '') continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    fieldInfoContent.append(dt, dd);
  }
}

function showFieldInfo(field) {
  fieldInfoTitle.textContent = 'Field data';
  renderPairs(describeField(field));
}

// Shown whenever no field has focus: general facts about the loaded PDF
// itself, so the sidebar always has something useful to show.
function showGeneralInfo() {
  if (!currentSchema) return;
  const doc = currentSchema.document || {};
  fieldInfoTitle.textContent = currentSchema.file;
  renderPairs([
    ['Title', doc.title],
    ['Creator', doc.creator],
    ['Creator tool', doc.creatorTool],
    ['Producer', doc.producer],
    ['Document ID', doc.documentId],
    ['Instance ID', doc.instanceId],
    ['Created', doc.created],
    ['Issued', doc.issued],
    ['Metadata date', doc.metadataDate],
    ['Template version', doc.templateVersionRef],
    ['Source', currentSchema.source],
    ['Pages', currentSchema.pages.length],
    ['Fields', currentSchema.fields.length],
    ['Generated at', new Date(currentSchema.generatedAt).toLocaleString()],
  ]);
}

function createFieldElement(field, scaleX, scaleY) {
  const box = field.box || (field.boxes && field.boxes[0]);
  let el;

  if (field.type === 'checkbox') {
    el = document.createElement('input');
    el.type = 'checkbox';
    el.checked = Boolean(field.checked);
  } else if (field.type === 'dropdown' || field.type === 'listbox') {
    el = document.createElement('select');
    if (field.type === 'listbox') el.multiple = true;
    for (const option of field.options || []) {
      const opt = document.createElement('option');
      opt.value = option;
      opt.textContent = option;
      el.appendChild(opt);
    }
  } else if (field.multiline) {
    el = document.createElement('textarea');
    el.value = field.value || '';
  } else {
    el = document.createElement('input');
    el.value = field.value || '';
    if (field.maxLength) el.maxLength = field.maxLength;

    if (field.dataType === 'date') {
      el.type = 'date';
      if (DATE_RE.test(field.value)) el.value = field.value;
    } else {
      el.type = 'text';
      const sanitize = SANITIZERS[field.dataType] || SANITIZERS.text;
      if (field.dataType === 'int') el.inputMode = 'numeric';
      if (field.dataType === 'float') el.inputMode = 'decimal';
      el.addEventListener('input', () => {
        const sanitized = sanitize(el.value, field.leadDigits);
        if (sanitized !== el.value) el.value = sanitized;
      });
    }

    el.style.textAlign = field.align || 'left';
  }

  el.className = 'field';
  el.title = field.name;
  el.style.left = `${box.left * scaleX}px`;
  el.style.top = `${box.top * scaleY}px`;
  el.style.width = `${box.width * scaleX}px`;
  el.style.height = `${box.height * scaleY}px`;

  el.addEventListener('focus', () => showFieldInfo(field));
  el.addEventListener('blur', showGeneralInfo);

  return el;
}

main().catch((err) => {
  console.error(err);
  statusEl.textContent = `Failed to load: ${err.message}`;
});
