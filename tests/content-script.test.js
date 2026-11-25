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

test("simulator tree keeps scalar stored variant content for tag matching", () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(root, "content.js"), "utf8");
  const extract = (name) => {
    const start = source.indexOf(`function ${name}(`);
    let depth = 0;
    let end = source.indexOf("{", start);
    for (; ; end++) {
      if (source[end] === "{") depth++;
      else if (source[end] === "}" && --depth === 0) break;
    }
    return source.slice(start, end + 1);
  };
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${extract("getStoredContentComponents")}${extract("getSimulatorTreeNodes")}` +
      "globalThis.getSimulatorTreeNodes = getSimulatorTreeNodes;",
    context,
  );
  const [node] = context.getSimulatorTreeNodes({
    nodes: [{
      id: 1,
      "ad-variants": [{
        "content-id": "V1",
        "ad-formats": [{ width: 300, height: 250 }],
        components: {
          display: {
            value: {
              content: {
                consumerType: { type: "text", value: "DCOM" },
                products: { type: "collection", value: [{}] },
              },
              template: { id: 1 },
            },
          },
          trackers: { value: [] },
        },
      }],
    }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(node["ad-variants"][0].components)), {
    display: { value: { content: { consumerType: { value: "DCOM" } } } },
  });
});
