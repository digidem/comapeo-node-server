// Direct (socket-free) driver: calls the adapter listener with mock req/res so
// the profile/timing reflects adapter + undici Request/Response overhead only,
// not the HTTP client or kernel socket I/O.
//
//   node bench/profile-direct.mjs 500000
//   node --cpu-prof --cpu-prof-dir=bench/prof --cpu-prof-name=direct.cpuprofile \
//        bench/profile-direct.mjs 500000
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { createAdapter } from '../src/index.js'

const N = Number(process.argv[2] ?? 500000)

const listener = createAdapter(() => new Response('hello world'))

// Minimal IncomingMessage stand-in: a GET with the headers the adapter reads.
function makeReq() {
	const req = new Readable({ read() {} })
	req.method = 'GET'
	req.url = '/hello'
	req.headers = { host: '127.0.0.1' }
	req.rawHeaders = ['Host', '127.0.0.1', 'Connection', 'keep-alive']
	req.socket = { encrypted: false }
	req.push(null)
	return req
}

// Minimal ServerResponse stand-in: swallows writes, resolves when ended.
function makeRes(onDone) {
	const res = new EventEmitter()
	res.writableEnded = false
	res.headersSent = false
	res.destroyed = false
	res.writeHead = () => {
		res.headersSent = true
		return res
	}
	res.write = () => true
	res.end = () => {
		res.writableEnded = true
		res.emit('close')
		onDone()
		return res
	}
	res.destroy = () => {
		res.destroyed = true
		res.emit('close')
		onDone()
	}
	// node Readable.pipe(res) calls res.write/end and listens for drain.
	res.on('pipe', () => {})
	return res
}

function once() {
	return new Promise((resolve) => {
		const req = makeReq()
		const res = makeRes(resolve)
		listener(req, res)
	})
}

const start = process.hrtime.bigint()
for (let i = 0; i < N; i++) await once()
const ms = Number(process.hrtime.bigint() - start) / 1e6
console.log(
	`${N} direct calls in ${ms.toFixed(0)}ms = ${Math.round((N / ms) * 1000)} calls/s`,
)
