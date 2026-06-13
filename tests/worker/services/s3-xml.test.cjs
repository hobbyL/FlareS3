const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

test("s3 XML helpers extract values and decode XML entities", () => {
  const { decodeXmlEntities, extractXmlBlocks, extractXmlValue } = require(
    compiledPath("services/s3Xml.js"),
  );
  const xml =
    "<Root><Item><Key>a&amp;b.txt</Key></Item><Item><Key>x&#35;y.txt</Key></Item></Root>";

  const blocks = extractXmlBlocks(xml, "Item");
  assert.equal(blocks.length, 2);
  assert.equal(decodeXmlEntities(extractXmlValue(blocks[0], "Key")), "a&b.txt");
  assert.equal(decodeXmlEntities(extractXmlValue(blocks[1], "Key")), "x#y.txt");
});

test("s3 XML helpers build sorted complete multipart XML", () => {
  const {
    buildCompleteMultipartUploadXml,
    normalizeCompleteMultipartParts,
  } = require(compiledPath("services/s3Xml.js"));

  const parts = normalizeCompleteMultipartParts([
    { PartNumber: 2, ETag: '"etag-2"' },
    { PartNumber: 1, ETag: '"etag-1"' },
  ]);
  const xml = buildCompleteMultipartUploadXml(parts);

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.ok(
    xml.indexOf("<PartNumber>1</PartNumber>") <
      xml.indexOf("<PartNumber>2</PartNumber>"),
  );
  assert.match(xml, /<ETag>"etag-1"<\/ETag>/);
});
