import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMountDownloadUrl,
  buildMountedObjectRows,
  formatMountBytes,
  getMountObjectBasename,
  getMountParentPrefix,
  isMountedObjectPreviewSupported,
  normalizeMountPrefix,
} from "../../../frontend/src/utils/mountObjects.js";

test("normalizeMountPrefix stores prefixes in canonical folder form", () => {
  assert.equal(normalizeMountPrefix(""), "");
  assert.equal(normalizeMountPrefix("/"), "");
  assert.equal(normalizeMountPrefix("/docs/team"), "docs/team/");
  assert.equal(normalizeMountPrefix("docs/team/"), "docs/team/");
});

test("mount object helpers format display values and navigation paths", () => {
  assert.equal(formatMountBytes(-1), "-");
  assert.equal(formatMountBytes(0), "0 B");
  assert.equal(formatMountBytes(1536), "1.5 KB");
  assert.equal(getMountObjectBasename("docs/report.pdf"), "report.pdf");
  assert.equal(getMountParentPrefix("docs/team/"), "docs/");
  assert.equal(getMountParentPrefix("docs/"), "");
  assert.equal(isMountedObjectPreviewSupported("docs/report.pdf"), true);
  assert.equal(isMountedObjectPreviewSupported("docs/archive.zip"), false);
});

test("buildMountDownloadUrl encodes config id and object key", () => {
  assert.equal(buildMountDownloadUrl("", "docs/report.pdf"), "");
  assert.equal(buildMountDownloadUrl("cfg-1", ""), "");
  assert.equal(
    buildMountDownloadUrl("cfg 1", "docs/report 1.pdf"),
    "/api/mount/download?config_id=cfg%201&key=docs%2Freport%201.pdf",
  );
});

test("buildMountedObjectRows derives folder and object table rows from current prefix", () => {
  assert.deepEqual(
    buildMountedObjectRows({
      basePrefix: "docs/",
      folders: ["docs/team/"],
      objects: [
        {
          key: "docs/report.pdf",
          size: 1536,
          last_modified: "2026-04-11T00:00:00Z",
        },
        { key: "docs/", size: 0 },
      ],
    }),
    [
      {
        kind: "folder",
        key: "docs/team/",
        name: "team",
      },
      {
        kind: "object",
        key: "docs/report.pdf",
        name: "report.pdf",
        size: 1536,
        last_modified: "2026-04-11T00:00:00Z",
      },
    ],
  );
});
