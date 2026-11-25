import {
  getFeedLineIds,
  getDynamicFeedContext,
  getTagRunBlockers,
  getTagTargets,
  getStrategyOverview,
  getStrategySummary,
  getStrategyAdSizes,
  getStrategyVariantGroups,
  getTimeOfDayPlan,
  getExpectedStrategyVariants,
  summarizeTagVerification,
  compareTagResultToFeed,
  getClosestVariantId,
  parseCsv,
  applyFeedMappings,
  getTagVerificationRows,
  addStoredVariantContent,
  parseLineIds,
} from "./simulator-core.mjs";

const params = new URLSearchParams(location.search);
const sourceTabIdValue = params.get("sourceTabId");
const sourceTabId = Number(sourceTabIdValue);
const contextElement = document.getElementById("context");
const strategyAnalysisSection = document.getElementById("strategy-analysis");
const strategyFlowElement = document.getElementById("strategy-flow");
const strategyAnalysisFlowElement = document.getElementById(
  "strategy-analysis-flow",
);
const strategyModeButton = document.getElementById("mode-strategy");
const tagsModeButton = document.getElementById("mode-tags");
const tagsModeDetail = document.getElementById("mode-tags-detail");
const tagRunBlockedElement = document.getElementById("tag-run-blocked");
const tagResultsEmpty = document.getElementById("tag-results-empty");
const tagResultsHeading = document.getElementById("tag-results-heading");
const strategyBranchesElement = document.getElementById("strategy-branches");
const tagWorkspaceSection = document.getElementById("tag-workspace");
const tagVerificationSection = document.getElementById("tag-verification");
const tagSampleCountInput = document.getElementById("tag-sample-count");
const tagAcceptClosestInput = document.getElementById("tag-accept-closest");
let tagRun = null;
const tagSizeSelect = document.getElementById("tag-size");
const verifyTagButton = document.getElementById("verify-tag");
const tagRunSummaryElement = document.getElementById("tag-run-summary");
const tagSummarySection = document.getElementById("tag-summary");
const tagProgressSection = document.getElementById("tag-progress");
const tagProgressPhase = document.getElementById("tag-progress-phase");
const tagProgressCount = document.getElementById("tag-progress-count");
const tagProgressBar = document.getElementById("tag-progress-bar");
const tagProgressDetail = document.getElementById("tag-progress-detail");
const tagProgressMatch = document.getElementById("tag-progress-match");
const tagProgressOutside = document.getElementById("tag-progress-outside");
const tagProgressUnverified = document.getElementById("tag-progress-unverified");
const tagProgressOutsideFeed = document.getElementById(
  "tag-progress-outside-feed",
);
const tagProgressElapsed = document.getElementById("tag-progress-elapsed");
const tagSummaryHeadline = document.getElementById("tag-summary-headline");
const tagSummaryItems = document.getElementById("tag-summary-items");
const tagTimeWarningElement = document.getElementById("tag-time-warning");
const tagStatusElement = document.getElementById("tag-status");
const tagRuntimeElement = document.getElementById("tag-runtime");
const tagResultsSection = document.getElementById("tag-results");
const tagResultsBody = document.getElementById("tag-results-body");
const tagResponseDetails = document.getElementById("tag-response-details");
const tagDistributionsSection = document.getElementById("tag-distributions");
const tagDistributionsBody = document.getElementById("tag-distributions-body");

let tagVerificationData = null;
const TAG_TIMEOUT_MS = 30_000;
const MAX_SAMPLES_PER_NODE = 100;

function setTagStatus(message, isError = false) {
  tagStatusElement.textContent = message;
  tagStatusElement.dataset.error = String(isError);
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function getProductionTagConfig(width, height) {
  const advertiserId = Number(params.get("advertiserId"));
  const campaignId = Number(params.get("campaignId"));
  const adsetId = Number(params.get("adsetId"));
  if (![advertiserId, campaignId, adsetId].every(Number.isSafeInteger)) {
    throw new Error("The adset IDs are not valid for production-tag verification.");
  }
  if (
    ![width, height].every(Number.isSafeInteger) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("The selected ad size is invalid.");
  }

  return encodeBase64(
    JSON.stringify({
      adserver: { code: "lemonpi" },
      adsetType: "display",
      campaignId,
      workflow: "ad-variants",
      advertiserId,
      adsetFallbackUrl:
        `https://creative-content.lemonpi.io/adset/fallback/${advertiserId}/` +
        `${adsetId}-${width}-${height}.json`,
      environment: "prod",
      contentType: "content-feed",
      adsetId,
      version: 2,
    }),
  );
}

async function fetchFeedRows(feed) {
  if (!isSupportedFeedCsv(feed.sourceUrl)) {
    throw new Error(
      "This prototype supports published Google Sheets and uploaded CSV feeds.",
    );
  }
  const label = feed.name || `feed ${feed.id}`;
  const response = await fetch(feed.sourceUrl, {
    cache: "no-store",
    credentials: "omit",
  });
  if (!response.ok) {
    throw new Error(`Could not read ${label} (HTTP ${response.status}).`);
  }
  const finalHost = new URL(response.url).hostname;
  if (
    finalHost !== "docs.google.com" &&
    finalHost !== "assets.lemonpi.io" &&
    !finalHost.endsWith(".googleusercontent.com")
  ) {
    throw new Error(`${label} redirected to an unsupported host.`);
  }
  const tooLarge = new Error(`${label} is larger than the 5 MB prototype limit.`);
  if (Number(response.headers.get("content-length") || 0) > 5_000_000) {
    throw tooLarge;
  }
  const csv = await response.text();
  if (new TextEncoder().encode(csv).length > 5_000_000) throw tooLarge;
  return applyFeedMappings(parseCsv(csv), feed.mappings);
}

function isSupportedFeedCsv(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.hostname === "assets.lemonpi.io") return url.pathname.endsWith(".csv");
    return (
      url.hostname === "docs.google.com" &&
      url.pathname.startsWith("/spreadsheets/d/") &&
      url.pathname.endsWith("/pub") &&
      url.searchParams.get("output") === "csv"
    );
  } catch {
    return false;
  }
}

async function loadTagVerificationData() {
  if (
    sourceTabIdValue === null ||
    !Number.isInteger(sourceTabId) ||
    sourceTabId < 0
  ) {
    throw new Error("The source adset tab could not be identified.");
  }

  const response = await chrome.tabs.sendMessage(sourceTabId, {
    action: "loadDecisionSimulatorData",
  });
  if (!response?.success) {
    throw new Error(response?.error || "Could not load adset feed configuration.");
  }

  const data = response.data;
  if (!data?.tree || !data?.feed?.sourceUrl) {
    throw new Error("The source tab returned incomplete tag verification data.");
  }
  const adSizes = getStrategyAdSizes(data.tree);
  if (!adSizes.length) {
    throw new Error("The decision tree contains no configured ad sizes.");
  }
  const context = getDynamicFeedContext(data.tree);
  const lookupRows = await fetchFeedRows(data.feed);
  const missingFields = [context.inputField, context.valueField].filter(
    (field) => !Object.hasOwn(lookupRows[0] || {}, field),
  );
  if (missingFields.length) {
    throw new Error(`Feed is missing required columns: ${missingFields.join(", ")}.`);
  }

  const contentFeed = data.contentFeed ?? null;
  const feedRows = getTagVerificationRows({
    lookupRows,
    contentRows: contentFeed ? await fetchFeedRows(contentFeed) : null,
    context,
    tree: data.tree,
    contentFeedLabel: contentFeed?.name || contentFeed?.id,
  });

  const lineIds = getFeedLineIds(lookupRows, context.inputField);
  if (!lineIds.length) {
    throw new Error(`The feed contains no keys in "${context.inputField}".`);
  }
  if (lineIds.length > 10000) {
    throw new Error("The feed has more than 10,000 unique keys.");
  }
  const feedVariantsByKey = new Map(lineIds.map((key) => [key, new Set()]));
  for (const row of feedRows) {
    const variantId = String(row.variant_id ?? "").trim();
    for (const key of parseLineIds(row[context.inputField])) {
      if (variantId) feedVariantsByKey.get(key)?.add(variantId);
    }
  }
  const tagRunBlockers = getTagRunBlockers(data.tree, context);
  const { targets, untested } = tagRunBlockers.length
    ? { targets: [], untested: [] }
    : getTagTargets(data.tree, context, lookupRows);
  return {
    ...data,
    feedRows,
    comparisonRows: addStoredVariantContent(feedRows, data.tree),
    contentFeed,
    context,
    tagRunBlockers,
    lineIds,
    adSizes,
    targets: targets.map((target) => ({
      ...target,
      feedVariants: [...(feedVariantsByKey.get(target.key) || [])],
    })),
    untestedOutcomes: untested,
  };
}

const resultTables = [
  document.getElementById("tag-distributions-table"),
  document.getElementById("tag-results-table"),
];

function showResultColumn(column) {
  const key = column === "time" ? "hideTime" : "hideSample";
  for (const table of resultTables) table.dataset[key] = "false";
}

function appendCell(row, value, className) {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  row.appendChild(cell);
}

function createStrategyVariantGroup(label, variants) {
  const group = document.createElement("div");
  group.className = "strategy-variant-group";

  const heading = document.createElement("strong");
  heading.textContent = label;
  const values = document.createElement("p");
  values.textContent = variants.length ? variants.join(" · ") : "None";

  group.append(heading, values);
  return group;
}

function getStrategyNodeLabel(node) {
  if (node.label.trim()) return node.label;
  const labels = {
    "date-time": "Date & Time",
  };
  return labels[node.type] || node.type.replaceAll("-", " ") || "Strategy node";
}

function createStrategyNodeList(nodes) {
  const list = document.createElement("ul");
  list.className = "strategy-node-list";
  for (const node of nodes) {
    const item = document.createElement("li");
    item.className = "strategy-node";
    const heading = document.createElement("span");
    heading.className = "strategy-node-label";
    heading.textContent = getStrategyNodeLabel(node);
    item.appendChild(heading);

    if (node.variants.length) {
      const variants = document.createElement("span");
      variants.className = "strategy-node-variants";
      variants.textContent = `Variants: ${node.variants.join(" · ")}`;
      item.appendChild(variants);
    }
    if (node.children.length) {
      item.appendChild(createStrategyNodeList(node.children));
    }
    list.appendChild(item);
  }
  return list;
}

function createStrategyPathGroup(nodes, directVariants) {
  const group = document.createElement("div");
  group.className = "strategy-variant-group strategy-path";
  const heading = document.createElement("strong");
  heading.textContent = "Strategy path";
  group.appendChild(heading);

  if (directVariants.length) {
    const direct = document.createElement("p");
    direct.textContent = `Direct variants: ${directVariants.join(" · ")}`;
    group.appendChild(direct);
  }
  if (nodes.length) {
    group.appendChild(createStrategyNodeList(nodes));
  } else if (!directVariants.length) {
    const empty = document.createElement("p");
    empty.textContent = "No connected nodes or direct variants";
    group.appendChild(empty);
  }
  return group;
}

function createStrategyCard({
  audience,
  outcomeLabel,
  strategyVariants,
  directStrategyVariants = [],
  strategyNodes = null,
  feedVariants,
  status,
  statusLabel,
}) {
  const card = document.createElement("article");
  card.className = "strategy-branch";
  card.dataset.status = status;

  const heading = document.createElement("div");
  heading.className = "strategy-branch-heading";
  const audienceHeading = document.createElement("h3");
  audienceHeading.textContent = audience;
  const badge = document.createElement("span");
  badge.className = "strategy-badge";
  badge.textContent = statusLabel;
  heading.append(audienceHeading, badge);

  const outcome = document.createElement("p");
  outcome.className = "strategy-outcome";
  outcome.textContent = `Strategy outcome: ${outcomeLabel}`;

  const variants = document.createElement("div");
  variants.className = "strategy-variant-groups";
  variants.append(
    strategyNodes
      ? createStrategyPathGroup(strategyNodes, directStrategyVariants)
      : createStrategyVariantGroup("Strategy variants", strategyVariants),
    createStrategyVariantGroup("Feed variants", feedVariants),
  );

  card.append(heading, outcome, variants);
  return card;
}

const strategyFilterStatus = document.getElementById("strategy-filter-status");
const strategyFilterPath = document.getElementById("strategy-filter-path");
const strategyFilterPathField = document.getElementById(
  "strategy-filter-path-field",
);
const strategyFilterSearch = document.getElementById("strategy-filter-search");
const strategyFilterCount = document.getElementById("strategy-filter-count");
let strategyOverviewState = null;

const compareLabels = (first, second) =>
  String(first).localeCompare(String(second), undefined, {
    numeric: true,
    sensitivity: "base",
  });

function getBranchStatus(branch) {
  if (!branch.feedRowCount) return { status: "missing", label: "No feed rows" };
  return branch.matchesFeed
    ? { status: "match", label: "Matches feed" }
    : { status: "mismatch", label: "Mismatch" };
}

function renderStrategyOverview(overview, lineIdCount, keyLabel = "line ID") {
  strategyFlowElement.textContent = getStrategySummary(
    overview,
    lineIdCount,
    keyLabel,
  );
  strategyAnalysisFlowElement.textContent = strategyFlowElement.textContent;

  // Repeated feed copies: group by the path to each copy, then sort by outcome.
  const grouped = overview.branches.some((branch) => branch.pathLabel);
  const branches = overview.branches.map((branch) => ({
    ...branch,
    ...getBranchStatus(branch),
  }));
  if (grouped) {
    branches.sort(
      (first, second) =>
        compareLabels(first.pathLabel, second.pathLabel) ||
        compareLabels(first.outcomeLabel, second.outcomeLabel) ||
        compareLabels(first.audience, second.audience),
    );
  }
  const unhandled = overview.unhandledAudiences.map((audience) => ({
    audience: audience.audience,
    outcomeLabel: `${overview.fallback.label} (root fallback)`,
    pathLabel: "",
    strategyVariants: overview.fallback.strategyVariants,
    feedVariants: audience.feedVariants,
    status: "fallback",
    label: "Uses fallback",
  }));
  strategyOverviewState = { overview, keyLabel, grouped, branches, unhandled };

  const paths = [...new Set(branches.map((branch) => branch.pathLabel))].filter(
    Boolean,
  );
  strategyFilterPath.replaceChildren(new Option("All paths", "all"));
  for (const path of paths) strategyFilterPath.appendChild(new Option(path, path));
  strategyFilterPathField.hidden = !grouped;
  renderStrategyTotals([...branches, ...unhandled], grouped);
  renderStrategyBranches();
}

// Overall result across every outcome, independent of the active filters.
function renderStrategyTotals(allBranches, grouped) {
  const count = (status) =>
    allBranches.filter((branch) => branch.status === status).length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const matching = count("match");
  const notMatching = allBranches.length - matching;
  const container = document.getElementById("strategy-totals");
  container.dataset.status = notMatching ? "mismatch" : "match";
  document.getElementById("strategy-totals-headline").textContent = notMatching
    ? `${notMatching} of ${plural(allBranches.length, "outcome")} not matching the feed`
    : `All ${plural(allBranches.length, "outcome")} match the feed`;

  const items = [
    `${matching} match feed`,
    count("mismatch") && `${count("mismatch")} mismatch`,
    count("missing") && `${count("missing")} with no feed rows`,
    count("fallback") && `${plural(count("fallback"), "feed audience")} using the root fallback`,
  ].filter(Boolean);
  if (grouped) {
    const paths = [...new Set(allBranches.map((b) => b.pathLabel).filter(Boolean))];
    const pathsWithIssues = paths.filter((path) =>
      allBranches.some((b) => b.pathLabel === path && b.status !== "match"),
    );
    items.push(
      `${pathsWithIssues.length} of ${plural(paths.length, "path")} affected` +
        (pathsWithIssues.length && pathsWithIssues.length < paths.length
          ? `: ${pathsWithIssues.join(", ")}`
          : ""),
    );
    // Outcomes that mismatch under every path point at a feed-wide issue.
    const issuesByOutcome = new Map();
    for (const b of allBranches) {
      if (b.status === "match" || !b.pathLabel) continue;
      issuesByOutcome.set(b.outcomeLabel, (issuesByOutcome.get(b.outcomeLabel) || 0) + 1);
    }
    const everywhere = [...issuesByOutcome]
      .filter(([, n]) => n === paths.length && paths.length > 1)
      .map(([label]) => label)
      .sort(compareLabels);
    if (everywhere.length) {
      items.push(`Not matching under every path: ${everywhere.join(", ")}`);
    }
  }
  document.getElementById("strategy-totals-items").replaceChildren(
    ...items.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
  container.hidden = false;
}

function branchMatchesFilters(branch, { status, path, query }) {
  if (status !== "all" && branch.status !== status) return false;
  if (path !== "all" && branch.pathLabel !== path) return false;
  if (!query) return true;
  return [
    branch.audience,
    branch.outcomeLabel,
    ...(branch.strategyVariants || []),
    ...(branch.feedVariants || []),
  ].some((value) => String(value).toLowerCase().includes(query));
}

function renderStrategyBranches() {
  if (!strategyOverviewState) return;
  const { overview, keyLabel, grouped, branches, unhandled } =
    strategyOverviewState;
  const filters = {
    status: strategyFilterStatus.value,
    path: strategyFilterPath.value,
    query: strategyFilterSearch.value.trim().toLowerCase(),
  };
  const filtersActive =
    filters.status !== "all" || filters.path !== "all" || Boolean(filters.query);
  const visibleBranches = branches.filter((branch) =>
    branchMatchesFilters(branch, filters),
  );
  const visibleUnhandled = unhandled.filter((branch) =>
    branchMatchesFilters(branch, filters),
  );
  const total = branches.length + unhandled.length;
  const shown = visibleBranches.length + visibleUnhandled.length;
  strategyFilterCount.textContent = filtersActive
    ? `Showing ${shown} of ${total} outcome(s).`
    : `${total} outcome(s).`;
  strategyBranchesElement.replaceChildren();

  let currentPath = null;
  for (const branch of visibleBranches) {
    if (grouped && branch.pathLabel !== currentPath) {
      currentPath = branch.pathLabel;
      const pathBranches = visibleBranches.filter(
        (item) => item.pathLabel === currentPath,
      );
      const mismatches = pathBranches.filter(
        (item) => item.status !== "match",
      ).length;
      const heading = document.createElement("h3");
      heading.className = "strategy-group-heading";
      heading.textContent =
        `${currentPath || "Strategy"} · ${pathBranches.length} outcome(s)` +
        (mismatches ? ` · ${mismatches} not matching feed` : " · all match feed");
      heading.dataset.status = mismatches ? "mismatch" : "match";
      strategyBranchesElement.appendChild(heading);
    }
    strategyBranchesElement.appendChild(
      createStrategyCard({
        audience: branch.audience,
        outcomeLabel: branch.outcomeLabel,
        strategyVariants: branch.strategyVariants,
        directStrategyVariants: branch.directStrategyVariants,
        strategyNodes: branch.strategyNodes,
        feedVariants: branch.feedVariants,
        status: branch.status,
        statusLabel: branch.label,
      }),
    );
  }

  for (const branch of visibleUnhandled) {
    strategyBranchesElement.appendChild(
      createStrategyCard({
        audience: branch.audience,
        outcomeLabel: branch.outcomeLabel,
        strategyVariants: branch.strategyVariants,
        feedVariants: branch.feedVariants,
        status: branch.status,
        statusLabel: branch.label,
      }),
    );
  }

  if (filtersActive && !shown) {
    const empty = document.createElement("p");
    empty.className = "muted strategy-filter-empty";
    empty.textContent = "No outcomes match these filters.";
    strategyBranchesElement.appendChild(empty);
  }
  if (filtersActive) return;

  const fallback = document.createElement("article");
  fallback.className = "strategy-fallback";
  const fallbackHeading = document.createElement("h3");
  fallbackHeading.textContent = "Root fallback";
  const fallbackDescription = document.createElement("p");
  fallbackDescription.textContent =
    `Used when a ${keyLabel} is not in the feed or no audience outcome matches.`;
  fallback.append(
    fallbackHeading,
    fallbackDescription,
    createStrategyVariantGroup(
      "Strategy variants",
      overview.fallback.strategyVariants,
    ),
  );
  strategyBranchesElement.appendChild(fallback);
}

function createTagMatchEvidence(match) {
  const details = document.createElement("details");
  details.className = "tag-match-evidence";
  const summary = document.createElement("summary");
  summary.textContent = "Show field-by-field evidence";
  details.appendChild(summary);

  const explanation = document.createElement("p");
  explanation.textContent =
    "The tag response has no variant ID. The strategy checker compares its returned content values " +
    "against every feed variant after normalizing whitespace, so a response can match a variant " +
    "assigned to a different audience. Exact matches include every returned field. A partial " +
    "candidate has no conflicting comparable fields, but one or more tag fields are absent from " +
    "the feed, so it is not a confirmed ID.";
  details.appendChild(explanation);

  const contentHeading = document.createElement("strong");
  contentHeading.textContent =
    `Returned tag content (${match.contentFields.length} field(s))`;
  details.appendChild(contentHeading);
  if (match.contentFields.length) {
    const contentList = document.createElement("ul");
    for (const { field, value } of match.contentFields) {
      const item = document.createElement("li");
      item.textContent = `${field}: ${value || "(empty)"}`;
      contentList.appendChild(item);
    }
    details.appendChild(contentList);
  } else {
    const empty = document.createElement("p");
    empty.textContent = "No content fields were returned by the tag.";
    details.appendChild(empty);
  }

  const candidatesHeading = document.createElement("strong");
  candidatesHeading.textContent =
    `Feed-wide comparisons (${match.candidates.length} candidate variant(s))`;
  details.appendChild(candidatesHeading);
  if (!match.candidates.length) {
    const empty = document.createElement("p");
    empty.textContent = "No feed variants were found for this line ID.";
    details.appendChild(empty);
    return details;
  }

  const candidateList = document.createElement("div");
  candidateList.className = "tag-candidate-list";
  for (const candidate of match.candidates) {
    const item = document.createElement("article");
    item.className = "tag-candidate";
    const heading = document.createElement("strong");
    heading.textContent =
      `${candidate.variantId}: ${candidate.matches}/${candidate.total} returned field(s) match` +
      (candidate.exact
        ? " exactly."
        : candidate.compatible
          ? ` with no conflicting fields; ${candidate.missingFields.length} absent from feed.`
          : `; ${candidate.differingFields.length} differ and ` +
            `${candidate.missingFields.length} are absent from feed.`);
    item.appendChild(heading);

    const source = document.createElement("p");
    const keys = candidate.sourceLineIds;
    source.textContent =
      `Feed audience(s): ${candidate.sourceAudiences.join(", ") || "—"}; ` +
      `feed key(s): ${keys.slice(0, 10).join(", ") || "—"}` +
      (keys.length > 10 ? ` and ${keys.length - 10} more` : "");
    item.appendChild(source);

    if (candidate.matchedFields.length) {
      const matched = document.createElement("p");
      matched.textContent = `Matching fields: ${candidate.matchedFields.join(", ")}`;
      item.appendChild(matched);
    }
    if (candidate.differingFields.length) {
      const differences = document.createElement("ul");
      for (const difference of candidate.differingFields) {
        const detail = document.createElement("li");
        detail.textContent =
          `${difference.field}: tag returned "${difference.tagValue}", ` +
          `feed has "${difference.feedValue}".`;
        differences.appendChild(detail);
      }
      item.appendChild(differences);
    }
    if (candidate.missingFields.length) {
      const missing = document.createElement("p");
      missing.textContent =
        `Not present in the feed: ${candidate.missingFields.join(", ")}`;
      item.appendChild(missing);
    }
    candidateList.appendChild(item);
  }
  details.appendChild(candidateList);
  return details;
}

function getScenarioLabel(scenario) {
  return scenario ? `${scenario.time} (${scenario.label})` : "Current time";
}

// The feed comparison is stored with the raw response so verdicts can be
// re-evaluated (e.g. toggling closest-match acceptance) without rerunning tags.
function createTagSample(request, sampleNumber, response, error = null, group = null) {
  const { target, size, scenario } = request;
  const timeLabel = scenario ? ` at ${scenario.time}` : "";
  return {
    request,
    sampleNumber,
    response,
    error,
    group,
    label:
      `${target.label} (${size.width}×${size.height}${timeLabel}, ` +
      `sample ${sampleNumber})`,
    expectedVariants: getExpectedVariantsForRequest(request),
    match: compareTagResultToFeed(
      response,
      tagVerificationData.comparisonRows,
      tagVerificationData.context.inputField,
      tagVerificationData.context.valueField,
    ),
  };
}

function evaluateTagSample(
  { request: { target }, response, error, match },
  acceptClosest = tagAcceptClosestInput.checked,
) {
  const exactVariants = match.exactVariantIds;
  const partialVariants = match.partialVariantIds;
  const closest = match.candidates[0];
  const closestId =
    acceptClosest && !error && exactVariants.length !== 1
      ? getClosestVariantId(match)
      : null;
  const identifiedVariant =
    exactVariants.length === 1
      ? { id: exactVariants[0], exact: true }
      : closestId
        ? { id: closestId, exact: true, closest: true }
        : exactVariants.length === 0 && partialVariants.length === 1
          ? { id: partialVariants[0], exact: false }
          : null;
  const servedVariant =
    identifiedVariant?.closest
      ? `Closest match: ${closestId} (${closest.matches}/${closest.total} fields agree)`
      : identifiedVariant?.exact
      ? identifiedVariant.id
      : exactVariants.length > 1
        ? `Ambiguous exact match: ${exactVariants.join(", ")}`
        : identifiedVariant
          ? `Partial match: ${identifiedVariant.id} ` +
            `(${closest.matches}/${closest.total} fields agree)`
          : partialVariants.length > 1
            ? `Ambiguous partial match: ${partialVariants.join(", ")}`
        : error
          ? error
          : closest
            ? `No exact match; closest is ${closest.variantId} ` +
              `(${closest.matches}/${closest.total} fields)`
          : response?.fallbackUsed
            ? "Fallback used; variant not verified"
            : "No feed variant could be compared";
  const matchesFeed =
    Boolean(identifiedVariant) &&
    target.feedVariants.includes(identifiedVariant.id);

  let check = "Variant not verified";
  let checkState = null;
  if (identifiedVariant?.closest) {
    check = matchesFeed
      ? "Closest match in feed expectation"
      : "Closest match outside feed expectation";
    checkState = matchesFeed ? "match" : "mismatch";
  } else if (identifiedVariant?.exact) {
    check = matchesFeed
      ? "Matches feed expectation"
      : "Outside feed expectation";
    checkState = matchesFeed ? "match" : "mismatch";
  } else if (identifiedVariant) {
    check = matchesFeed
      ? "Partial candidate in feed expectation (unconfirmed)"
      : "Partial candidate outside feed expectation (unconfirmed)";
    checkState = "partial";
  } else if (response?.fallbackUsed) {
    check = "Production fallback was used";
    checkState = "mismatch";
  }

  return {
    match,
    servedVariant,
    check,
    checkState,
    identified: Boolean(identifiedVariant),
    exact: identifiedVariant?.exact || false,
    closest: identifiedVariant?.closest || false,
    matchesFeed,
    variantId: identifiedVariant?.id || null,
  };
}

function renderTagResult(sample) {
  const { request, sampleNumber, response } = sample;
  const { target, size, scenario } = request;
  const outcome = evaluateTagSample(sample);
  const row = document.createElement("tr");
  if (outcome.checkState) row.dataset.tagCheck = outcome.checkState;
  appendCell(row, target.label);
  appendCell(row, `${size.width}×${size.height}`);
  appendCell(row, getScenarioLabel(scenario), "col-time");
  appendCell(row, String(sampleNumber), "col-sample");
  if (sampleNumber > 1) showResultColumn("sample");
  const variantCell = document.createElement("td");
  variantCell.textContent = outcome.servedVariant;
  variantCell.appendChild(createTagMatchEvidence(outcome.match));
  if (response?.requestContext) {
    const sent = Object.entries(response.requestContext)
      .filter(([key]) => !key.startsWith("$request."))
      .map(([key, value]) => `${key.split(".").pop()}=${value}`);
    const missing = Object.entries(target.signals || {})
      .filter(([key, value]) => response.requestContext[key] !== value)
      .map(([key]) => key);
    const sentLine = document.createElement("p");
    sentLine.className = "tag-request-context";
    sentLine.textContent =
      `Sent: ${sent.join(", ") || "no signals"}` +
      (missing.length ? ` — not sent as simulated: ${missing.join(", ")}` : "");
    variantCell.appendChild(sentLine);
  }
  row.appendChild(variantCell);
  appendCell(row, target.feedVariants.join(", ") || "—");
  appendCell(row, outcome.check);
  tagResultsBody.appendChild(row);
  return row;
}

function getTagChecks() {
  return (tagRun?.samples || []).map((sample) => {
    const outcome = evaluateTagSample(sample);
    return {
      label: sample.label,
      exact: outcome.exact,
      closest: outcome.closest,
      variantId: outcome.variantId,
      expectedVariants: sample.expectedVariants,
      feedVariants: sample.request.target.feedVariants,
    };
  });
}

function updateTagProgressCounts() {
  const checks = getTagChecks();
  const verified = checks.filter((check) => check.exact);
  const matching = verified.filter((check) =>
    check.expectedVariants.includes(check.variantId),
  ).length;
  tagProgressMatch.textContent = String(matching);
  tagProgressOutside.textContent = String(verified.length - matching);
  tagProgressOutsideFeed.textContent = String(
    verified.filter((check) => !check.feedVariants.includes(check.variantId))
      .length,
  );
  tagProgressUnverified.textContent = String(checks.length - verified.length);
}

// Routing samples join the strategy node of the variant they served; extra
// samples belong to the node they were taken for.
function groupTagSamplesByNode(samples) {
  const nodes = new Map();
  for (const sample of samples) {
    let group = sample.group;
    if (!group) {
      const outcome = evaluateTagSample(sample);
      if (!outcome.exact) continue;
      group = getStrategyGroupForVariant(sample.request, outcome.variantId);
      if (!group) continue;
    }
    if (!nodes.has(group)) {
      nodes.set(group, { request: sample.request, requests: [], samples: [] });
    }
    const node = nodes.get(group);
    if (!sample.group) node.requests.push(sample.request);
    node.samples.push(sample);
  }
  return nodes;
}

function renderTagRunOutcome() {
  const nodes = groupTagSamplesByNode(tagRun.samples);
  tagDistributionsBody.replaceChildren();
  tagDistributionsSection.hidden = true;
  for (const [group, node] of nodes) renderTagDistribution(node, group);
  renderTagSummary(
    summarizeTagVerification({
      checks: getTagChecks(),
      nodes: [...nodes]
        .filter(([group]) => group.multiVariant)
        .map(([group, node]) => ({
          label: getGroupLabel(group, node.request),
          variants: group.variants,
          observedVariantIds: node.samples
            .map((sample) => evaluateTagSample(sample))
            .filter((outcome) => outcome.exact)
            .map((outcome) => outcome.variantId),
        })),
      sampleLimit: tagRun.requestedSamples,
      warnings: tagVerificationData.timePlan.warnings,
    }),
  );
}

// Re-renders stored results with the current options, keeping open evidence.
function rerenderTagRun() {
  if (!tagRun?.samples.length) return;
  const openDetails = [...tagResultsBody.rows].map((row) =>
    [...row.querySelectorAll("details")].map((details) => details.open),
  );
  tagResultsBody.replaceChildren();
  tagRun.samples.forEach((sample, index) => {
    renderTagResult(sample)
      .querySelectorAll("details")
      .forEach((details, detailIndex) => {
        details.open = openDetails[index]?.[detailIndex] ?? details.open;
      });
  });
  updateTagProgressCounts();
  if (tagRun.complete) renderTagRunOutcome();
}

function getStrategyGroupKey(size, scenario) {
  return `${size.width}x${size.height}@${scenario?.minute ?? "now"}`;
}

function getGroupLabel(group, { size, scenario }) {
  const path = group.audience ? `${group.audience} → ${group.path}` : group.path;
  const time = scenario ? `, ${scenario.time}` : "";
  return `${path} (${size.width}×${size.height}${time})`;
}

function getExpectedVariantsForRequest({ target, size, scenario }) {
  return getExpectedStrategyVariants(
    tagVerificationData.strategyVariantGroups.get(
      getStrategyGroupKey(size, scenario),
    ) || [],
    target.audiences,
    target.feedNodeId,
  );
}

function renderTagSummary(summary) {
  tagSummarySection.dataset.verdict = summary.verdict;
  tagSummaryHeadline.textContent = summary.headline;
  tagSummaryItems.replaceChildren(
    ...summary.items.map((item) => {
      const element = document.createElement("li");
      element.dataset.status = item.status;
      element.textContent = item.text;
      return element;
    }),
  );
  tagSummarySection.hidden = false;
}

function formatElapsed(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function getMaxExtraSamples(sampleLimit) {
  return (
    getTimeScenarios()
      .flatMap((scenario) =>
        getSelectedAdSizes().flatMap(
          (size) =>
            tagVerificationData.strategyVariantGroups.get(
              getStrategyGroupKey(size, scenario),
            ) || [],
        ),
      )
      .filter((group) => group.multiVariant).length *
    (sampleLimit - 1)
  );
}

function getStrategyGroupForVariant({ target, size, scenario }, variantId) {
  const groups =
    tagVerificationData.strategyVariantGroups.get(
      getStrategyGroupKey(size, scenario),
    ) || [];
  const matches = groups.filter(
    (group) =>
      (group.audience === null ||
        (target.audiences.includes(group.audience) &&
          group.feedNodeId === target.feedNodeId)) &&
      group.variants.includes(variantId),
  );
  return matches.length === 1 ? matches[0] : null;
}

function renderTagDistribution({ request, requests, samples }, group) {
  const { size, scenario } = request;
  const outcomes = samples.map((sample) => evaluateTagSample(sample));
  const counts = new Map(group.variants.map((variant) => [variant, 0]));
  let unmatched = 0;
  for (const outcome of outcomes) {
    if (outcome.exact && counts.has(outcome.variantId)) {
      counts.set(outcome.variantId, counts.get(outcome.variantId) + 1);
    } else {
      unmatched++;
    }
  }

  const row = document.createElement("tr");
  const nodeRequests = requests.length ? requests : [request];
  appendCell(
    row,
    [...new Set(nodeRequests.map(({ target }) => target.label))].join(", "),
  );
  appendCell(row, `${size.width}×${size.height}`);
  appendCell(row, getScenarioLabel(scenario), "col-time");
  appendCell(row, group.audience ? `${group.audience} → ${group.path}` : group.path);
  appendCell(row, group.variants.join(", "));
  appendCell(row, String(outcomes.length), "col-sample");
  const observed = group.variants.map((variant) => {
    const count = counts.get(variant);
    const percentage = Math.round((count / outcomes.length) * 100);
    return `${variant}: ${count}/${outcomes.length} (${percentage}%)`;
  });
  if (unmatched) observed.push(`Other/unmatched: ${unmatched}/${outcomes.length}`);
  appendCell(row, observed.join(" · "));
  tagDistributionsBody.appendChild(row);
  tagDistributionsSection.hidden = false;
}

function runProductionTag({ target, size, scenario }) {
  const requestId = crypto.randomUUID();
  const config = getProductionTagConfig(size.width, size.height);
  tagRuntimeElement.hidden = false;

  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.title =
      `Production tag for ${target.label} at ${size.width}x${size.height}`;
    frame.addEventListener(
      "load",
      () => {
        frame.contentWindow.postMessage(
          {
            type: "co-plus-run-production-tag",
            requestId,
            signals: target.signals,
            width: size.width,
            height: size.height,
            simulatedMinute: scenario?.minute ?? null,
            encodedConfig: config,
          },
          "*",
        );
      },
      { once: true },
    );

    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for the production tag response."));
    }, TAG_TIMEOUT_MS);

    function onMessage(event) {
      if (
        event.source !== frame.contentWindow ||
        event.data?.type !== "co-plus-production-tag-result" ||
        event.data.requestId !== requestId
      ) {
        return;
      }

      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    }

    window.addEventListener("message", onMessage);
    frame.src =
      `${chrome.runtime.getURL("tag-verifier-sandbox.html")}` +
      `?request=${encodeURIComponent(requestId)}`;
    tagRuntimeElement.replaceChildren(frame);
  });
}

async function runProductionTagVerification() {
  if (!tagVerificationData) return;
  const requestedSamples = Number(tagSampleCountInput.value);
  if (
    !Number.isSafeInteger(requestedSamples) ||
    requestedSamples < 1 ||
    requestedSamples > MAX_SAMPLES_PER_NODE
  ) {
    tagSampleCountInput.setCustomValidity(
      `Enter a whole number from 1 to ${MAX_SAMPLES_PER_NODE}.`,
    );
    tagSampleCountInput.reportValidity();
    return;
  }
  tagSampleCountInput.setCustomValidity("");

  const targets = tagVerificationData.targets;
  const adSizes = getSelectedAdSizes();
  const scenarios = getTimeScenarios();
  const requests = scenarios.flatMap((scenario) =>
    targets.flatMap((target) =>
      getTargetAdSizes(target).map((size) => ({ target, size, scenario })),
    ),
  );

  verifyTagButton.disabled = true;
  tagSampleCountInput.disabled = true;
  tagSizeSelect.disabled = true;
  tagResultsBody.replaceChildren();
  tagDistributionsBody.replaceChildren();
  tagDistributionsSection.hidden = true;
  tagSummarySection.hidden = true;
  // Time and sample columns only appear when the run actually varies them.
  for (const table of resultTables) {
    table.dataset.hideTime = String(getTimeScenarios().every((s) => !s));
    table.dataset.hideSample = "true";
  }
  tagRun = { samples: [], requestedSamples, complete: false };
  let completedRequests = 0;
  tagResultsEmpty.hidden = true;
  tagProgressSection.hidden = false;
  tagResultsHeading.hidden = false;
  tagResultsHeading.textContent =
    tagSizeSelect.value === "all"
      ? "Production tag results"
      : `Production tag results — ${adSizes[0].width}×${adSizes[0].height} only`;
  tagResponseDetails.hidden = false;
  tagProgressSection.dataset.state = "running";
  const startedAt = Date.now();
  // The bar's maximum is an upper bound that shrinks as nodes finish early,
  // so the percentage only ever moves forward.
  let remainingUpperBound =
    requests.length + getMaxExtraSamples(requestedSamples);
  const updateProgress = ({ phase, detail = tagProgressDetail.textContent }) => {
    const total = completedRequests + remainingUpperBound;
    tagProgressPhase.textContent = phase;
    tagProgressCount.textContent =
      remainingUpperBound > 0
        ? `${completedRequests} tags · up to ${total}`
        : `${completedRequests} tags`;
    tagProgressBar.max = Math.max(total, 1);
    tagProgressBar.value = completedRequests;
    tagProgressDetail.textContent = detail;
    updateTagProgressCounts();
    tagProgressElapsed.textContent = formatElapsed(Date.now() - startedAt);
  };
  const elapsedTimer = setInterval(() => {
    tagProgressElapsed.textContent = formatElapsed(Date.now() - startedAt);
  }, 1000);
  let currentPhase = `Step 1 of 2 · Routing check (0 of ${requests.length})`;
  updateProgress({ phase: currentPhase, detail: "Starting…" });

  const runSample = async (request, sampleNumber, statusPrefix, group = null) => {
    const { target, size, scenario } = request;
    const detail =
      `${statusPrefix}${target.label} · ${size.width}×${size.height}` +
      `${scenario ? ` · ${scenario.time}` : ""}…`;
    setTagStatus("Running production tags…");
    updateProgress({ phase: currentPhase, detail });

    let response = null;
    let error = null;
    try {
      response = await runProductionTag(request);
      if (response.status < 200 || response.status >= 300) {
        error = `Production content request failed (HTTP ${response.status}).`;
      } else if (response.error) {
        error = response.error;
      }
    } catch (caught) {
      error = caught.message || String(caught);
    }

    const sample = createTagSample(request, sampleNumber, response, error, group);
    tagRun.samples.push(sample);
    renderTagResult(sample);
    completedRequests++;
    remainingUpperBound--;
    updateProgress({ phase: currentPhase });
    return sample;
  };

  try {
    // Each strategy node is sampled per size and time, pooling the line IDs
    // that route to it; groups are shared objects per size/time key.
    const nodeSamples = new Map();
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      currentPhase =
        `Step 1 of 2 · Routing check (${index + 1} of ${requests.length})`;
      await runSample(request, 1, "Running ");
    }
    // Grouped after routing so the closest-match option can change mid-run.
    for (const [group, node] of groupTagSamplesByNode(tagRun.samples)) {
      nodeSamples.set(group, node);
    }

    const multiVariantNodes = [...nodeSamples].filter(
      ([group]) => group.multiVariant,
    );
    // Sample each node until every assigned variant has been served or the
    // maximum is reached.
    const allVariantsServed = (group, node) => {
      const served = new Set(
        node.samples
          .map((sample) => evaluateTagSample(sample))
          .filter((outcome) => outcome.exact)
          .map((outcome) => outcome.variantId),
      );
      return group.variants.every((variant) => served.has(variant));
    };
    remainingUpperBound = multiVariantNodes.reduce(
      (sum, [group, node]) =>
        sum +
        (allVariantsServed(group, node)
          ? 0
          : Math.max(0, requestedSamples - node.samples.length)),
      0,
    );
    if (requestedSamples > 1) {
      for (let index = 0; index < multiVariantNodes.length; index++) {
        const [group, node] = multiVariantNodes[index];
        for (
          let sampleNumber = node.samples.length + 1;
          sampleNumber <= requestedSamples && !allVariantsServed(group, node);
          sampleNumber++
        ) {
          const request = node.requests[(sampleNumber - 1) % node.requests.length];
          currentPhase =
            `Step 2 of 2 · Variant sampling (node ${index + 1} of ` +
            `${multiVariantNodes.length})`;
          node.samples.push(
            await runSample(
              request,
              sampleNumber,
              `${group.audience ? `${group.audience} → ` : ""}${group.path} · ` +
                `sample ${sampleNumber} (max ${requestedSamples}) · `,
              group,
            ),
          );
        }
        // Drop the unused samples from the bound once a node is done early.
        remainingUpperBound = multiVariantNodes
          .slice(index + 1)
          .reduce(
            (sum, [nextGroup, nextNode]) =>
              sum +
              (allVariantsServed(nextGroup, nextNode)
                ? 0
                : Math.max(0, requestedSamples - nextNode.samples.length)),
            0,
          );
        updateProgress({ phase: currentPhase });
      }
    }
    tagProgressSection.dataset.state = "done";
    updateProgress({
      phase: "Complete",
      detail:
        `Ran ${completedRequests} tags in ` +
        `${formatElapsed(Date.now() - startedAt)}.`,
    });

    tagRun.complete = true;
    renderTagRunOutcome();
    setTagStatus("");
  } catch (error) {
    showRunError(error);
  } finally {
    clearInterval(elapsedTimer);
    tagSampleCountInput.disabled = false;
    tagSizeSelect.disabled = false;
    updateProductionTagButton();
  }
}

function getTimeScenarios() {
  const scenarios = tagVerificationData?.timePlan?.scenarios || [];
  return scenarios.length ? scenarios : [null];
}

function getSelectedAdSizes() {
  const sizes = tagVerificationData?.adSizes || [];
  return tagSizeSelect.value === "all"
    ? sizes
    : sizes.filter(
        ({ width, height }) => `${width}x${height}` === tagSizeSelect.value,
      );
}

// Only the selected sizes the target's branch serves; a target whose branch
// has no sized variants is run at every selected size.
function getTargetAdSizes(target) {
  const selected = getSelectedAdSizes();
  if (!target.adSizes?.length) return selected;
  const branchSizes = new Set(
    target.adSizes.map(({ width, height }) => `${width}x${height}`),
  );
  return selected.filter(({ width, height }) =>
    branchSizes.has(`${width}x${height}`),
  );
}

function getRoutingRequestCount() {
  return tagVerificationData.targets.reduce(
    (count, target) => count + getTargetAdSizes(target).length,
    0,
  );
}

function updateProductionTagButton() {
  const sampleCount = Number(tagSampleCountInput.value);
  const validSampleCount =
    Number.isSafeInteger(sampleCount) &&
    sampleCount >= 1 &&
    sampleCount <= MAX_SAMPLES_PER_NODE;
  tagSampleCountInput.setCustomValidity(
    validSampleCount
      ? ""
      : `Enter a whole number from 1 to ${MAX_SAMPLES_PER_NODE}.`,
  );
  const scenarioCount = getTimeScenarios().length;
  const requestCount = tagVerificationData
    ? getRoutingRequestCount() * scenarioCount
    : 0;
  const maximumRequests = validSampleCount
    ? requestCount + (tagVerificationData ? getMaxExtraSamples(sampleCount) : 0)
    : 0;
  verifyTagButton.textContent = validSampleCount
    ? `Run up to ${maximumRequests} tags`
    : "Enter a valid sample count";
  verifyTagButton.disabled =
    !tagVerificationData || !validSampleCount || requestCount === 0;

  if (!tagVerificationData) return;
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const sizes = getSelectedAdSizes()
    .map(({ width, height }) => `${width}×${height}`)
    .join(", ");
  const times = (tagVerificationData.timePlan.scenarios || [])
    .map((scenario) => scenario.time)
    .join(", ");
  const { targets, untestedOutcomes } = tagVerificationData;
  const sampledKeys = !/(^|\.)dsp-lineid$/.test(
    tagVerificationData.context.inputSource || "",
  );
  const selectedSizeCount = getSelectedAdSizes().length;
  const runTargets = targets.filter((target) => getTargetAdSizes(target).length);
  const sizeScoped = targets.some(
    (target) => getTargetAdSizes(target).length !== selectedSizeCount,
  );
  const otherSizeTargets = targets.length - runTargets.length;
  tagRunSummaryElement.textContent =
    (sampledKeys
      ? `${plural(runTargets.length, "outcome")} (one ` +
        `${tagVerificationData.context.inputSource.split(".").pop()} from the feed each)`
      : plural(runTargets.length, "line ID")) +
    (sizeScoped
      ? `, each only at its branch's size${selectedSizeCount === 1 ? "" : "s"} ` +
        `(${sizes}; ${plural(getRoutingRequestCount(), "tag")})`
      : ` × ${plural(selectedSizeCount, "size")} (${sizes})`) +
    (times ? ` × ${plural(scenarioCount, "time")} (${times})` : "") +
    "." +
    (otherSizeTargets
      ? ` ${plural(otherSizeTargets, sampledKeys ? "outcome" : "line ID")} ` +
        `not run: their branch serves no ${sizes} variants.`
      : "") +
    (untestedOutcomes.length
      ? ` ${plural(untestedOutcomes.length, "outcome")} skipped (no feed key ` +
        `maps only to it): ${untestedOutcomes.slice(0, 5).join(", ")}` +
        (untestedOutcomes.length > 5 ? ", …" : "") +
        "."
      : "");
}

function renderTimePlan(timePlan) {
  tagTimeWarningElement.textContent = timePlan.warnings.length
    ? `Strategy warning: ${timePlan.warnings.join(" ")} ` +
      "Overlapping outcomes may never serve, and times outside every range use the fallback."
    : "";
  tagTimeWarningElement.hidden = !timePlan.warnings.length;
}

function setMode(mode) {
  const showTags = mode === "tags";
  strategyModeButton.setAttribute("aria-pressed", String(!showTags));
  tagsModeButton.setAttribute("aria-pressed", String(showTags));
  strategyAnalysisSection.hidden = showTags;
  tagResultsSection.hidden = !showTags;
  tagVerificationSection.hidden = !showTags;
}

strategyModeButton.addEventListener("click", () => setMode("strategy"));
tagsModeButton.addEventListener("click", () => setMode("tags"));
strategyFilterStatus.addEventListener("change", renderStrategyBranches);
strategyFilterPath.addEventListener("change", renderStrategyBranches);
strategyFilterSearch.addEventListener("input", renderStrategyBranches);

tagSampleCountInput.addEventListener("input", updateProductionTagButton);
tagSizeSelect.addEventListener("change", updateProductionTagButton);
// Shows the failure in the progress panel and re-enables the controls, so an
// unexpected error never leaves the run stuck.
function showRunError(error) {
  const message = error?.message || String(error);
  console.error(error);
  tagResultsSection.hidden = false;
  tagResultsEmpty.hidden = true;
  tagProgressSection.hidden = false;
  tagProgressSection.dataset.state = "error";
  tagProgressPhase.textContent = "Run failed";
  tagProgressDetail.textContent = `Error: ${message}`;
  setTagStatus(`Run failed: ${message}`, true);
}

tagAcceptClosestInput.addEventListener("change", rerenderTagRun);

verifyTagButton.addEventListener("click", () => {
  runProductionTagVerification().catch((error) => {
    showRunError(error);
    tagSampleCountInput.disabled = false;
    tagSizeSelect.disabled = false;
    updateProductionTagButton();
  });
});

loadTagVerificationData()
  .then(async (data) => {
    const overview = getStrategyOverview(data.tree, data.feedRows);
    const readOnly = data.tagRunBlockers.length > 0;
    const keyLabel = /(^|\.)dsp-lineid$/.test(data.context.inputSource || "")
      ? "line ID"
      : "feed key";
    const timePlan = getTimeOfDayPlan(overview);
    const scenarios = timePlan.scenarios.length ? timePlan.scenarios : [null];
    tagVerificationData = {
      ...data,
      timePlan,
      strategyVariantGroups: readOnly
        ? new Map()
        : new Map(
            scenarios.flatMap((scenario) =>
              data.adSizes.map((size) => [
                getStrategyGroupKey(size, scenario),
                getStrategyVariantGroups(overview, size, scenario?.minute ?? null),
              ]),
            ),
          ),
    };
    for (const { width, height } of data.adSizes) {
      const option = document.createElement("option");
      option.value = `${width}x${height}`;
      option.textContent = `${width}×${height}`;
      tagSizeSelect.appendChild(option);
    }
    renderTimePlan(timePlan);
    renderStrategyOverview(overview, data.lineIds.length, keyLabel);
    contextElement.removeAttribute("data-error");
    contextElement.textContent =
      `Adset ${data.adsetId} · ${data.feed.name || `Feed ${data.feed.id}`}` +
      (data.contentFeed
        ? ` + content feed ${data.contentFeed.name || data.contentFeed.id}`
        : "") +
      ` · ${data.lineIds.length} ${keyLabel}(s) · ${data.feedRows.length} feed row(s)`;
    tagWorkspaceSection.hidden = false;
    setMode("strategy");
    if (readOnly) {
      const reason = `Tag runs are unavailable: ${data.tagRunBlockers.join(" ")}`;
      tagRunBlockedElement.textContent =
        `${reason} The strategy and feed comparison below is read-only.`;
      tagRunBlockedElement.hidden = false;
      tagsModeButton.disabled = true;
      tagsModeButton.title = reason;
      tagsModeDetail.textContent = "Unavailable for this strategy.";
      verifyTagButton.disabled = true;
      return;
    }
    updateProductionTagButton();
  })
  .catch((error) => {
    contextElement.dataset.error = "true";
    contextElement.textContent =
      `Could not load strategy or feed data: ${error.message || String(error)}`;
    setTagStatus(error.message || String(error), true);
  });
