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
let activeFieldEl = null; // the field the sidebar is currently showing, if any

// Which field's data the sidebar shows is tracked as our own JS state
// (the `.active` class + activeFieldEl) rather than driven by native
// focus/blur: clicking into the sidebar to select/copy text blurs the
// input (mousedown on any non-focusable element blurs whatever currently
// has focus), and blur only fires once per focus/blur transition - if we
// reacted to that blur, the field would be stuck "stale" afterward with
// no further blur event ever left to fire. Instead, a single
// document-level mousedown listener decides when to revert to the
// general-info view: anywhere that isn't the sidebar and isn't a field
// counts as a real "click away".
document.addEventListener('mousedown', (event) => {
  if (!activeFieldEl) return;
  if (event.target.closest('#field-info') || event.target.closest('.field')) return;
  activeFieldEl.classList.remove('active');
  activeFieldEl = null;
  showGeneralInfo();
});

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
  activeFieldEl = null;

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
      for (const el of createFieldElement(field, scaleX, scaleY)) {
        pageEl.appendChild(el);
      }
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

// The field's own short name, e.g. "numBelopp[0]" - the last segment of
// its fully-qualified, dot-separated AcroForm name (e.g.
// "BlankettExternFormular[0].Sida1[0]....numBelopp[0]").
function shortNameOf(fullName) {
  return fullName.split('.').pop();
}

// Every piece of data extracted from the PDF for one field, as
// label/value pairs, in display order. Anything null/undefined/empty is
// left out so the panel only shows what's actually known.
//
// `optionIndex` is given for one on-page box of a radio group (each radio
// button is its own widget, not the group as a whole) - in that case the
// identity/value rows describe that specific button (its own recovered
// XFA field name/caption from field.members, its own export value, and
// whether *it* is the checked one) instead of the group-wide field.name/
// options/selected, which would be identical no matter which button in
// the group was actually focused.
function describeField(field, optionIndex) {
  const isOption = field.type === 'radio' && optionIndex != null;
  const box = isOption ? field.boxes?.[optionIndex] : field.box || (field.boxes && field.boxes[0]);
  const rectPt = isOption ? field.rectPts?.[optionIndex] : field.rectPt;
  const member = isOption ? field.members?.[optionIndex] : null;
  const optionValue = isOption ? field.options?.[optionIndex] : null;

  const pairs = [
    ['Description (screen reader text)', field.description],
    ['Ruta', field.ruta],
    ['Caption', member?.caption],
    ['Field name', member?.name || shortNameOf(field.name)],
    ['Fully qualified name', field.name],
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
    ['Export value', isOption ? optionValue : null],
    [
      'Checked',
      field.type === 'checkbox'
        ? String(Boolean(field.checked))
        : isOption
          ? String(field.selected === optionValue)
          : null,
    ],
    ['Selected', !isOption && field.selected ? [].concat(field.selected).join(', ') : null],
    ['Options', !isOption && field.options && field.options.length ? field.options.join(', ') : null],
    ['Max length', field.maxLength],
    ['Multiline', field.type === 'text' ? String(Boolean(field.multiline)) : null],
    ['Position', box && `${box.left}, ${box.top} pt`],
    ['Size', box && `${box.width} × ${box.height} pt`],
    ['Design size', field.designWidth && field.designHeight && `${field.designWidth} × ${field.designHeight}`],
    ['PDF rect', rectPt && `${rectPt.llx}, ${rectPt.lly}, ${rectPt.urx}, ${rectPt.ury}`],
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

function showFieldInfo(field, optionIndex) {
  fieldInfoTitle.textContent = 'Field data';
  renderPairs(describeField(field, optionIndex));
}

// Shown whenever no field has focus: general facts about the loaded PDF
// itself, so the sidebar always has something useful to show.
function showGeneralInfo() {
  if (!currentSchema) return;
  const doc = currentSchema.document || {};
  fieldInfoTitle.textContent = currentSchema.file;
  renderPairs([
    ['Title', doc.title],
    ['Rubrik 1', doc.rubrik1],
    ['Rubrik 2', doc.rubrik2],
    ['Creator', doc.creator],
    ['Creator tool', doc.creatorTool],
    ['Producer', doc.producer],
    ['Document ID', doc.documentId],
    ['Instance ID', doc.instanceId],
    ['Created', doc.created],
    ['Issued', doc.issued],
    ['Metadata date', doc.metadataDate],
    ['Template version', doc.templateVersionRef],
    ['Myndighet', doc.myndighet],
    ['Formulär-ID', doc.formularid],
    ['Utgåva', doc.utgava],
    ['Formulärversion', doc.formularversion],
    ['Konstruktionsdatum (design date)', doc.konstruktionsdatum],
    ['Source', currentSchema.source],
    ['Pages', currentSchema.pages.length],
    ['Fields', currentSchema.fields.length],
    ['Generated at', new Date(currentSchema.generatedAt).toLocaleString()],
  ]);
}

// Positions, styles, and wires up the focus->sidebar behavior for one
// on-page box - shared by every field type so that logic only lives once.
// `optionIndex` identifies which box of a radio group this is (see
// describeField), so the sidebar reports that specific button rather than
// the group as a whole; other field types only ever have one box, so it's
// omitted for them.
function positionAndWire(el, field, box, scaleX, scaleY, optionIndex) {
  el.className = 'field';
  const member = optionIndex != null ? field.members?.[optionIndex] : null;
  el.title = member ? `${member.name}: ${member.caption || member.exportValue}` : field.name;
  el.style.left = `${box.left * scaleX}px`;
  el.style.top = `${box.top * scaleY}px`;
  el.style.width = `${box.width * scaleX}px`;
  el.style.height = `${box.height * scaleY}px`;

  el.addEventListener('focus', () => {
    if (activeFieldEl) activeFieldEl.classList.remove('active');
    activeFieldEl = el;
    el.classList.add('active');
    showFieldInfo(field, optionIndex);
  });

  return el;
}

// Returns an array of one or more positioned DOM elements for a field.
// Only radio groups need more than one: they have a separate on-page
// widget per option (field.boxes, one per field.options entry), so each
// gets its own <input type="radio">, all sharing `name` so the browser
// enforces "exactly one selected" the same way the PDF does.
function createFieldElement(field, scaleX, scaleY) {
  if (field.type === 'radio') {
    const boxes = field.boxes || (field.box ? [field.box] : []);
    return boxes.map((box, i) => {
      const el = document.createElement('input');
      el.type = 'radio';
      el.name = field.name;
      el.value = field.options?.[i] ?? String(i);
      el.checked = field.selected != null && el.value === field.selected;

      // PDF radio groups (unlike native HTML ones) can be cleared back to
      // "no answer" by clicking the already-selected option again. Capture
      // the checked state on mousedown (before the browser's own click
      // handling would flip it) so the click handler can tell "was this
      // one already selected?" and, if so, cancel the browser's default
      // re-select and uncheck it instead.
      el.addEventListener('mousedown', () => {
        el.dataset.wasChecked = el.checked ? '1' : '';
      });
      el.addEventListener('click', (event) => {
        if (el.dataset.wasChecked) {
          event.preventDefault();
          // Canceling a radio's click makes the browser revert `checked`
          // back to its pre-click value (per spec "canceled activation
          // steps") right after this handler returns - which is `true`
          // here, clobbering a same-tick assignment. Deferring past that
          // makes the uncheck actually stick.
          setTimeout(() => {
            el.checked = false;
          }, 0);
        }
      });

      return positionAndWire(el, field, box, scaleX, scaleY, i);
    });
  }

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

  return [positionAndWire(el, field, box, scaleX, scaleY)];
}

main().catch((err) => {
  console.error(err);
  statusEl.textContent = `Failed to load: ${err.message}`;
});
