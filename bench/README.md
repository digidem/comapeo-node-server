# Benchmarks

Performance is not a goal for `@comapeo/node-server`; reliability and correct
cancellation come first. These benchmarks are a check that it stays in the
same range as `@whatwg-node/server` and `@hono/node-server`.

## Running

```sh
npm run bench                   # 3s per scenario, concurrency 50
node bench/bench.mjs 5000 100   # custom duration (ms) and concurrency
```

Every adapter serves the same fetch-style handler over `node:http`, so the
numbers isolate adapter overhead. Each adapter runs in its own process, because
`@hono/node-server` replaces `globalThis.Request` and `Response` by default and
would otherwise change what the others are measured with. The script prints
the tables below, fastest first; "vs slowest" is each adapter's requests per
second divided by the slowest in that scenario.

- `comapeo/node-server`: this package.
- `whatwg-node (ponyfill)`: `@whatwg-node/server` defaults, with its bundled
  fetch implementation.
- `whatwg-node (native)`: `@whatwg-node/server` with `fetchAPI` set to Node's
  built-in classes.
- `hono/node-server v1` and `v2`: `getRequestListener` with defaults.
- `hono/node-server v2 (no global override)`: with
  `overrideGlobalObjects: false`.

## Results

Apple M2 Pro, versions as in `package-lock.json`. Your numbers will differ; the
relative order is what matters.

Node 24.21.0, 3000ms per scenario, concurrency 50

#### GET /hello (tiny)

| adapter                                  | req/s | vs slowest | p50 ms | p99 ms |
| ---------------------------------------- | ----: | ---------: | -----: | -----: |
| hono/node-server v2                      | 19823 |      1.54x |   2.47 |   3.06 |
| hono/node-server v1                      | 18340 |      1.43x |   2.69 |   4.51 |
| hono/node-server v2 (no global override) | 17486 |      1.36x |   2.79 |   3.49 |
| whatwg-node (native)                     | 15924 |      1.24x |   3.09 |   4.11 |
| whatwg-node (ponyfill)                   | 14512 |      1.13x |   3.01 |  12.62 |
| **comapeo/node-server**                  | 12867 |      1.00x |   3.79 |   5.52 |

#### GET /json

| adapter                                  | req/s | vs slowest | p50 ms | p99 ms |
| ---------------------------------------- | ----: | ---------: | -----: | -----: |
| hono/node-server v2                      | 20028 |      1.83x |   2.44 |   3.09 |
| hono/node-server v2 (no global override) | 17735 |      1.62x |   2.75 |   3.44 |
| whatwg-node (ponyfill)                   | 16984 |      1.55x |   2.89 |   3.78 |
| hono/node-server v1                      | 16664 |      1.52x |   2.91 |   3.91 |
| whatwg-node (native)                     | 16614 |      1.52x |   2.93 |   3.94 |
| **comapeo/node-server**                  | 10942 |      1.00x |   3.95 |   17.3 |

#### GET /stream (1MB)

| adapter                                  | req/s | vs slowest | p50 ms | p99 ms |
| ---------------------------------------- | ----: | ---------: | -----: | -----: |
| whatwg-node (ponyfill)                   |  1307 |      1.18x |  37.82 |  49.64 |
| hono/node-server v2 (no global override) |  1175 |      1.06x |  42.91 |  55.58 |
| whatwg-node (native)                     |  1171 |      1.05x |  42.59 |  63.97 |
| hono/node-server v2                      |  1165 |      1.05x |  40.58 |  85.53 |
| hono/node-server v1                      |  1160 |      1.05x |  41.71 |  94.04 |
| **comapeo/node-server**                  |  1110 |      1.00x |  42.89 | 115.98 |

#### POST /echo (1MB)

| adapter                                  | req/s | vs slowest | p50 ms | p99 ms |
| ---------------------------------------- | ----: | ---------: | -----: | -----: |
| whatwg-node (ponyfill)                   |  2134 |      1.59x |  22.89 |  33.99 |
| hono/node-server v2                      |  1697 |      1.26x |  28.65 |  46.01 |
| hono/node-server v2 (no global override) |  1635 |      1.21x |  30.68 |  35.08 |
| hono/node-server v1                      |  1392 |      1.03x |  35.45 |  57.76 |
| **comapeo/node-server**                  |  1389 |      1.03x |  33.92 |  94.88 |
| whatwg-node (native)                     |  1346 |      1.00x |  36.74 |  44.71 |

## Takeaways

- On 1MB streamed responses and uploads, all adapters are within about 25% of
  each other, apart from whatwg-node's bundled implementation on uploads.
- On tiny responses this package is the slowest, at 55–90% of the others'
  throughput. Its per-request path is kept simple (a fresh
  `AbortController`, a header copy and `Readable.fromWeb` for every request) and
  has no shortcut like Hono's cached responses.
