import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

// Pass built baseline and candidate server-runtime/server.js paths, in that order.
const [baselinePath, candidatePath] = process.argv.slice(2);
assert(
  baselinePath && candidatePath,
  "Provide baseline and candidate module paths",
);
const baseline = (await import(pathToFileURL(resolve(baselinePath)).href))
  .createRequestHandler;
const candidate = (await import(pathToFileURL(resolve(candidatePath)).href))
  .createRequestHandler;
const sections = 200;

function makeBuild() {
  const routes = {};
  const assets = {};
  function add(id, path, parentId, index) {
    routes[id] = { id, path, parentId, index, module: { default: () => null } };
    assets[id] = {
      id,
      path,
      parentId,
      index,
      module: `/assets/${id}.js`,
      imports: [],
      hasAction: false,
      hasLoader: false,
      hasErrorBoundary: false,
      hasClientAction: false,
      hasClientLoader: false,
      hasClientMiddleware: false,
    };
  }
  add("root", "");
  for (let i = 0; i < sections; i++) {
    add(`section-${i}`, `section-${i}`, "root");
    add(`item-${i}`, ":id", `section-${i}`);
    add(`index-${i}`, undefined, `item-${i}`, true);
    add(`detail-${i}`, "details", `item-${i}`);
    add(`featured-${i}`, "featured", `section-${i}`);
  }
  return {
    ssr: true,
    future: {},
    prerender: [],
    isSpaMode: false,
    routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
    assetsBuildDirectory: "",
    publicPath: "",
    assets: {
      version: "synthetic-v1",
      url: "",
      entry: { module: "", imports: [] },
      routes: assets,
    },
    entry: {
      module: {
        default: async (_request, status, headers) =>
          new Response(null, { status, headers }),
      },
    },
    routes,
  };
}

function url(paths, version = "synthetic-v1") {
  const result = new URL("http://example.com/__manifest");
  result.searchParams.set("version", version);
  result.searchParams.set("paths", paths.join(","));
  return result.href;
}

async function snapshot(handler, requestUrl) {
  const response = await handler(new Request(requestUrl));
  return {
    status: response.status,
    headers: [...response.headers],
    body: await response.text(),
  };
}

const baseBuild = makeBuild();
const nextBuild = makeBuild();
const handlers = [
  baseline(baseBuild, "production"),
  candidate(nextBuild, "production"),
];
const paths = ["/", "/missing", "/section-0/a%2Fb"];
for (let i = 0; i < sections; i++) {
  paths.push(
    `/section-${i}`,
    `/section-${i}/value`,
    `/section-${i}/value/details`,
    `/section-${i}/featured`,
  );
}
const covered = new Set();
let comparisons = 0;
for (const path of paths) {
  for (let repeat = 0; repeat < 2; repeat++) {
    const a = await snapshot(handlers[0], url([path]));
    const b = await snapshot(handlers[1], url([path]));
    assert.deepEqual(b, a);
    assert.equal(a.status, 200);
    Object.keys(JSON.parse(a.body)).forEach((id) => covered.add(id));
    comparisons++;
  }
}
assert.equal(covered.size, Object.keys(baseBuild.routes).length);
for (const requestUrl of [
  url(["/section-0/value"], "other-version"),
  url(["/" + "x".repeat(8000)]),
  "http://example.com/__manifest?version=synthetic-v1",
  url(["section-0/value", "/section-0/value", "/section-0/featured"]),
]) {
  assert.deepEqual(
    await snapshot(handlers[1], requestUrl),
    await snapshot(handlers[0], requestUrl),
  );
  comparisons++;
}
await Promise.all(handlers.map((h) => snapshot(h, url(["/section-0/value"]))));
baseBuild.assets.routes["item-0"].module = "/assets/updated.js";
nextBuild.assets.routes["item-0"].module = "/assets/updated.js";
const refreshed = await snapshot(handlers[1], url(["/section-0/value"]));
assert.equal(JSON.parse(refreshed.body)["item-0"].module, "/assets/updated.js");
assert.deepEqual(
  refreshed,
  await snapshot(handlers[0], url(["/section-0/value"])),
);
comparisons++;

const warmUrl = url(
  Array.from(
    { length: 10 },
    (_, i) => `/section-${sections - 1 - i}/value/details`,
  ),
);
const churnUrls = Array.from({ length: 400 }, (_, i) =>
  url([`/section-${sections - 1}/value-${i}`]),
);
const measurements = {
  warmBatch: [[], []],
  churn: [[], []],
  newHandler: [[], []],
};
async function time(handler, urls, cycles) {
  const start = performance.now();
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (const requestUrl of urls) {
      const response = await handler(new Request(requestUrl));
      assert.equal(response.status, 200);
      await response.text();
    }
  }
  return (performance.now() - start) / (urls.length * cycles);
}
await Promise.all(handlers.map((h) => snapshot(h, warmUrl)));
for (let round = 0; round < 4; round++) {
  for (const which of round % 2 ? [1, 0] : [0, 1]) {
    await snapshot(handlers[which], warmUrl);
    measurements.warmBatch[which].push(
      await time(handlers[which], [warmUrl], 100),
    );
    measurements.churn[which].push(await time(handlers[which], churnUrls, 2));
    const create = which === 0 ? baseline : candidate;
    const start = performance.now();
    for (let i = 0; i < 10; i++)
      await snapshot(create(makeBuild(), "production"), warmUrl);
    measurements.newHandler[which].push((performance.now() - start) / 10);
  }
}
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
console.log(
  JSON.stringify(
    {
      node: process.version,
      routes: covered.size,
      comparisons,
      rounds: 4,
      warmPathsPerRequest: 10,
      churnDistinctPaths: 400,
      millisecondsPerRequest: Object.fromEntries(
        Object.entries(measurements).map(([name, values]) => [
          name,
          {
            baseline: mean(values[0]),
            candidate: mean(values[1]),
            baselineRounds: values[0],
            candidateRounds: values[1],
          },
        ]),
      ),
      limitations:
        "Synthetic in-process manifest requests, not an HTTP load test. New-handler timing includes fixture/handler construction. No production hit-rate, retained-byte or GC claim.",
    },
    null,
    2,
  ),
);
