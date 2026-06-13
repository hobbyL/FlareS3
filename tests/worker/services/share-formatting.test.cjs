const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

test("formatDateTimeLocal formats valid local date time values", () => {
  const { formatDateTimeLocal } = require(
    compiledPath("services/shareFormatting.js"),
  );
  const iso = "2026-04-15T08:30:00.000Z";
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, "0");
  const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

  assert.equal(formatDateTimeLocal(iso), expected);
});

test("formatDateTimeLocal hides empty and invalid values", () => {
  const { formatDateTimeLocal } = require(
    compiledPath("services/shareFormatting.js"),
  );

  assert.equal(formatDateTimeLocal(null), "");
  assert.equal(formatDateTimeLocal(""), "");
  assert.equal(formatDateTimeLocal("not-a-date"), "");
});
