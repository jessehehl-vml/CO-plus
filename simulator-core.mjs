export function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("Feed CSV must be text.");

  const records = [];
  let record = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error("Feed CSV contains an unterminated quoted field.");
  if (field !== "" || record.length) {
    record.push(field);
    if (record.some((value) => value !== "")) records.push(record);
  }

  const headers = records.shift()?.map((value, index) =>
    index === 0 ? value.replace(/^\uFEFF/, "").trim() : value.trim(),
  );
  if (!headers?.length) throw new Error("Feed CSV has no header row.");

  return records.map((values) =>
    Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""]),
    ),
  );
}

// Adds each mapped field key ("to") next to its source sheet header ("from").
export function applyFeedMappings(rows, mappings = []) {
  const usable = mappings.filter(
    ({ from, to } = {}) => from && to && from.trim() !== to.trim(),
  );
  if (!usable.length) return rows;
  return rows.map((row) => {
    const mapped = { ...row };
    for (const { from, to } of usable) {
      const source = from.trim();
      if (Object.hasOwn(row, source) && !Object.hasOwn(mapped, to.trim())) {
        mapped[to.trim()] = row[source];
      }
    }
    return mapped;
  });
}

export function parseLineIds(text) {
  return [
    ...new Set(
      String(text ?? "")
        .split(/[\r\n,;]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export function getFeedLineIds(feedRows, inputField) {
  return [
    ...new Set(
      feedRows.flatMap((row) => parseLineIds(row?.[inputField])),
    ),
  ];
}

export function compareTagResultToFeed(
  tagResult,
  feedRows,
  inputField,
  valueField,
) {
  const content = tagResult?.response?.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return {
      contentFields: [],
      candidates: [],
      exactVariantIds: [],
      partialVariantIds: [],
    };
  }

  const contentEntries = Object.entries(content).filter(
    ([, item]) =>
      item &&
      typeof item === "object" &&
      Object.hasOwn(item, "value"),
  );
  const contentFields = contentEntries.map(([field, item]) => ({
    field,
    value: String(item.value ?? "")
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim(),
  }));
  if (!contentFields.length) {
    return {
      contentFields,
      candidates: [],
      exactVariantIds: [],
      partialVariantIds: [],
    };
  }

  const candidatesByVariant = new Map();
  for (const row of feedRows) {
    const variantId = String(row.variant_id ?? "").trim();
    if (!variantId) continue;

    const matchedFields = [];
    const differingFields = [];
    const missingFields = [];
    for (const { field, value } of contentFields) {
      if (!Object.hasOwn(row, field)) {
        missingFields.push(field);
      } else if (
        String(row[field] ?? "")
          .normalize("NFC")
          .replace(/\s+/g, " ")
          .trim() === value
      ) {
        matchedFields.push(field);
      } else {
        differingFields.push({
          field,
          tagValue: value,
          feedValue: String(row[field] ?? "")
            .normalize("NFC")
            .replace(/\s+/g, " ")
            .trim(),
        });
      }
    }

    const candidate = {
      variantId,
      matchedFields,
      differingFields,
      missingFields,
      matches: matchedFields.length,
      compared: matchedFields.length + differingFields.length,
      total: contentFields.length,
      sourceLineIds: parseLineIds(row[inputField]),
      sourceAudiences: String(row[valueField] ?? "").trim()
        ? [String(row[valueField]).trim()]
        : [],
      compatible:
        matchedFields.length + differingFields.length > 0 &&
        differingFields.length === 0,
      exact:
        matchedFields.length === contentFields.length &&
        missingFields.length === 0,
    };
    const existing = candidatesByVariant.get(variantId);
    const candidateRank = [
      Number(candidate.exact),
      Number(candidate.compatible),
      candidate.matches,
      candidate.compared,
    ];
    const existingRank = existing
      ? [
          Number(existing.exact),
          Number(existing.compatible),
          existing.matches,
          existing.compared,
        ]
      : [];
    let rankComparison = existing ? 0 : 1;
    for (let index = 0; existing && index < candidateRank.length; index++) {
      if (candidateRank[index] !== existingRank[index]) {
        rankComparison = candidateRank[index] > existingRank[index] ? 1 : -1;
        break;
      }
    }

    if (rankComparison > 0) {
      candidatesByVariant.set(variantId, candidate);
    } else if (rankComparison === 0) {
      existing.sourceLineIds = [
        ...new Set([...existing.sourceLineIds, ...candidate.sourceLineIds]),
      ];
      existing.sourceAudiences = [
        ...new Set([...existing.sourceAudiences, ...candidate.sourceAudiences]),
      ];
    }
  }

  const candidates = [...candidatesByVariant.values()].sort(
    (first, second) =>
      Number(second.exact) - Number(first.exact) ||
      Number(second.compatible) - Number(first.compatible) ||
      second.matches - first.matches ||
      second.compared - first.compared ||
      first.variantId.localeCompare(second.variantId),
  );
  return {
    contentFields,
    candidates,
    exactVariantIds: candidates
      .filter((candidate) => candidate.exact)
      .map((candidate) => candidate.variantId),
    partialVariantIds: candidates
      .filter((candidate) => candidate.compatible && !candidate.exact)
      .map((candidate) => candidate.variantId),
  };
}

export function getDynamicFeedContext(tree) {
  const nodes = tree?.nodes;
  if (!Array.isArray(nodes)) throw new Error("Decision tree has no nodes.");

  const feedNodes = nodes.filter((node) => node.type === "dynamic-feed");
  if (!feedNodes.length) {
    throw new Error("The strategy has no dynamic feed node.");
  }

  const readFeedNode = (feedNode) => {
    const context = (feedNode.targeting?.context || []).find(
      (item) => item?.param?.["feed-id"] != null,
    );
    const input = context?.param?.data?.in?.[0];
    const inputField = input?.to;
    const valueField = context?.["value-column"];
    if (!context || !inputField || !valueField) {
      throw new Error("The dynamic feed is missing its input or value-column mapping.");
    }
    return {
      feedId: String(context.param["feed-id"]),
      alias: context.alias || `feed-${context.param["feed-id"]}`,
      inputField,
      valueField,
      inputSource: [input.from?.alias, input.from?.selector]
        .filter(Boolean)
        .join("."),
      targetingColumn: String(feedNode.targeting?.["targeting-column"] || "").trim(),
    };
  };
  const configs = feedNodes.map(readFeedNode);
  const signature = (config) => JSON.stringify(config);
  if (configs.some((config) => signature(config) !== signature(configs[0]))) {
    throw new Error(
      `The strategy uses ${feedNodes.length} dynamic feed nodes with different ` +
        "feeds or mappings; only repeated copies of the same feed are supported.",
    );
  }

  return {
    feedNodeId: String(feedNodes[0].id),
    feedNodeIds: feedNodes.map((node) => String(node.id)),
    ...configs[0],
  };
}

// Production tags can set any DSP signal macro and override the request's
// postal code, so feeds keyed on those inputs can be steered per outcome.
export function isSteerableTagInput(source) {
  return /^dsp-signal\.[\w-]+$/.test(source || "") || source === "location.postal-code";
}

export function getTagRunBlockers(tree, context) {
  const blockers = [];
  if (!isSteerableTagInput(context.inputSource)) {
    blockers.push(
      `The feed is keyed on ${context.inputSource || "an unknown input"}, ` +
        "which production tags cannot set, so tags cannot be steered to each feed outcome.",
    );
  }
  const nodesById = new Map((tree?.nodes || []).map((node) => [String(node.id), node]));
  const pathNodeIds = new Set();
  const unsupportedPaths = new Set();
  for (const feedNodeId of context.feedNodeIds || [context.feedNodeId]) {
    const path = getFeedNodeSignals(feedNodeId, nodesById);
    path.nodeIds.forEach((id) => pathNodeIds.add(id));
    path.unsupported.forEach((label) => unsupportedPaths.add(label));
  }
  if (unsupportedPaths.size) {
    blockers.push(
      `The feed is reached through ${[...unsupportedPaths].join(", ")}, ` +
        "which the checker cannot simulate.",
    );
  }
  // DSP signals outside the feed path (e.g. below an outcome) are not steered.
  const otherSignals = new Set();
  const inputSignal = context.inputSource?.match(/^dsp-signal\.([\w-]+)$/)?.[1];
  for (const node of tree?.nodes || []) {
    if (pathNodeIds.has(String(node.id))) continue;
    const predicate = JSON.stringify(node.targeting?.predicate ?? "");
    for (const [, signal] of predicate.matchAll(/\$\{dsp-signal\.([\w-]+)\}/g)) {
      if (signal !== inputSignal) otherSignals.add(signal);
    }
  }
  if (otherSignals.size) {
    blockers.push(
      `The strategy branches on ${[...otherSignals].join(", ")}, ` +
        "which the checker cannot simulate.",
    );
  }
  return blockers;
}

// Collects the DSP signal values a tag must send to reach a dynamic feed node,
// e.g. { "dsp-signal.dsp-placementid": "420746846" }.
function getFeedNodeSignals(feedNodeId, nodesById) {
  const signals = {};
  const labels = [];
  const nodeIds = [];
  const unsupported = [];
  let node = nodesById.get(String(nodesById.get(String(feedNodeId))?.["parent-id"]));
  while (node && node.type !== "root") {
    nodeIds.push(String(node.id));
    const predicate = node.targeting?.predicate;
    const label = String(node.label ?? "").trim();
    if (Array.isArray(predicate) && predicate.length) {
      const [operator, expression, expected] = predicate;
      const match = String(expression ?? "").match(/^\$\{([\w-]+)\.([\w-]+)\}$/);
      if (
        (operator === "=" || operator === "==") &&
        match?.[1] === "dsp-signal" &&
        expected != null
      ) {
        signals[`dsp-signal.${match[2]}`] = String(expected).trim();
        labels.unshift(`${match[2]} ${expected}`);
      } else {
        unsupported.push(label || node.type || "an unsupported node");
        if (label) labels.unshift(label);
      }
    } else if (label) {
      labels.unshift(label);
    }
    node = nodesById.get(String(node["parent-id"]));
  }
  return { signals, label: labels.join(" → "), nodeIds, unsupported };
}

// Labels the nodes between the root and a dynamic feed node, e.g.
// "dsp-placementid 420746846", so repeated feed copies can be told apart.
function getFeedNodePath(feedNodeId, nodesById) {
  return getFeedNodeSignals(feedNodeId, nodesById).label;
}

// Builds the production tag requests that reach every feed outcome. Line IDs
// are all tested; other inputs (e.g. postal codes) use one feed key per
// audience, since they can have thousands of keys.
export function getTagTargets(tree, context, lookupRows) {
  const nodesById = new Map(tree.nodes.map((node) => [String(node.id), node]));
  const audiencesByKey = new Map();
  for (const row of lookupRows) {
    const audience = String(row[context.valueField] ?? "").trim();
    for (const key of parseLineIds(row[context.inputField])) {
      if (!audiencesByKey.has(key)) audiencesByKey.set(key, new Set());
      if (audience) audiencesByKey.get(key).add(audience);
    }
  }
  const allKeys = /(^|\.)dsp-lineid$/.test(context.inputSource || "")
    ? [...audiencesByKey.keys()]
    : null;
  const inputName = context.inputSource?.split(".").pop() || context.inputField;
  const targets = [];
  const untested = [];
  for (const feedNodeId of context.feedNodeIds || [context.feedNodeId]) {
    const path = getFeedNodeSignals(feedNodeId, nodesById);
    const pathLabel = (context.feedNodeIds?.length || 1) > 1 ? path.label : "";
    let keys = allKeys;
    if (!keys) {
      const audiences = tree.nodes
        .filter(
          (node) =>
            node.type === "dynamic-feed-outcome" &&
            String(node["parent-id"]) === String(feedNodeId),
        )
        .map((node) => getFeedOutcomeAudience(node, context));
      keys = [];
      for (const audience of [...new Set(audiences)]) {
        const key = [...audiencesByKey].find(
          ([, keyAudiences]) =>
            keyAudiences.size === 1 && keyAudiences.has(audience),
        )?.[0];
        if (key) keys.push(key);
        else untested.push(pathLabel ? `${pathLabel} → ${audience}` : audience);
      }
    }
    // A branch (e.g. one placement ID) usually serves only some sizes; tags
    // at other sizes would miss the branch and serve the root fallback.
    const subtreeNodes = [];
    const pending = [String(feedNodeId)];
    while (pending.length) {
      const id = pending.pop();
      const node = nodesById.get(id);
      if (node) subtreeNodes.push(node);
      for (const child of tree.nodes) {
        if (String(child["parent-id"]) === id) pending.push(String(child.id));
      }
    }
    const adSizes = getStrategyAdSizes({ nodes: subtreeNodes });
    for (const key of keys) {
      const audiences = [...(audiencesByKey.get(key) || [])];
      const keyLabel = allKeys ? key : `${inputName} ${key}`;
      targets.push({
        key,
        feedNodeId: String(feedNodeId),
        adSizes,
        audiences,
        signals: { ...path.signals, [context.inputSource]: key },
        label:
          [pathLabel, keyLabel].filter(Boolean).join(" · ") +
          (allKeys || !audiences.length ? "" : ` (${audiences.join(", ")})`),
      });
    }
  }
  return { targets, untested };
}

// Finds the feed column whose values are the tree's variant content IDs.
export function findVariantIdColumn(rows, tree) {
  const contentIds = new Set(
    (tree?.nodes || []).flatMap((node) =>
      (node["ad-variants"] || [])
        .map((variant) => String(variant?.["content-id"] ?? "").trim())
        .filter(Boolean),
    ),
  );
  if (!rows.length || !contentIds.size) return null;
  let best = null;
  for (const column of Object.keys(rows[0])) {
    const matches = rows.filter((row) =>
      contentIds.has(String(row[column] ?? "").trim()),
    ).length;
    if (
      matches > 0 &&
      (!best ||
        matches > best.matches ||
        (matches === best.matches && column === "variant_id"))
    ) {
      best = { column, matches };
    }
  }
  return best?.column ?? null;
}

// Joins a lookup feed (line IDs → audience) with a content feed (audience →
// variant rows) into rows shaped like a single combined feed: each content row
// gets variant_id, the audience under valueField, and its line IDs under
// inputField.
export function joinLookupAndContentFeeds({
  lookupRows,
  contentRows,
  context,
  variantIdColumn,
  audienceColumn,
}) {
  const lineIdsByAudience = new Map();
  for (const row of lookupRows) {
    const audience = String(row[context.valueField] ?? "").trim();
    if (!audience) continue;
    if (!lineIdsByAudience.has(audience)) lineIdsByAudience.set(audience, new Set());
    for (const lineId of parseLineIds(row[context.inputField])) {
      lineIdsByAudience.get(audience).add(lineId);
    }
  }
  return contentRows.map((row) => {
    const audience = String(row[audienceColumn] ?? "").trim();
    return {
      ...row,
      variant_id: String(row[variantIdColumn] ?? "").trim(),
      [context.valueField]: audience,
      [context.inputField]: [...(lineIdsByAudience.get(audience) || [])].join(","),
    };
  });
}

export function getStrategyAdSizes(tree) {
  if (!Array.isArray(tree?.nodes)) throw new Error("Decision tree has no nodes.");

  const sizes = new Map();
  for (const node of tree.nodes) {
    for (const variant of node["ad-variants"] || []) {
      for (const format of variant?.["ad-formats"] || []) {
        const width = Number(format?.width);
        const height = Number(format?.height);
        if (
          !Number.isSafeInteger(width) ||
          width <= 0 ||
          !Number.isSafeInteger(height) ||
          height <= 0
        ) {
          continue;
        }
        sizes.set(`${width}x${height}`, { width, height });
      }
    }
  }
  return [...sizes.values()];
}

function uniqueVariants(variants) {
  const byContentId = new Map();
  for (const variant of variants || []) {
    const contentId = String(variant?.["content-id"] || "").trim();
    if (!contentId) continue;

    const existing = byContentId.get(contentId) || {
      contentId,
      formats: [],
    };
    for (const format of variant?.["ad-formats"] || []) {
      const size =
        format?.width && format?.height
          ? `${format.width}x${format.height}`
          : null;
      if (size && !existing.formats.includes(size)) existing.formats.push(size);
    }
    byContentId.set(contentId, existing);
  }
  return [...byContentId.values()];
}

function getChildrenByParentId(nodes) {
  const childrenByParentId = new Map();
  for (const candidate of nodes) {
    if (candidate["parent-id"] == null) continue;
    const parentId = String(candidate["parent-id"]);
    const children = childrenByParentId.get(parentId) || [];
    children.push(candidate);
    childrenByParentId.set(parentId, children);
  }
  return childrenByParentId;
}

function getNodeAndDescendantVariants(node, childrenByParentId) {
  const pending = [node];
  const visited = new Set();
  const variants = [];
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index];
    const nodeId = String(current.id);
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    variants.push(...(current["ad-variants"] || []));
    pending.push(...(childrenByParentId.get(nodeId) || []));
  }
  return uniqueVariants(variants);
}

function getStrategyNodeTree(node, childrenByParentId) {
  const visited = new Set([String(node.id)]);
  const buildNode = (child) => {
    const nodeId = String(child.id);
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);
    const variants = uniqueVariants(child["ad-variants"]);
    return {
      type: child.type || "",
      label: child.label || "",
      timeRange: getTimeOfDayRange(child),
      variants: variants.map((variant) => variant.contentId),
      variantFormats: variants.map((variant) => ({
        variantId: variant.contentId,
        formats: variant.formats,
      })),
      children: (childrenByParentId.get(nodeId) || [])
        .map(buildNode)
        .filter(Boolean),
    };
  };
  return (childrenByParentId.get(String(node.id)) || [])
    .map(buildNode)
    .filter(Boolean);
}

const MINUTES_PER_DAY = 24 * 60;

function getTimeOfDayRange(node) {
  const predicate = node?.targeting?.predicate;
  if (
    !Array.isArray(predicate) ||
    predicate[0] !== "in-range" ||
    predicate[1] !== "${datetime.time-of-day}"
  ) {
    return null;
  }
  const toMinute = (time) => {
    const hour = Number(time?.hour);
    const minute = Number(time?.minute ?? 0);
    return Number.isInteger(hour) &&
      Number.isInteger(minute) &&
      hour >= 0 &&
      hour <= 24 &&
      minute >= 0 &&
      minute < 60
      ? (hour * 60 + minute) % MINUTES_PER_DAY
      : null;
  };
  const start = toMinute(predicate[2]?.start);
  const end = toMinute(predicate[2]?.end);
  return start === null || end === null ? null : { start, end };
}

// Start is inclusive and end exclusive; equal bounds cover the whole day.
export function isMinuteInTimeRange(range, minute) {
  if (range.start === range.end) return true;
  return range.start < range.end
    ? minute >= range.start && minute < range.end
    : minute >= range.start || minute < range.end;
}

export function formatMinuteOfDay(minute) {
  const hours = String(Math.floor(minute / 60)).padStart(2, "0");
  const minutes = String(minute % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatTimeRange(range) {
  return `${formatMinuteOfDay(range.start)}–${formatMinuteOfDay(range.end)}`;
}

export function getTimeOfDayPlan(overview) {
  const outcomes = [];
  const warnings = new Set();
  let unsupported = false;

  const visit = (nodes) => {
    const timedSiblings = [];
    for (const node of nodes) {
      if (node.type === "date-time-outcome") {
        if (node.timeRange) {
          outcomes.push(node);
          timedSiblings.push(node);
        } else {
          unsupported = true;
        }
      }
      visit(node.children || []);
    }
    for (let first = 0; first < timedSiblings.length; first++) {
      for (let second = first + 1; second < timedSiblings.length; second++) {
        const a = timedSiblings[first];
        const b = timedSiblings[second];
        const sameRange =
          a.timeRange.start === b.timeRange.start &&
          a.timeRange.end === b.timeRange.end;
        let overlaps = sameRange;
        for (let minute = 0; !overlaps && minute < MINUTES_PER_DAY; minute++) {
          overlaps =
            isMinuteInTimeRange(a.timeRange, minute) &&
            isMinuteInTimeRange(b.timeRange, minute);
        }
        if (!overlaps) continue;
        warnings.add(
          sameRange
            ? `${a.label || "Outcome"} and ${b.label || "Outcome"} use the same ` +
                `time range (${formatTimeRange(a.timeRange)}).`
            : `${a.label || "Outcome"} (${formatTimeRange(a.timeRange)}) and ` +
                `${b.label || "Outcome"} (${formatTimeRange(b.timeRange)}) overlap.`,
        );
      }
    }
  };
  for (const branch of overview.branches || []) {
    visit(branch.strategyNodes || []);
  }
  if (!outcomes.length) return { scenarios: [], warnings: [], unsupported };

  // Group minutes by the set of outcomes that match them and sample the
  // middle of the longest stretch for each distinct set.
  const signatureAt = (minute) =>
    outcomes
      .map((node, index) =>
        isMinuteInTimeRange(node.timeRange, minute) ? index : null,
      )
      .filter((index) => index !== null)
      .join(",");
  const signatures = Array.from({ length: MINUTES_PER_DAY }, (_, minute) =>
    signatureAt(minute),
  );
  let rotation = signatures.findIndex(
    (signature, minute) =>
      signature !== signatures[(minute + MINUTES_PER_DAY - 1) % MINUTES_PER_DAY],
  );
  if (rotation < 0) rotation = 0;
  const longest = new Map();
  let segmentStart = rotation;
  for (let offset = 1; offset <= MINUTES_PER_DAY; offset++) {
    const minute = (rotation + offset) % MINUTES_PER_DAY;
    const previous = (minute + MINUTES_PER_DAY - 1) % MINUTES_PER_DAY;
    if (offset < MINUTES_PER_DAY && signatures[minute] === signatures[previous]) {
      continue;
    }
    const length =
      ((previous - segmentStart + MINUTES_PER_DAY) % MINUTES_PER_DAY) + 1;
    const signature = signatures[segmentStart];
    if (!longest.has(signature) || longest.get(signature).length < length) {
      longest.set(signature, { start: segmentStart, length });
    }
    segmentStart = minute;
  }

  const scenarios = [...longest].map(([signature, segment]) => {
    const minute =
      (segment.start + Math.floor(segment.length / 2)) % MINUTES_PER_DAY;
    const labels = [
      ...new Set(
        signature
          ? signature.split(",").map((index) => outcomes[index].label || "Outcome")
          : [],
      ),
    ];
    return {
      minute,
      time: formatMinuteOfDay(minute),
      outcomeLabels: labels,
      label: labels.length ? labels.join(" & ") : "No time outcome",
    };
  });
  scenarios.sort((first, second) => first.minute - second.minute);
  return { scenarios, warnings: [...warnings], unsupported };
}

function getFeedOutcomeAudience(node, context) {
  const predicate = node?.targeting?.predicate;
  if (!Array.isArray(predicate) || predicate.length < 3) {
    throw new Error(`Feed outcome "${node?.label || node?.id}" has no predicate.`);
  }

  const [operator, expression, expected] = predicate;
  if (operator !== "=" && operator !== "==") {
    throw new Error(`Unsupported feed predicate operator: ${operator}`);
  }
  if (expression !== `\${${context.alias}.${context.valueField}}`) {
    throw new Error(`Unsupported feed predicate: ${String(expression)}`);
  }
  return String(expected).trim();
}

function matchesFeedOutcome(node, context, audience) {
  return String(audience).trim() === getFeedOutcomeAudience(node, context);
}

function sameVariantIds(first, second) {
  const firstIds = new Set(first);
  const secondIds = new Set(second);
  return (
    firstIds.size === secondIds.size &&
    [...firstIds].every((id) => secondIds.has(id))
  );
}

function valuesForLineId(value) {
  return String(value ?? "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildSimulationPlan(tree, feedRows, lineId) {
  const context = getDynamicFeedContext(tree);
  const nodes = tree.nodes;
  const root = nodes.find((node) => node.type === "root");
  if (!root) throw new Error("Decision tree has no root fallback.");

  const matchingRows = feedRows.filter((row) =>
    valuesForLineId(row[context.inputField]).includes(String(lineId).trim()),
  );
  const audiences = new Set(
    matchingRows.map((row) => String(row[context.valueField] || "").trim()),
  );
  if (audiences.size > 1) {
    throw new Error(`Line ID "${lineId}" maps to multiple feed audiences.`);
  }

  const row = matchingRows[0] || null;
  const audience = row ? String(row[context.valueField] || "").trim() : null;
  const outcomes = nodes.filter(
    (node) =>
      node.type === "dynamic-feed-outcome" &&
      String(node["parent-id"]) === context.feedNodeId,
  );
  const matchedOutcomes = row
    ? outcomes.filter((node) => matchesFeedOutcome(node, context, audience))
    : [];
  if (matchedOutcomes.length > 1) {
    throw new Error(`Multiple strategy outcomes match audience "${audience}".`);
  }

  const outcome = matchedOutcomes[0] || null;
  const selectedNode = outcome || root;
  const childrenByParentId = getChildrenByParentId(nodes);
  const strategyVariants = outcome
    ? getNodeAndDescendantVariants(outcome, childrenByParentId)
    : uniqueVariants(selectedNode["ad-variants"]);
  if (!strategyVariants.length) {
    throw new Error(
      `Strategy node "${selectedNode.label || selectedNode.id}" has no variants.`,
    );
  }

  const feedVariants = row
    ? [
        ...new Set(
          feedRows
            .filter(
              (feedRow) =>
                String(feedRow[context.valueField] || "").trim() === audience,
            )
            .map((feedRow) => String(feedRow.variant_id || "").trim())
            .filter(Boolean),
        ),
      ]
    : [];
  const matchesFeed =
    row &&
    outcome &&
    sameVariantIds(
      strategyVariants.map((variant) => variant.contentId),
      feedVariants,
    );

  return {
    lineId: String(lineId).trim(),
    audience,
    hasFeedRow: Boolean(row),
    outcomeLabel: selectedNode.label || "Default",
    usedFallback: !outcome,
    strategyVariants,
    feedVariants,
    matchesFeed: row ? Boolean(matchesFeed) : null,
  };
}

export function getStrategyOverview(tree, feedRows) {
  const context = getDynamicFeedContext(tree);
  const nodes = tree.nodes;
  const root = nodes.find((node) => node.type === "root");
  if (!root) throw new Error("Decision tree has no root fallback.");

  const feedNodeIds = new Set(context.feedNodeIds);
  const nodesById = new Map(nodes.map((node) => [String(node.id), node]));
  const outcomes = nodes.filter(
    (node) =>
      node.type === "dynamic-feed-outcome" &&
      feedNodeIds.has(String(node["parent-id"])),
  );
  const childrenByParentId = getChildrenByParentId(nodes);
  const branches = outcomes.map((node) => {
    const audience = getFeedOutcomeAudience(node, context);
    const audienceRows = feedRows.filter(
      (row) => String(row[context.valueField] || "").trim() === audience,
    );
    const feedVariants = [
      ...new Set(
        audienceRows
          .map((row) => String(row.variant_id || "").trim())
          .filter(Boolean),
      ),
    ];
    const strategyVariants = getNodeAndDescendantVariants(
      node,
      childrenByParentId,
    ).map(
      (variant) => variant.contentId,
    );
    const directStrategyVariants = uniqueVariants(node["ad-variants"]).map(
      (variant) => variant.contentId,
    );
    const directStrategyVariantFormats = uniqueVariants(
      node["ad-variants"],
    ).map((variant) => ({
      variantId: variant.contentId,
      formats: variant.formats,
    }));

    return {
      audience,
      feedNodeId: String(node["parent-id"]),
      outcomeLabel: node.label || audience,
      pathLabel:
        feedNodeIds.size > 1
          ? getFeedNodePath(String(node["parent-id"]), nodesById)
          : "",
      strategyVariants,
      directStrategyVariants,
      directStrategyVariantFormats,
      strategyNodes: getStrategyNodeTree(node, childrenByParentId),
      feedVariants,
      feedRowCount: audienceRows.length,
      matchesFeed:
        audienceRows.length > 0 &&
        feedVariants.length > 0 &&
        sameVariantIds(strategyVariants, feedVariants),
    };
  });
  const branchAudiences = new Set(branches.map((branch) => branch.audience));
  const unhandledAudiences = [
    ...new Set(
      feedRows
        .map((row) => String(row[context.valueField] || "").trim())
        .filter((audience) => audience && !branchAudiences.has(audience)),
    ),
  ];

  return {
    inputField: context.inputField,
    valueField: context.valueField,
    branches,
    unhandledAudiences: unhandledAudiences.map((audience) => ({
      audience,
      feedVariants: [
        ...new Set(
          feedRows
            .filter(
              (row) =>
                String(row[context.valueField] || "").trim() === audience,
            )
            .map((row) => String(row.variant_id || "").trim())
            .filter(Boolean),
        ),
      ],
    })),
    fallback: {
      label: root.label || "Default",
      strategyVariants: uniqueVariants(root["ad-variants"]).map(
        (variant) => variant.contentId,
      ),
      strategyVariantFormats: uniqueVariants(root["ad-variants"]).map(
        (variant) => ({
          variantId: variant.contentId,
          formats: variant.formats,
        }),
      ),
    },
  };
}

export function getStrategyVariantGroups(overview, size, minuteOfDay = null) {
  const sizeKey = `${size.width}x${size.height}`;
  const groups = [];
  const addGroup = (audience, path, variantFormats, feedNodeId = null) => {
    const variants = [
      ...new Set(
        variantFormats
          .filter(
            (variant) =>
              !variant.formats.length || variant.formats.includes(sizeKey),
          )
          .map((variant) => variant.variantId),
      ),
    ];
    if (variants.length) {
      groups.push({
        audience,
        feedNodeId,
        path: path.join(" → "),
        variants,
        multiVariant: variants.length > 1,
      });
    }
  };
  const visit = (branch, nodes, path = []) => {
    for (const node of nodes) {
      if (
        minuteOfDay !== null &&
        node.timeRange &&
        !isMinuteInTimeRange(node.timeRange, minuteOfDay)
      ) {
        continue;
      }
      const typeLabel =
        node.type === "date-time"
          ? "Date & Time"
          : node.type.replaceAll("-", " ");
      const label = node.label.trim() || typeLabel || "Strategy node";
      const nodePath = [...path, label];
      addGroup(branch.audience, nodePath, node.variantFormats, branch.feedNodeId);
      visit(branch, node.children, nodePath);
    }
  };

  for (const branch of overview.branches || []) {
    addGroup(
      branch.audience,
      [branch.pathLabel, branch.outcomeLabel].filter(Boolean),
      branch.directStrategyVariantFormats || [],
      branch.feedNodeId,
    );
    visit(branch, branch.strategyNodes || [], branch.pathLabel ? [branch.pathLabel] : []);
  }
  addGroup(
    null,
    [overview.fallback.label],
    overview.fallback.strategyVariantFormats || [],
  );
  return groups;
}

export function getStrategySummary(overview, lineIdCount, keyLabel = "line ID") {
  const audiences = new Set([
    ...(overview.branches || []).map((branch) => branch.audience),
    ...(overview.unhandledAudiences || []).map((audience) => audience.audience),
  ]);
  const terminalLabels = new Set();
  const addTerminalLabels = (nodes) => {
    for (const node of nodes) {
      if (node.children.length) {
        addTerminalLabels(node.children);
      } else if (node.label.trim()) {
        terminalLabels.add(node.label.trim());
      }
    }
  };
  for (const branch of overview.branches || []) {
    addTerminalLabels(branch.strategyNodes || []);
  }

  const lineLabel = `${lineIdCount} ${keyLabel}${lineIdCount === 1 ? "" : "s"}`;
  const audienceLabel =
    `${audiences.size} audience${audiences.size === 1 ? "" : "s"}`;
  const outcomeSummary = terminalLabels.size
    ? ` → ${[...terminalLabels].join(" & ")}`
    : "";
  return `${lineLabel} → Feed node routes to ${audienceLabel}${outcomeSummary}.`;
}

export function getStrategySuggestions(overview) {
  const suggestions = [];
  const pairedBranches = new Set();
  const branches = overview.branches || [];

  for (let firstIndex = 0; firstIndex < branches.length; firstIndex++) {
    const first = branches[firstIndex];
    if (
      first.matchesFeed ||
      pairedBranches.has(firstIndex) ||
      !first.feedVariants.length
    ) {
      continue;
    }

    for (let secondIndex = firstIndex + 1; secondIndex < branches.length; secondIndex++) {
      const second = branches[secondIndex];
      if (
        pairedBranches.has(secondIndex) ||
        second.matchesFeed ||
        !second.feedVariants.length ||
        !sameVariantIds(first.strategyVariants, second.feedVariants) ||
        !sameVariantIds(second.strategyVariants, first.feedVariants)
      ) {
        continue;
      }

      suggestions.push({ type: "swap", first, second });
      pairedBranches.add(firstIndex);
      pairedBranches.add(secondIndex);
      break;
    }
  }

  branches.forEach((branch, index) => {
    if (branch.matchesFeed || pairedBranches.has(index)) return;
    suggestions.push(
      branch.feedRowCount && branch.feedVariants.length
        ? {
            type: "align",
            audience: branch.audience,
            outcomeLabel: branch.outcomeLabel,
            currentVariants: branch.strategyVariants,
            expectedVariants: branch.feedVariants,
          }
        : {
            type: "check-feed",
            audience: branch.audience,
            outcomeLabel: branch.outcomeLabel,
          },
    );
  });

  for (const audience of overview.unhandledAudiences || []) {
    suggestions.push({
      type: "add-outcome",
      audience: audience.audience,
      feedVariants: audience.feedVariants,
    });
  }
  return suggestions;
}

export function simulateVariantCounts(plan, impressions, random = Math.random) {
  if (!Number.isInteger(impressions) || impressions < 1 || impressions > 10000) {
    throw new RangeError("Impressions must be between 1 and 10,000.");
  }
  if (!plan?.strategyVariants?.length) {
    throw new Error("No strategy variants are available to simulate.");
  }

  const counts = Object.fromEntries(
    plan.strategyVariants.map((variant) => [variant.contentId, 0]),
  );
  for (let i = 0; i < impressions; i++) {
    const index = Math.min(
      plan.strategyVariants.length - 1,
      Math.max(0, Math.floor(random() * plan.strategyVariants.length)),
    );
    counts[plan.strategyVariants[index].contentId]++;
  }
  return counts;
}

export function distributeImpressions(impressions, lineIds) {
  if (
    !Number.isInteger(impressions) ||
    impressions < 1 ||
    impressions > 10000
  ) {
    throw new RangeError("Total impressions must be between 1 and 10,000.");
  }

  const uniqueLineIds = Array.isArray(lineIds)
    ? [
        ...new Set(
          lineIds.map((lineId) => String(lineId).trim()).filter(Boolean),
        ),
      ]
    : [];
  if (!uniqueLineIds.length) {
    throw new Error("No DSP line IDs were found in the feed.");
  }
  if (impressions < uniqueLineIds.length) {
    throw new RangeError(
      `At least ${uniqueLineIds.length} total impressions are required to include every feed line ID.`,
    );
  }

  const base = Math.floor(impressions / uniqueLineIds.length);
  const remainder = impressions % uniqueLineIds.length;
  return uniqueLineIds.map((lineId, index) => ({
    lineId,
    impressions: base + (index < remainder ? 1 : 0),
  }));
}

export function getExpectedStrategyVariants(groups, audiences, feedNodeId = null) {
  const audienceGroups = groups.filter(
    (group) =>
      group.audience !== null &&
      audiences.includes(group.audience) &&
      (feedNodeId === null || group.feedNodeId === feedNodeId),
  );
  const expectedGroups = audienceGroups.length
    ? audienceGroups
    : groups.filter((group) => group.audience === null);
  return [...new Set(expectedGroups.flatMap((group) => group.variants))];
}

// Chance that at least one of `variantCount` equally weighted variants is
// never served in `samples` tags.
function getMissingVariantProbability(variantCount, samples) {
  return Math.min(1, variantCount * (1 - 1 / variantCount) ** samples);
}

export function summarizeTagVerification({
  checks = [],
  nodes = [],
  sampleLimit = null,
  warnings = [],
}) {
  const items = [];
  const verified = checks.filter((check) => check.exact);
  const outside = verified.filter(
    (check) => !check.expectedVariants.includes(check.variantId),
  );
  const unverified = checks.length - verified.length;

  if (!verified.length) {
    items.push({ status: "warn", text: "No served variant could be verified." });
  } else if (outside.length) {
    const examples = outside
      .slice(0, 5)
      .map(
        (check) =>
          `${check.label} → ${check.variantId} ` +
          `(expected ${check.expectedVariants.join(", ") || "none"})`,
      )
      .join("; ");
    items.push({
      status: "fail",
      text:
        `${outside.length} of ${verified.length} verified tags served a variant ` +
        `outside the expected strategy node: ${examples}` +
        (outside.length > 5 ? `; and ${outside.length - 5} more.` : "."),
    });
  } else {
    items.push({
      status: "pass",
      text:
        `All ${verified.length} verified tags served a variant from the ` +
        "expected strategy node.",
    });
  }
  // The strategy can be followed correctly and still route a line ID to
  // another audience's variants, so the feed expectation is checked too.
  const outsideFeed = verified.filter(
    (check) =>
      Array.isArray(check.feedVariants) &&
      !check.feedVariants.includes(check.variantId),
  );
  if (outsideFeed.length) {
    const examples = outsideFeed
      .slice(0, 5)
      .map(
        (check) =>
          `${check.label} → ${check.variantId} ` +
          `(feed expects ${check.feedVariants.join(", ") || "none"})`,
      )
      .join("; ");
    items.push({
      status: "fail",
      text:
        `${outsideFeed.length} of ${verified.length} verified tags served a ` +
        `variant outside the feed expectation for their target: ${examples}` +
        (outsideFeed.length > 5 ? `; and ${outsideFeed.length - 5} more.` : "."),
    });
  } else if (verified.some((check) => Array.isArray(check.feedVariants))) {
    items.push({
      status: "pass",
      text: `All ${verified.length} verified tags served a variant the feed expects for their target.`,
    });
  }
  if (unverified) {
    items.push({
      status: "warn",
      text: `${unverified} tag(s) could not be matched to exactly one feed variant.`,
    });
  }

  if (sampleLimit === 1) {
    items.push({
      status: "pass",
      text: "Routing check only; multi-variant coverage was not sampled.",
    });
  }
  for (const node of sampleLimit === 1 ? [] : nodes) {
    const counts = new Map(node.variants.map((variant) => [variant, 0]));
    for (const variantId of node.observedVariantIds) {
      if (counts.has(variantId)) counts.set(variantId, counts.get(variantId) + 1);
    }
    const samples = node.observedVariantIds.length;
    const split = [...counts]
      .map(([variant, count]) => `${variant} ${count}`)
      .join(" · ");
    const missing = [...counts]
      .filter(([, count]) => count === 0)
      .map(([variant]) => variant);
    if (!missing.length) {
      items.push({
        status: "pass",
        text: `${node.label}: all variants served (${split}).`,
      });
    } else if (
      getMissingVariantProbability(node.variants.length, samples) < 0.05
    ) {
      items.push({
        status: "fail",
        text:
          `${node.label}: ${missing.join(", ")} never served in ${samples} ` +
          `samples (${split}).`,
      });
    } else {
      items.push({
        status: "warn",
        text:
          `${node.label}: ${missing.join(", ")} not served yet in ${samples} ` +
          `samples (${split}); raise the maximum to confirm.`,
      });
    }
  }

  for (const warning of warnings) {
    items.push({ status: "warn", text: `Strategy: ${warning}` });
  }

  const hasFailure = items.some((item) => item.status === "fail");
  const inconclusive =
    !verified.length ||
    items.some(
      (item) => item.status === "warn" && !item.text.startsWith("Strategy: "),
    );
  const verdict = hasFailure ? "mismatch" : inconclusive ? "inconclusive" : "match";
  const headline = {
    match: warnings.length
      ? "Results match the strategy as configured, but the strategy has warnings"
      : "Results match the strategy",
    mismatch:
      outsideFeed.length && !outside.length
        ? "Tags follow the strategy, but the strategy does not match the feed"
        : "Results do not match the strategy",
    inconclusive: "Results are inconclusive",
  }[verdict];
  return { verdict, headline, items };
}
