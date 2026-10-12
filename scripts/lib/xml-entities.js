// Decodes XML character references found in XFA/XMP text content: the five
// named entities, plus numeric references (decimal &#10; and hex &#xD;) -
// e.g. Designer's multi-line tooltips join lines with a literal &#xD;
// (carriage return) that must be decoded, not displayed as-is.

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(str) {
  return str.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[entity] || match;
  });
}

module.exports = { decodeXmlEntities };
