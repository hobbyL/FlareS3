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
  // ETag 中的引号必须转义为 XML 实体，服务端解析后还原为字面量
  assert.match(xml, /<ETag>&quot;etag-1&quot;<\/ETag>/);
  assert.match(xml, /<ETag>&quot;etag-2&quot;<\/ETag>/);
});

test("encodeXmlEntities escapes special characters", () => {
  const { encodeXmlEntities } = require(compiledPath("services/s3Xml.js"));

  assert.equal(
    encodeXmlEntities('"abc<def&ghi>jk\'l"'),
    "&quot;abc&lt;def&amp;ghi&gt;jk&apos;l&quot;",
  );
  assert.equal(encodeXmlEntities("plain-etag"), "plain-etag");
});

test("encodeXmlEntities and decodeXmlEntities round-trip", () => {
  const { decodeXmlEntities, encodeXmlEntities } = require(
    compiledPath("services/s3Xml.js"),
  );

  const literals = [
    '"d41d8cd98f00b204e9800998ecf8427e"',
    "a&b<c>d\"e'f",
    "&&lt;mixed",
  ];
  for (const literal of literals) {
    assert.equal(decodeXmlEntities(encodeXmlEntities(literal)), literal);
  }
});

test("parseListPartsXml decodes XML entities in ETag values", () => {
  const { parseListPartsXml } = require(compiledPath("services/s3Xml.js"));

  const xml =
    "<ListPartsResult>" +
    "<Part><PartNumber>1</PartNumber><ETag>&quot;aaa111&quot;</ETag></Part>" +
    "<Part><PartNumber>2</PartNumber><ETag>&amp;lt;tag&amp;gt;</ETag></Part>" +
    "<Part><PartNumber>3</PartNumber></Part>" +
    "<Part><PartNumber>not-a-number</PartNumber><ETag>&quot;bad&quot;</ETag></Part>" +
    "</ListPartsResult>";

  const parts = parseListPartsXml(xml);

  // 断点续传回传 ETag 时必须拿到解码后的字面量，否则 complete 报 InvalidPart
  assert.deepEqual(parts, [
    { PartNumber: 1, ETag: '"aaa111"' },
    { PartNumber: 2, ETag: "&lt;tag&gt;" },
    { PartNumber: 3, ETag: undefined },
  ]);
});
