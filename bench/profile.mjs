// CPU-profile driver for @comapeo/node-server's hot path.
//
// Drives a large number of tiny requests through the adapter in-process so a
// V8 CPU profile attributes time to adapter internals, not the load client.
//
// Usage:
//   node --cpu-prof --cpu-prof-dir=bench/prof --cpu-prof-name=hello.cpuprofile \
//        bench/profile.mjs /hello 200000
//   node bench/profile.mjs /hello 200000           # no profiler, just timing

import http from 'node:http'
import { createAdapter } from '../src/index.js'

const PATH = process.argv[2] ?? '/hello'
const N = Number(process.argv[3] ?? 200000)
const CONCURRENCY = Number(process.argv[4] ?? 50)

function handler(request) {
  const { pathname } = new URL(request.url)
  if (pathname === '/json') return Response.json({ ok: true, n: 42 })
  return new Response('hello world')
}

const server = http.createServer(createAdapter(handler))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY })

function once() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { port, path: PATH, agent, host: '127.0.0.1' },
      (res) => {
        res.on('data', () => {})
        res.on('end', resolve)
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

let done = 0
async function worker() {
  while (done < N) {
    done++
    await once()
  }
}

const start = process.hrtime.bigint()
await Promise.all(Array.from({ length: CONCURRENCY }, worker))
const ms = Number(process.hrtime.bigint() - start) / 1e6

agent.destroy()
server.close()
console.log(
  `${PATH}: ${done} requests in ${ms.toFixed(0)}ms = ${Math.round((done / ms) * 1000)} req/s`,
)
