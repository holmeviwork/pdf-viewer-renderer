// Builds the reference filenames for a Skatteverket form's companion .xls
// files, derived entirely from metadata already sitting in the form's own
// XFA <variables> block (see extractTemplateVariables in xfa-template.js)
// plus the section prefixes read off its barcode fields' "titel" scripts
// (see extractSectionPrefixes in xfa-template.js) - nothing here is
// hardcoded per form.
//
//   base_string = "{myndighet}{formularid}-{utgava}-{formularversion}-{yy}-{mm}"
//   filename    = "{section}_{base_string}.xls"
//
// e.g. for SKV 2002 (myndighet SKV, formularid 2002, utgava 33, version 01,
// konstruktionsdatum 2024-04-30) with sections ["INK2", "INK2R", "INK2S"]:
//   base_string = "SKV2002-33-01-24-04"
//   files       = INK2_SKV2002-33-01-24-04.xls, INK2R_..., INK2S_...

// Observed in the wild in two shapes: dashed "2024-04-30" (most forms) and
// the dash-less "20180926" (older ones, e.g. SKV 2111/2113/2115/2116) - the
// dashes are optional here to accept both.
const KONSTRUKTIONSDATUM_RE = /^(\d{4})-?(\d{2})-?\d{2}$/;

const PATTERN = '{section}_{myndighet}{formularid}-{utgava}-{formularversion}-{yy}-{mm}.xls';

function buildXlsFileReferences(myndighet, formularid, utgava, formularversion, konstruktionsdatum, sections) {
  const dateMatch = KONSTRUKTIONSDATUM_RE.exec(konstruktionsdatum || '');
  if (!dateMatch) {
    throw new Error(
      `konstruktionsdatum must be an ISO-ish date (YYYY-MM-DD or YYYYMMDD), got: ${JSON.stringify(konstruktionsdatum)}`,
    );
  }

  const yearYY = dateMatch[1].slice(2);
  const monthMM = dateMatch[2];
  const baseString = `${myndighet}${formularid}-${utgava}-${formularversion}-${yearYY}-${monthMM}`;

  return {
    source_metadata: {
      myndighet,
      formularid,
      utgava,
      formularversion,
      konstruktionsdatum,
      year_yy: yearYY,
      month_mm: monthMM,
    },
    base_string: baseString,
    pattern: PATTERN,
    files: sections.map((section) => ({
      section,
      filename: `${section}_${baseString}.xls`,
    })),
  };
}

module.exports = { buildXlsFileReferences };

// node scripts/lib/xls-filenames.js - self-test using the SKV 2002 values
// from this module's own header comment.
if (require.main === module) {
  const assert = require('assert');

  const result = buildXlsFileReferences('SKV', '2002', '33', '01', '2024-04-30', ['INK2', 'INK2R', 'INK2S']);

  assert.strictEqual(result.base_string, 'SKV2002-33-01-24-04');
  assert.deepStrictEqual(result.source_metadata, {
    myndighet: 'SKV',
    formularid: '2002',
    utgava: '33',
    formularversion: '01',
    konstruktionsdatum: '2024-04-30',
    year_yy: '24',
    month_mm: '04',
  });
  assert.deepStrictEqual(
    result.files.map((f) => f.filename),
    ['INK2_SKV2002-33-01-24-04.xls', 'INK2R_SKV2002-33-01-24-04.xls', 'INK2S_SKV2002-33-01-24-04.xls'],
  );

  // Real-world regression case: SKV 2111/2113/2115/2116 use a dash-less
  // konstruktionsdatum ("20180926" instead of "2018-09-26") - this threw
  // and silently aborted regeneration for those 4 PDFs before this format
  // was accounted for.
  const dashless = buildXlsFileReferences('SKV', '2111', '03', '02', '20180926', ['INV']);
  assert.strictEqual(dashless.base_string, 'SKV2111-03-02-18-09');
  assert.strictEqual(dashless.files[0].filename, 'INV_SKV2111-03-02-18-09.xls');

  console.log('OK - xls-filenames self-test passed');
  console.log(JSON.stringify(result, null, 2));
}
