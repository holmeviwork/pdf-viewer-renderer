// Reads document-identity facts (creator tool, producer, document/instance
// UUIDs, created/issued dates, title, PDFUA conformance part, template
// version) out of a PDF's XMP metadata stream (Catalog -> /Metadata, RDF/
// XML). pdf-lib's convenience getters (getProducer(), getCreationDate(),
// etc.) read the classic Info dictionary instead, which for these forms can
// be stale/rewritten by whatever tool last saved the file - the XMP packet
// holds the original values from the actual PDF authoring tool.

const { PDFName, decodePDFRawStream } = require('pdf-lib');

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXmlEntities(str) {
  return str.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name]);
}

function simpleTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}`));
  return match ? decodeXmlEntities(match[1].trim()) : null;
}

function blockOf(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}`));
  return match ? match[1] : null;
}

function firstListItem(block) {
  if (!block) return null;
  const match = block.match(/<rdf:li[^>]*>([^<]*)<\/rdf:li>/);
  return match ? decodeXmlEntities(match[1].trim()) : null;
}

// <dc:date><rdf:Seq><rdf:li ...><rdf:value>V</rdf:value>
// <dc:element-refinement>dc:created</dc:element-refinement></rdf:li>...
function dateRefinements(block) {
  const result = {};
  if (!block) return result;
  const items = block.match(/<rdf:li[^>]*>[\s\S]*?<\/rdf:li>/g) || [];
  for (const item of items) {
    const value = item.match(/<rdf:value>([^<]*)<\/rdf:value>/);
    const refinement = item.match(/<dc:element-refinement>([^<]*)<\/dc:element-refinement>/);
    if (value && refinement) {
      const key = refinement[1].trim().replace(/^dc:/, '');
      result[key] = value[1].trim();
    }
  }
  return result;
}

function extractDocumentMetadata(pdfDoc) {
  try {
    const metaRef = pdfDoc.catalog.get(PDFName.of('Metadata'));
    if (!metaRef) return null;

    const stream = pdfDoc.context.lookup(metaRef);
    const bytes = decodePDFRawStream(stream).decode();
    const xml = Buffer.from(bytes).toString('utf8');

    const dates = dateRefinements(blockOf(xml, 'dc:date'));

    const versionBlock = blockOf(xml, 'desc:version');
    const versionValue = versionBlock && versionBlock.match(/<rdf:value>([^<]*)<\/rdf:value>/);
    const versionRef = versionBlock && versionBlock.match(/<desc:ref>([^<]*)<\/desc:ref>/);
    const templateVersionRef =
      versionValue && versionRef ? `${versionValue[1].trim()} (${versionRef[1].trim()})` : null;

    return {
      creatorTool: simpleTag(xml, 'xmp:CreatorTool'),
      producer: simpleTag(xml, 'pdf:Producer'),
      documentId: simpleTag(xml, 'xmpMM:DocumentID'),
      instanceId: simpleTag(xml, 'xmpMM:InstanceID'),
      metadataDate: simpleTag(xml, 'xmp:MetadataDate'),
      createDate: simpleTag(xml, 'xmp:CreateDate'),
      modifyDate: simpleTag(xml, 'xmp:ModifyDate'),
      pdfuaPart: simpleTag(xml, 'pdfuaid:part'),
      created: dates.created || null,
      issued: dates.issued || null,
      creator: firstListItem(blockOf(xml, 'dc:creator')),
      title: firstListItem(blockOf(xml, 'dc:title')),
      templateVersionRef,
    };
  } catch {
    return null;
  }
}

module.exports = { extractDocumentMetadata };
