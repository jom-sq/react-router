# Server manifest matching prototype

This prototype applies to conventional Framework Mode's lazy manifest endpoint.
It caches ordered route IDs per static handler, with a 256-path LRU and a
1,024-character key limit. It continues reading assets for every response.
The cache does not apply to document or data requests.

The benchmark generates 1,001 routes from 200 sections, with dynamic, index,
detail and static-exception routes. It compares the real built server handler
against upstream commit `a6090382ed467b5a2d46c8de1a13b331f14959f8`.
No application route tree or production workload is used.

## Run

Use Node 22.22 or newer and pnpm. From this branch's checkout:

```sh
pnpm install --frozen-lockfile
pnpm run --filter react-router build
git worktree add ../react-router-manifest-baseline a6090382ed467b5a2d46c8de1a13b331f14959f8
```

In `../react-router-manifest-baseline`:

```sh
pnpm install --frozen-lockfile
pnpm run --filter react-router build
```

Back in the prototype checkout:

```sh
pnpm test packages/react-router/__tests__/server-runtime --runInBand
pnpm run --filter react-router typecheck
pnpm exec eslint packages/react-router/lib/server-runtime/server.ts packages/react-router/__tests__/server-runtime/manifest-cache-test.ts scripts/bench/manifest-matching.mjs
node scripts/bench/manifest-matching.mjs ../react-router-manifest-baseline/packages/react-router/dist/production/lib/server-runtime/server.js packages/react-router/dist/production/lib/server-runtime/server.js
```

The script asserts body, status and header parity over every generated route,
cold and repeated paths, misses, encoded paths, duplicate/relative paths,
request guards and a changed asset entry. It then alternates baseline/candidate
order across four timing rounds. Each round primes the repeated batch before
timing 100 requests. Churn uses 400 distinct paths over two cycles, exceeding
the proposed cache capacity. New-handler timing creates a new fixture and
handler for each request.

## Example result

One local run on Node 26.10.0 passed 1,611 response comparisons. Mean time per
request across four rounds:

| Workload                               | Baseline | Prototype |
| -------------------------------------- | -------: | --------: |
| Repeated 10-path manifest batch        | 0.798 ms |  0.034 ms |
| 400-path churn, one path per request   | 0.247 ms |  0.255 ms |
| New fixture and handler, 10-path batch | 5.932 ms |  5.445 ms |

This is an in-process microbenchmark. It includes request creation, matching,
response serialization and body consumption, but no HTTP server, network,
rendering, concurrent workload or CPU quota. The new-handler case includes
fixture construction and should not be interpreted as isolated matching cost.
The churn case is slightly slower with the cache. Entry count and key length
are bounded, but retained bytes and garbage collection have not been measured.

The 14 new regression cases include reuse, LRU eviction, long-key bypass,
fresh assets, response order, request guards, handler/build replacement and
basename isolation. Four cache assertions fail on the unmodified baseline.
