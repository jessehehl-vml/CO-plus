const test = require("node:test");
const assert = require("node:assert/strict");

const corePromise = import("../simulator-core.mjs");

test("CSV parser keeps commas and newlines inside quoted fields", async () => {
  const { parseCsv } = await corePromise;
  const rows = parseCsv(
    'variant_id,lineID,audience,copy\r\nV1,"123,abc",Cars,"first line\nsecond line"\r\n',
  );

  assert.deepEqual(rows, [
    {
      variant_id: "V1",
      lineID: "123,abc",
      audience: "Cars",
      copy: "first line\nsecond line",
    },
  ]);
});

test("line ID resolves the dynamic-feed outcome and checks its variants", async () => {
  const { buildSimulationPlan } = await corePromise;
  const tree = {
    nodes: [
      {
        id: 1,
        type: "root",
        label: "<root>",
        "ad-variants": [{ "content-id": "Default" }],
      },
      {
        id: 2,
        type: "dynamic-feed",
        targeting: {
          context: [
            {
              alias: "feed-42",
              param: {
                "feed-id": 42,
                data: { in: [{ to: "lineID" }] },
              },
              "value-column": "audience",
            },
          ],
        },
      },
      {
        id: 3,
        type: "dynamic-feed-outcome",
        "parent-id": 2,
        label: "Cars",
        targeting: { predicate: ["=", "${feed-42.audience}", "Cars"] },
        "ad-variants": [
          { "content-id": "V1" },
          { "content-id": "V2" },
          { "content-id": "V3" },
        ],
      },
    ],
  };
  const feedRows = [
    { lineID: "123, abc", audience: "Cars", variant_id: "V1" },
    { lineID: "123, abc", audience: "Cars", variant_id: "V2" },
    { lineID: "123, abc", audience: "Cars", variant_id: "V3" },
  ];

  const plan = buildSimulationPlan(tree, feedRows, "abc");
  assert.equal(plan.audience, "Cars");
  assert.equal(plan.outcomeLabel, "Cars");
  assert.deepEqual(
    plan.strategyVariants.map((variant) => variant.contentId),
    ["V1", "V2", "V3"],
  );
  assert.equal(plan.matchesFeed, true);
});

test("strategy overview explains audience branches, variant sets, and fallback", async () => {
  const { getStrategyOverview } = await corePromise;
  const tree = {
    nodes: [
      {
        id: 1,
        type: "root",
        label: "Default",
        "ad-variants": [{ "content-id": "V0" }],
      },
      {
        id: 2,
        type: "dynamic-feed",
        targeting: {
          context: [
            {
              alias: "feed-42",
              param: {
                "feed-id": 42,
                data: { in: [{ to: "lineID" }] },
              },
              "value-column": "audience",
            },
          ],
        },
      },
      {
        id: 3,
        type: "dynamic-feed-outcome",
        "parent-id": 2,
        label: "Cars",
        targeting: { predicate: ["=", "${feed-42.audience}", "Cars"] },
        "ad-variants": [
          { "content-id": "V1" },
          { "content-id": "V2" },
        ],
      },
      {
        id: 4,
        type: "dynamic-feed-outcome",
        "parent-id": 2,
        label: "Trucks",
        targeting: { predicate: ["=", "${feed-42.audience}", "Trucks"] },
        "ad-variants": [{ "content-id": "V3" }],
      },
    ],
  };
  const overview = getStrategyOverview(tree, [
    { audience: "Cars", variant_id: "V1" },
    { audience: "Cars", variant_id: "V2" },
    { audience: "Trucks", variant_id: "Other" },
    { audience: "Other audience", variant_id: "V9" },
  ]);

  assert.equal(overview.inputField, "lineID");
  assert.equal(overview.valueField, "audience");
  assert.deepEqual(
    overview.branches.map(({ audience, matchesFeed }) => ({
      audience,
      matchesFeed,
    })),
    [
      { audience: "Cars", matchesFeed: true },
      { audience: "Trucks", matchesFeed: false },
    ],
  );
  assert.deepEqual(overview.unhandledAudiences, [
    { audience: "Other audience", feedVariants: ["V9"] },
  ]);
  assert.deepEqual(overview.fallback.strategyVariants, ["V0"]);
});

test("strategy overview gathers variants from connected outcome descendants", async () => {
  const {
    buildSimulationPlan,
    getStrategyOverview,
    getStrategySummary,
    getStrategyVariantGroups,
  } = await corePromise;
  const tree = {
    nodes: [
      {
        id: 1,
        type: "root",
        label: "Default",
        "ad-variants": [{ "content-id": "V0" }],
      },
      {
        id: 2,
        type: "dynamic-feed",
        targeting: {
          context: [
            {
              alias: "feed-42",
              param: {
                "feed-id": 42,
                data: { in: [{ to: "lineID" }] },
              },
              "value-column": "audience",
            },
          ],
        },
      },
      {
        id: 3,
        type: "dynamic-feed-outcome",
        "parent-id": 2,
        label: "Cars",
        targeting: { predicate: ["=", "${feed-42.audience}", "Cars"] },
      },
      {
        id: 4,
        type: "dynamic-feed-outcome",
        "parent-id": 2,
        label: "Trucks",
        targeting: { predicate: ["=", "${feed-42.audience}", "Trucks"] },
      },
      { id: 5, type: "date-time", "parent-id": 3 },
      {
        id: 6,
        type: "date-time-outcome",
        "parent-id": 5,
        label: "Day",
        "ad-variants": [
          {
            "content-id": "V1",
            "ad-formats": [{ width: 728, height: 90 }],
          },
        ],
      },
      {
        id: 7,
        type: "date-time-outcome",
        "parent-id": 5,
        label: "Night",
        "ad-variants": [
          {
            "content-id": "V2",
            "ad-formats": [{ width: 300, height: 250 }],
          },
          {
            "content-id": "V3",
            "ad-formats": [{ width: 300, height: 250 }],
          },
        ],
      },
      { id: 8, type: "date-time", "parent-id": 4 },
      {
        id: 9,
        type: "date-time-outcome",
        "parent-id": 8,
        label: "Day",
        "ad-variants": [{ "content-id": "V4" }],
      },
    ],
  };
  const feedRows = [
    { lineID: "123", audience: "Cars", variant_id: "V1" },
    { lineID: "123", audience: "Cars", variant_id: "V2" },
    { lineID: "123", audience: "Cars", variant_id: "V3" },
    { lineID: "456", audience: "Trucks", variant_id: "V4" },
  ];
  const overview = getStrategyOverview(tree, feedRows);
  const plan = buildSimulationPlan(tree, feedRows, "123");

  assert.deepEqual(
    overview.branches.map(({ audience, strategyVariants, matchesFeed }) => ({
      audience,
      strategyVariants,
      matchesFeed,
    })),
    [
      {
        audience: "Cars",
        strategyVariants: ["V1", "V2", "V3"],
        matchesFeed: true,
      },
      { audience: "Trucks", strategyVariants: ["V4"], matchesFeed: true },
    ],
  );
  assert.deepEqual(
    plan.strategyVariants.map((variant) => variant.contentId),
    ["V1", "V2", "V3"],
  );
  assert.equal(plan.matchesFeed, true);
  assert.equal(
    getStrategySummary(overview, 6),
    "6 line IDs → Feed node routes to 2 audiences → Day & Night.",
  );
  assert.deepEqual(
    getStrategyVariantGroups(overview, { width: 728, height: 90 }),
    [
      {
        audience: "Cars",
        feedNodeId: "2",
        path: "Date & Time → Day",
        variants: ["V1"],
        multiVariant: false,
      },
      {
        audience: "Trucks",
        feedNodeId: "2",
        path: "Date & Time → Day",
        variants: ["V4"],
        multiVariant: false,
      },
      {
        audience: null,
        feedNodeId: null,
        path: "Default",
        variants: ["V0"],
        multiVariant: false,
      },
    ],
  );
  assert.deepEqual(
    getStrategyVariantGroups(overview, { width: 300, height: 250 }),
    [
      {
        audience: "Cars",
        feedNodeId: "2",
        path: "Date & Time → Night",
        variants: ["V2", "V3"],
        multiVariant: true,
      },
      {
        audience: "Trucks",
        feedNodeId: "2",
        path: "Date & Time → Day",
        variants: ["V4"],
        multiVariant: false,
      },
      {
        audience: null,
        feedNodeId: null,
        path: "Default",
        variants: ["V0"],
        multiVariant: false,
      },
    ],
  );
  assert.deepEqual(overview.branches[0].strategyNodes, [
    {
      type: "date-time",
      label: "",
      timeRange: null,
      variants: [],
      variantFormats: [],
      children: [
        {
          type: "date-time-outcome",
          label: "Day",
          timeRange: null,
          variants: ["V1"],
          variantFormats: [
            { variantId: "V1", formats: ["728x90"] },
          ],
          children: [],
        },
        {
          type: "date-time-outcome",
          label: "Night",
          timeRange: null,
          variants: ["V2", "V3"],
          variantFormats: [
            { variantId: "V2", formats: ["300x250"] },
            { variantId: "V3", formats: ["300x250"] },
          ],
          children: [],
        },
      ],
    },
  ]);
});

test("time plan simulates each Date & Time range and flags overlaps", async () => {
  const { getStrategyOverview, getStrategyVariantGroups, getTimeOfDayPlan } =
    await corePromise;
  const buildTree = (nightStart, nightEnd) => ({
    nodes: [
      { id: 1, type: "root", "ad-variants": [{ "content-id": "V0" }] },
      {
        id: 2,
        type: "dynamic-feed",
        targeting: {
          context: [
            {
              alias: "feed-42",
              param: { "feed-id": 42, data: { in: [{ to: "lineID" }] } },
              "value-column": "audience",
            },
          ],
        },
      },
      {
        id: 3,
        type: "dynamic-feed-outcome",
        "parent-id": 2,
        label: "Cars",
        targeting: { predicate: ["=", "${feed-42.audience}", "Cars"] },
      },
      { id: 4, type: "date-time", "parent-id": 3 },
      {
        id: 5,
        type: "date-time-outcome",
        "parent-id": 4,
        label: "Day",
        targeting: {
          predicate: [
            "in-range",
            "${datetime.time-of-day}",
            { start: { hour: 6, minute: 0 }, end: { hour: 18, minute: 0 } },
          ],
        },
        "ad-variants": [{ "content-id": "V1" }],
      },
      {
        id: 6,
        type: "date-time-outcome",
        "parent-id": 4,
        label: "Night",
        targeting: {
          predicate: [
            "in-range",
            "${datetime.time-of-day}",
            { start: { hour: nightStart, minute: 0 }, end: { hour: nightEnd, minute: 0 } },
          ],
        },
        "ad-variants": [{ "content-id": "V2" }, { "content-id": "V3" }],
      },
    ],
  });
  const feedRows = [{ lineID: "123", audience: "Cars", variant_id: "V1" }];
  const size = { width: 300, height: 250 };

  const sameRange = getTimeOfDayPlan(getStrategyOverview(buildTree(6, 18), feedRows));
  assert.deepEqual(
    sameRange.scenarios.map(({ time, label }) => ({ time, label })),
    [
      { time: "00:00", label: "No time outcome" },
      { time: "12:00", label: "Day & Night" },
    ],
  );
  assert.deepEqual(sameRange.warnings, [
    "Day and Night use the same time range (06:00–18:00).",
  ]);

  const overview = getStrategyOverview(buildTree(18, 6), feedRows);
  const plan = getTimeOfDayPlan(overview);
  assert.deepEqual(
    plan.scenarios.map(({ time, label }) => ({ time, label })),
    [
      { time: "00:00", label: "Night" },
      { time: "12:00", label: "Day" },
    ],
  );
  assert.deepEqual(plan.warnings, []);
  const cars = (minute) =>
    getStrategyVariantGroups(overview, size, minute).find(
      (group) => group.audience === "Cars",
    );
  assert.deepEqual(cars(12 * 60).variants, ["V1"]);
  assert.deepEqual(cars(0).variants, ["V2", "V3"]);
  assert.equal(cars(0).multiVariant, true);
});

test("tag summary judges routing and multi-variant coverage", async () => {
  const { getExpectedStrategyVariants, summarizeTagVerification } =
    await corePromise;
  const groups = [
    { audience: "Cars", path: "Night", variants: ["V2", "V3"] },
    { audience: null, path: "Default", variants: ["V0"] },
  ];
  assert.deepEqual(getExpectedStrategyVariants(groups, ["Cars"]), ["V2", "V3"]);
  assert.deepEqual(getExpectedStrategyVariants(groups, ["Vans"]), ["V0"]);

  const node = (observedVariantIds) => ({
    label: "Cars → Night",
    variants: ["V2", "V3"],
    observedVariantIds,
  });
  const checks = [
    { label: "a", exact: true, variantId: "V2", expectedVariants: ["V2", "V3"] },
  ];
  assert.equal(
    summarizeTagVerification({ checks, nodes: [node(["V2", "V3", "V2"])] }).verdict,
    "match",
  );
  assert.equal(
    summarizeTagVerification({ checks, nodes: [node(["V2", "V2", "V2"])] }).verdict,
    "inconclusive",
  );
  const routingOnly = summarizeTagVerification({
    checks,
    nodes: [node(["V2"])],
    sampleLimit: 1,
  });
  assert.equal(routingOnly.verdict, "match");
  assert.ok(
    routingOnly.items.some((item) =>
      item.text.includes("multi-variant coverage was not sampled"),
    ),
  );
  assert.equal(
    summarizeTagVerification({ checks, nodes: [node(Array(10).fill("V2"))] }).verdict,
    "mismatch",
  );
  assert.equal(
    summarizeTagVerification({
      checks: [{ ...checks[0], variantId: "V0" }],
    }).verdict,
    "mismatch",
  );
  const feedMismatch = summarizeTagVerification({
    checks: [{ ...checks[0], feedVariants: ["V4", "V5"] }],
  });
  assert.equal(feedMismatch.verdict, "mismatch");
  assert.match(feedMismatch.headline, /does not match the feed/);
  assert.equal(
    summarizeTagVerification({
      checks: [{ ...checks[0], feedVariants: ["V2", "V3"] }],
    }).verdict,
    "match",
  );
  const warned = summarizeTagVerification({ checks, warnings: ["Overlap."] });
  assert.equal(warned.verdict, "match");
  assert.match(warned.headline, /warnings/);
});

test("feed mappings expose renamed sheet headers under their field key", async () => {
  const { applyFeedMappings, parseCsv } = await corePromise;
  const rows = applyFeedMappings(
    parseCsv('CM_AudienceName,Line Item IDs (AD GroupID)\nAffluent,"a1, a2"\n'),
    [
      { from: "CM_AudienceName", to: "CM_AudienceName" },
      { from: "Line Item IDs (AD GroupID)", to: "Line_Item_IDs_AD_GroupID" },
    ],
  );
  assert.equal(rows[0].Line_Item_IDs_AD_GroupID, "a1, a2");
  assert.equal(rows[0].CM_AudienceName, "Affluent");
});

test("lookup feed audiences join content feed variants", async () => {
  const { findVariantIdColumn, joinLookupAndContentFeeds } = await corePromise;
  const tree = {
    nodes: [
      { type: "root", "ad-variants": [{ "content-id": "All_1" }] },
      { type: "dynamic-feed-outcome", "ad-variants": [{ "content-id": "Fam_1" }] },
    ],
  };
  const lookupRows = [
    { CM_AudienceName: "Families", Line_IDs: "a1, a2" },
    { CM_AudienceName: "All", Line_IDs: "a1,a2,b1" },
  ];
  const contentRows = [
    { variantID: "Fam_1", audience: "Families", headline: "Hi" },
    { variantID: "All_1", audience: "All", headline: "Yo" },
  ];
  assert.equal(findVariantIdColumn(lookupRows, tree), null);
  assert.equal(findVariantIdColumn(contentRows, tree), "variantID");
  const rows = joinLookupAndContentFeeds({
    lookupRows,
    contentRows,
    context: { inputField: "Line_IDs", valueField: "CM_AudienceName" },
    variantIdColumn: "variantID",
    audienceColumn: "audience",
  });
  assert.deepEqual(
    rows.map((row) => [row.variant_id, row.CM_AudienceName, row.Line_IDs]),
    [
      ["Fam_1", "Families", "a1,a2"],
      ["All_1", "All", "a1,a2,b1"],
    ],
  );
});

test("strategy suggestions identify reciprocal variant swaps", async () => {
  const { getStrategySuggestions } = await corePromise;
  const suggestions = getStrategySuggestions({
    branches: [
      {
        audience: "Truck & Bus",
        outcomeLabel: "Truck & Bus outcome",
        strategyVariants: ["V7", "V8", "V9"],
        feedVariants: ["V4", "V5", "V6"],
        feedRowCount: 3,
        matchesFeed: false,
      },
      {
        audience: "Mixed / EV",
        outcomeLabel: "Mixed / EV outcome",
        strategyVariants: ["V4", "V5", "V6"],
        feedVariants: ["V7", "V8", "V9"],
        feedRowCount: 3,
        matchesFeed: false,
      },
    ],
    unhandledAudiences: [],
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].type, "swap");
  assert.equal(suggestions[0].first.outcomeLabel, "Truck & Bus outcome");
  assert.equal(suggestions[0].second.outcomeLabel, "Mixed / EV outcome");
});

test("feed line IDs are inferred from multi-value cells and deduplicated", async () => {
  const { getFeedLineIds, parseCsv } = await corePromise;
  const rows = parseCsv(
    'lineID,audience,variant_id\n"123,abc",Cars,V1\n"123,def",Cars,V2\n456,Cars,V3\n',
  );

  assert.deepEqual(getFeedLineIds(rows, "lineID"), ["123", "abc", "def", "456"]);
});

test("ad sizes are collected uniquely from strategy variants", async () => {
  const { getStrategyAdSizes } = await corePromise;

  assert.deepEqual(
    getStrategyAdSizes({
      nodes: [
        {
          "ad-variants": [
            {
              "ad-formats": [
                { width: 728, height: 90 },
                { width: 300, height: 250 },
              ],
            },
          ],
        },
        {
          "ad-variants": [
            {
              "ad-formats": [
                { width: 300, height: 250 },
                { width: 0, height: 250 },
              ],
            },
          ],
        },
      ],
    }),
    [
      { width: 728, height: 90 },
      { width: 300, height: 250 },
    ],
  );
});

test("total impressions are divided evenly across feed line IDs", async () => {
  const { distributeImpressions } = await corePromise;

  assert.deepEqual(distributeImpressions(8, ["a", "b", "c"]), [
    { lineId: "a", impressions: 3 },
    { lineId: "b", impressions: 3 },
    { lineId: "c", impressions: 2 },
  ]);
  assert.throws(() => distributeImpressions(2, ["a", "b", "c"]), {
    message:
      "At least 3 total impressions are required to include every feed line ID.",
  });
});

test("production tag results explain exact and partial feed matches", async () => {
  const { compareTagResultToFeed } = await corePromise;
  const feedRows = [
    {
      lineID: "123, 456",
      audience: "Cars",
      variant_id: "V1",
      headline: "First",
      image: "https://assets.example/first.png",
    },
    {
      lineID: "123",
      audience: "Cars",
      variant_id: "V2",
      headline: "Second",
      image: "https://assets.example/second.png",
    },
  ];

  const exactMatch = compareTagResultToFeed(
    {
      status: 200,
      response: {
        content: {
          headline: { type: "text", value: "  Second \n" },
          image: {
            type: "image",
            value: "https://assets.example/second.png",
          },
        },
      },
    },
    feedRows,
    "lineID",
    "audience",
  );
  assert.deepEqual(exactMatch.exactVariantIds, ["V2"]);
  assert.deepEqual(exactMatch.contentFields, [
    { field: "headline", value: "Second" },
    { field: "image", value: "https://assets.example/second.png" },
  ]);
  assert.deepEqual(exactMatch.candidates[0].matchedFields, ["headline", "image"]);
  assert.deepEqual(exactMatch.candidates[0].differingFields, []);
  assert.deepEqual(exactMatch.candidates[0].sourceLineIds, ["123"]);
  assert.deepEqual(exactMatch.candidates[0].sourceAudiences, ["Cars"]);

  const partialMatch = compareTagResultToFeed(
    {
      status: 200,
      response: {
        content: {
          headline: { type: "text", value: "Second" },
          image: { type: "image", value: "https://assets.example/other.png" },
          unknown: { type: "text", value: "Not in the feed" },
        },
      },
    },
    feedRows,
    "lineID",
    "audience",
  );
  assert.deepEqual(partialMatch.exactVariantIds, []);
  assert.deepEqual(partialMatch.partialVariantIds, []);
  assert.deepEqual(partialMatch.candidates[0].missingFields, ["unknown"]);
  assert.deepEqual(partialMatch.candidates[0].differingFields, [
    {
      field: "image",
      tagValue: "https://assets.example/other.png",
      feedValue: "https://assets.example/second.png",
    },
  ]);

  const uniquePartialMatch = compareTagResultToFeed(
    {
      status: 200,
      response: {
        content: {
          headline: { type: "text", value: "Second" },
          unmapped: { type: "text", value: "Not in the feed" },
        },
      },
    },
    feedRows,
    "lineID",
    "audience",
  );
  assert.deepEqual(uniquePartialMatch.exactVariantIds, []);
  assert.deepEqual(uniquePartialMatch.partialVariantIds, ["V2"]);

  const ambiguousMatch = compareTagResultToFeed(
    {
      status: 200,
      response: { content: { audience: { type: "text", value: "Cars" } } },
    },
    [
      { lineID: "123", audience: "Cars", variant_id: "V1" },
      { lineID: "123", audience: "Cars", variant_id: "V2" },
    ],
    "lineID",
    "audience",
  );
  assert.deepEqual(ambiguousMatch.exactVariantIds, ["V1", "V2"]);

  const crossAudienceMatch = compareTagResultToFeed(
    {
      status: 200,
      response: { content: { headline: { type: "text", value: "Truck creative" } } },
    },
    [
      { lineID: "cars-id", audience: "Cars", variant_id: "V1", headline: "Car creative" },
      {
        lineID: "trucks-id",
        audience: "Trucks",
        variant_id: "V2",
        headline: "Truck creative",
      },
    ],
    "lineID",
    "audience",
  );
  assert.deepEqual(crossAudienceMatch.exactVariantIds, ["V2"]);
  assert.deepEqual(crossAudienceMatch.candidates[0].sourceLineIds, ["trucks-id"]);
  assert.deepEqual(crossAudienceMatch.candidates[0].sourceAudiences, ["Trucks"]);
});

test("simulation uses strategy variants and reports a feed mismatch", async () => {
  const { buildSimulationPlan, simulateVariantCounts } = await corePromise;
  const tree = {
    nodes: [
      {
        id: 1,
        type: "root",
        label: "<root>",
        "ad-variants": [{ "content-id": "Default" }],
      },
      {
        id: 2,
        type: "dynamic-feed",
        targeting: {
          context: [
            {
              alias: "feed-42",
              param: {
                "feed-id": 42,
                data: { in: [{ to: "lineID" }] },
              },
              "value-column": "audience",
            },
          ],
        },
      },
      {
        id: 3,
        type: "dynamic-feed-outcome",
        "parent-id": 2,
        label: "Trucks",
        targeting: { predicate: ["=", "${feed-42.audience}", "Trucks"] },
        "ad-variants": [
          { "content-id": "Mixed-1" },
          { "content-id": "Mixed-2" },
        ],
      },
    ],
  };
  const plan = buildSimulationPlan(
    tree,
    [
      { lineID: "9", audience: "Trucks", variant_id: "Truck-1" },
      { lineID: "9", audience: "Trucks", variant_id: "Truck-2" },
    ],
    "9",
  );

  assert.equal(plan.matchesFeed, false);
  assert.deepEqual(
    simulateVariantCounts(plan, 4, () => 0),
    { "Mixed-1": 4, "Mixed-2": 0 },
  );
});

test("unknown line ID uses the root fallback", async () => {
  const { buildSimulationPlan } = await corePromise;
  const tree = {
    nodes: [
      {
        id: 1,
        type: "root",
        label: "<root>",
        "ad-variants": [{ "content-id": "Default" }],
      },
      {
        id: 2,
        type: "dynamic-feed",
        targeting: {
          context: [
            {
              alias: "feed-42",
              param: {
                "feed-id": 42,
                data: { in: [{ to: "lineID" }] },
              },
              "value-column": "audience",
            },
          ],
        },
      },
      {
        id: 3,
        type: "dynamic-feed-outcome",
        "parent-id": 2,
        label: "Cars",
        targeting: { predicate: ["=", "${feed-42.audience}", "Cars"] },
        "ad-variants": [{ "content-id": "V1" }],
      },
    ],
  };

  const plan = buildSimulationPlan(tree, [], "unknown");
  assert.equal(plan.usedFallback, true);
  assert.equal(plan.outcomeLabel, "<root>");
  assert.deepEqual(
    plan.strategyVariants.map((variant) => variant.contentId),
    ["Default"],
  );
  assert.equal(plan.matchesFeed, null);
});

test("feed audiences without a strategy branch use the root fallback and mismatch", async () => {
  const { buildSimulationPlan } = await corePromise;
  const plan = buildSimulationPlan(
    {
      nodes: [
        {
          id: 1,
          type: "root",
          label: "Default",
          "ad-variants": [{ "content-id": "V0" }],
        },
        {
          id: 2,
          type: "dynamic-feed",
          targeting: {
            context: [
              {
                alias: "feed-42",
                param: {
                  "feed-id": 42,
                  data: { in: [{ to: "lineID" }] },
                },
                "value-column": "audience",
              },
            ],
          },
        },
      ],
    },
    [{ lineID: "123", audience: "Unconfigured", variant_id: "V1" }],
    "123",
  );

  assert.equal(plan.usedFallback, true);
  assert.equal(plan.hasFeedRow, true);
  assert.equal(plan.matchesFeed, false);
});

test("repeated feed copies run one postcode per placement and outcome", async () => {
  const {
    getDynamicFeedContext,
    getStrategyOverview,
    getTagRunBlockers,
    getTagTargets,
    getStrategyVariantGroups,
    getExpectedStrategyVariants,
  } = await corePromise;
  const feedNode = (id, parentId, selector, alias = "location") => ({
    id,
    "parent-id": parentId,
    type: "dynamic-feed",
    targeting: {
      context: [
        {
          alias: "feed-7",
          param: {
            "feed-id": 7,
            data: { in: [{ to: "key", from: { alias, selector } }] },
          },
          "value-column": "city",
        },
      ],
    },
  });
  const outcome = (id, parentId, variant, width = 300, height = 250) => ({
    id,
    "parent-id": parentId,
    type: "dynamic-feed-outcome",
    label: "Leeds",
    targeting: { predicate: ["=", "${feed-7.city}", "Leeds"] },
    "ad-variants": [{ "content-id": variant, "ad-formats": [{ width, height }] }],
  });
  const placement = (id, value) => ({
    id,
    "parent-id": 2,
    type: "dsp-signal-outcome",
    label: value,
    targeting: { predicate: ["=", "${dsp-signal.dsp-placementid}", value] },
  });
  const tree = {
    nodes: [
      { id: 1, type: "root", "ad-variants": [{ "content-id": "Default" }] },
      { id: 2, "parent-id": 1, type: "dsp-signal" },
      placement(3, "111"),
      placement(4, "222"),
      feedNode(5, 3, "postal-code"),
      feedNode(6, 4, "postal-code"),
      outcome(7, 5, "L1"),
      outcome(8, 6, "L2", 120, 600),
    ],
  };

  const context = getDynamicFeedContext(tree);
  assert.deepEqual(context.feedNodeIds, ["5", "6"]);
  const overview = getStrategyOverview(tree, [
    { key: "LS1", city: "Leeds", variant_id: "L1" },
  ]);
  assert.deepEqual(
    overview.branches.map(({ pathLabel, matchesFeed }) => [pathLabel, matchesFeed]),
    [
      ["dsp-placementid 111", true],
      ["dsp-placementid 222", false],
    ],
  );
  assert.deepEqual(getTagRunBlockers(tree, context), []);
  const { targets, untested } = getTagTargets(tree, context, [
    { key: "LS1", city: "Leeds" },
    { key: "LS2", city: "Leeds" },
    { key: "YO1", city: "York" },
  ]);
  assert.deepEqual(untested, []);
  assert.deepEqual(
    targets.map(({ label, signals }) => [label, signals]),
    [
      [
        "dsp-placementid 111 · postal-code LS1 (Leeds)",
        { "dsp-signal.dsp-placementid": "111", "location.postal-code": "LS1" },
      ],
      [
        "dsp-placementid 222 · postal-code LS1 (Leeds)",
        { "dsp-signal.dsp-placementid": "222", "location.postal-code": "LS1" },
      ],
    ],
  );
  assert.deepEqual(
    targets.map(({ adSizes }) => adSizes),
    [[{ width: 300, height: 250 }], [{ width: 120, height: 600 }]],
  );
  assert.deepEqual(
    targets.map((target) =>
      getExpectedStrategyVariants(
        getStrategyVariantGroups(overview, target.adSizes[0]),
        target.audiences,
        target.feedNodeId,
      ),
    ),
    [["L1"], ["L2"]],
  );

  const unsupportedTree = {
    nodes: [...tree.nodes.slice(0, 4), feedNode(5, 3, "city", "geo"), feedNode(6, 4, "city", "geo")],
  };
  const blockers = getTagRunBlockers(
    unsupportedTree,
    getDynamicFeedContext(unsupportedTree),
  );
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /geo\.city/);

  const lineIdTree = {
    nodes: [tree.nodes[0], feedNode(5, 1, "dsp-lineid", "dsp-signal")],
  };
  assert.deepEqual(
    getTagRunBlockers(lineIdTree, getDynamicFeedContext(lineIdTree)),
    [],
  );

  const otherFeed = feedNode(6, 4, "postal-code");
  otherFeed.targeting.context[0].param["feed-id"] = 8;
  assert.throws(
    () => getDynamicFeedContext({ nodes: [...tree.nodes.slice(0, 5), otherFeed] }),
    /different feeds or mappings/,
  );
});
