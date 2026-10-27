const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const content = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");

function element() {
  const classes = new Set();
  return {
    textContent: "",
    title: "",
    dataset: {},
    children: [],
    classList: {
      add(value) {
        classes.add(value);
      },
      remove(value) {
        classes.delete(value);
      },
      toggle(value, enabled) {
        if (enabled) classes.add(value);
        else classes.delete(value);
      },
    },
    classes,
    setAttribute() {},
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
    },
    querySelector(selector) {
      return (
        this.children.find((child) => `.${child.className}` === selector) ||
        null
      );
    },
    remove() {
      this.parentElement.children = this.parentElement.children.filter(
        (child) => child !== this,
      );
    },
  };
}

test("grid replaces Status with delivery badges and restores it when hidden", () => {
  const live = element();
  const inactive = element();
  const rows = [
    ["43769", live],
    ["42424", inactive],
  ].map(([id, parent]) => ({
    getAttribute() {
      return id;
    },
    querySelector() {
      return parent;
    },
  }));
  const sandbox = {
    document: {
      querySelectorAll() {
        return rows;
      },
      createElement: element,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    content.slice(
      content.indexOf("function renderLiveAdsetStatus"),
      content.indexOf("function wireDeliveryTooltip"),
    ),
    sandbox,
  );
  const check = {
    showDelivery: true,
    results: new Map([
      ["43769", { status: "Live", impressions: 10000 }],
      ["42424", { status: "Not live", impressions: 0 }],
    ]),
  };
  const render = () =>
    sandbox.renderLiveAdsetStatus(
      { advertiserId: "755" },
      { startDate: "2026-10-13" },
      check,
    );
  render();
  assert(live.classes.has("co-plus-delivery-replaced"));
  assert.equal(
    live.querySelector(".co-plus-live-adset-status").textContent,
    "Live",
  );
  assert.equal(
    inactive.querySelector(".co-plus-live-adset-status").textContent,
    "Not live",
  );
  assert.equal(
    live.querySelector(".co-plus-live-adset-status").dataset.tooltip,
    `Live: more than 1,000 impressions in the last full UTC day.\n${(10000).toLocaleString()} impressions on 2026-10-13 (UTC)`,
  );
  assert.match(
    inactive.querySelector(".co-plus-live-adset-status").dataset.tooltip,
    /^Not live: 1,000 or fewer/,
  );
  assert.equal(live.querySelector(".co-plus-default-rate"), null);
  check.showDelivery = false;
  render();
  assert(!live.classes.has("co-plus-delivery-replaced"));
  assert(!live.classes.has("co-plus-delivery-cell"));
  assert.equal(live.querySelector(".co-plus-live-adset-status"), null);
});
