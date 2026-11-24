const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("content script is configured and written as a classic script", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  const contentScript = manifest.content_scripts.find((entry) =>
    entry.js.includes("content.js"),
  );
  assert.ok(contentScript);
  assert.equal(contentScript.type, undefined);
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, "content.js"), "utf8"),
    /^\s*import\s/m,
  );
});
