// Benchmark: @comapeo/node-server vs @whatwg-node/server and @hono/node-server.
//
// Every adapter serves the *same* fetch-style handler over node:http, so this
// isolates adapter overhead. Each adapter runs in its own child process:
// @hono/node-server replaces globalThis.Request/Response by default, which
// would otherwise change what every other adapter is measured with.
//
// Performance is explicitly NOT a goal for @comapeo/node-server (reliability and
// correct cancellation are). This is a sanity check that the native-globals
// adapter is in the same ballpark, not faster-at-all-costs.
//
// Usage: node bench/bench.mjs [durationMs] [concurrency]
//
// Prints one markdown table per scenario, fastest first.

import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { createAdapter } from '../src/index.js'
import { createServerAdapter } from '@whatwg-node/server'
import { getRequestListener as honoListenerV1 } from 'hono-node-server-v1'
import { getRequestListener as honoListenerV2 } from 'hono-node-server-v2'

const DURATION = Number(process.argv[2] ?? 3000)
const CONCURRENCY = Number(process.argv[3] ?? 50)
// Set when running as the child process for a single adapter.
const TARGET = process.argv[4]
const SELF = 'comapeo/node-server'

const ONE_MB = new Uint8Array(1024 * 1024).fill(0x61)

/** The shared handler exercised by every adapter. */
function handler(request) {
  const { pathname } = new URL(request.url)
  switch (pathname) {
    case '/hello':
      return new Response('hello world')
    case '/json':
      return Response.json({ ok: true, n: 42 })
    case '/stream': {
      let sent = 0
      const body = new ReadableStream({
        pull(controller) {
          if (sent >= 16) return controller.close()
          sent++
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x62))
        },
      })
      return new Response(body)
    }
    case '/echo':
      return request
        .arrayBuffer()
        .then((buf) => new Response(String(buf.byteLength)))
    default:
      return new Response('not found', { status: 404 })
  }
}

const nativeFetchAPI = {
  ReadableStream: globalThis.ReadableStream,
  WritableStream: globalThis.WritableStream,
  TransformStream: globalThis.TransformStream,
  Response: globalThis.Response,
  Request: globalThis.Request,
  Headers: globalThis.Headers,
  fetch: globalThis.fetch,
}

// Factories, so that only the adapter under test is ever constructed.
const targets = {
  [SELF]: () => createAdapter(handler),
  'whatwg-node (ponyfill)': () => createServerAdapter(handler),
  'whatwg-node (native)': () =>
    createServerAdapter(handler, { fetchAPI: nativeFetchAPI }),
  'hono/node-server v1': () => honoListenerV1(handler),
  'hono/node-server v2': () => honoListenerV2(handler),
  'hono/node-server v2 (no global override)': () =>
    honoListenerV2(handler, { overrideGlobalObjects: false }),
}

function listen(listener) {
  return new Promise((resolve) => {
    const server = http.createServer(listener)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

/** Fire keep-alive requests with a fixed concurrency pool for `DURATION` ms. */
async function loadtest({ port, path, method = 'GET', body }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY })
  const latencies = []
  let count = 0
  let errors = 0
  const deadline = Date.now() + DURATION

  function once() {
    return new Promise((resolve) => {
      const start = process.hrtime.bigint()
      const req = http.request(
        { port, path, method, agent, host: '127.0.0.1' },
        (res) => {
          res.on('data', () => {})
          res.on('end', () => {
            latencies.push(Number(process.hrtime.bigint() - start) / 1e6)
            count++
            resolve()
          })
          res.on('error', () => {
            errors++
            resolve()
          })
        },
      )
      req.on('error', () => {
        errors++
        resolve()
      })
      if (body) req.write(body)
      req.end()
    })
  }

  async function worker() {
    while (Date.now() < deadline) await once()
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  agent.destroy()

  latencies.sort((a, b) => a - b)
  const pct = (p) =>
    latencies[
      Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))
    ] ?? 0
  return {
    rps: Math.round((count / DURATION) * 1000),
    p50: +pct(50).toFixed(2),
    p99: +pct(99).toFixed(2),
    errors,
  }
}

const scenarios = [
  { name: 'GET /hello (tiny)', path: '/hello' },
  { name: 'GET /json', path: '/json' },
  { name: 'GET /stream (1MB)', path: '/stream' },
  { name: 'POST /echo (1MB)', path: '/echo', method: 'POST', body: ONE_MB },
]

if (TARGET) {
  const results = {}
  for (const scenario of scenarios) {
    const { server, port } = await listen(targets[TARGET]())
    await loadtest({ ...scenario, port }) // warmup
    results[scenario.name] = await loadtest({ ...scenario, port })
    server.close()
  }
  process.stdout.write(JSON.stringify(results))
} else {
  const self = fileURLToPath(import.meta.url)
  const byTarget = {}
  for (const name of Object.keys(targets)) {
    console.error(`running ${name}…`)
    const args = [self, String(DURATION), String(CONCURRENCY), name]
    byTarget[name] = JSON.parse(
      execFileSync(process.execPath, args, { encoding: 'utf8' }),
    )
  }

  console.log(
    `Node ${process.version}, ${DURATION}ms per scenario, concurrency ${CONCURRENCY}\n`,
  )
  for (const scenario of scenarios) {
    const rows = Object.entries(byTarget)
      .map(([name, results]) => ({ name, ...results[scenario.name] }))
      .sort((a, b) => b.rps - a.rps)
    const slowest = Math.min(...rows.map((r) => r.rps))
    console.log(`#### ${scenario.name}\n`)
    console.log('| adapter | req/s | vs slowest | p50 ms | p99 ms |')
    console.log('| --- | ---: | ---: | ---: | ---: |')
    for (const r of rows) {
      if (r.errors) console.error(`${r.name}: ${r.errors} failed requests`)
      const name = r.name === SELF ? `**${r.name}**` : r.name
      const ratio = `${(r.rps / slowest).toFixed(2)}x`
      console.log(`| ${name} | ${r.rps} | ${ratio} | ${r.p50} | ${r.p99} |`)
    }
    console.log('')
  }
}
