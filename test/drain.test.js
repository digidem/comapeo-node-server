import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { test } from 'node:test'

import { drainRequest } from '../src/drain.js'
import { startServer, waitFor } from './helpers.js'

/**
 * One request over a keep-alive agent limited to a single socket, so a second
 * call reuses the connection (or hangs if the first left it unframed).
 *
 * @param {http.Agent} agent
 * @param {string} base
 * @param {{ method?: string, body?: Buffer }} [init]
 * @returns {Promise<number>}
 */
function request(agent, base, { method = 'GET', body } = {}) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('request hung')), 2000)
		const req = http.request(base, { method, agent }, (res) => {
			clearTimeout(timer)
			res.resume()
			res.on('end', () => resolve(/** @type {number} */ (res.statusCode)))
		})
		req.on('error', (err) => {
			clearTimeout(timer)
			reject(err)
		})
		req.end(body)
	})
}

// Once `Readable.toWeb` has attached to `req`, Node no longer dumps an unread
// body on response finish, and the paused wrapper would leave the connection
// stuck with an unframed body. The 4KB case in basic.test.js fits in buffers
// and never hit this.
test('an unread 1MB request body does not stall a keep-alive connection', async () => {
	const srv = await startServer(() => new Response('rejected', { status: 413 }))
	const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
	let connections = 0
	srv.server.on('connection', () => connections++)
	try {
		const first = await request(agent, srv.base, {
			method: 'POST',
			body: Buffer.alloc(1024 * 1024),
		})
		assert.equal(first, 413)
		assert.equal(await request(agent, srv.base), 413)
		assert.equal(connections, 1)
	} finally {
		agent.destroy()
		await srv.close()
	}
})

// Both @hono/node-server and @whatwg-node/server treat the response as the end
// of the request body's life; a read still in flight must fail clearly rather
// than hang or silently truncate.
test('reading the body after the response has finished rejects with AbortError', async () => {
	/** @type {unknown} */
	let readError
	let done = false
	const srv = await startServer((req) => {
		void req.body
			?.pipeTo(
				// Slow sink: `pipeTo` cannot abort while a write is in flight.
				new WritableStream({
					write: () => new Promise((r) => setTimeout(r, 20)),
				}),
			)
			.catch((err) => (readError = err))
			.finally(() => (done = true))
		return new Response(null, { status: 202 })
	})
	const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
	let connections = 0
	srv.server.on('connection', () => connections++)
	try {
		assert.equal(
			await request(agent, srv.base, {
				method: 'POST',
				body: Buffer.alloc(1024 * 1024),
			}),
			202,
		)
		await waitFor(() => done)
		assert.equal(/** @type {Error} */ (readError).name, 'AbortError')
		assert.equal(await request(agent, srv.base), 202)
		assert.equal(connections, 1)
	} finally {
		agent.destroy()
		await srv.close()
	}
})

// `Readable.toWeb`'s cancel destroys `req` (and with it the socket); ours
// drains instead. `for await … break` and a failed `pipeTo` both cancel.
for (const [name, handler] of Object.entries({
	'body.cancel()': async (/** @type {Request} */ req) => {
		await req.body?.cancel()
		return new Response('ok')
	},
	'for await … break': async (/** @type {Request} */ req) => {
		if (req.body) {
			for await (const chunk of req.body) {
				if (chunk) break
			}
		}
		return new Response('ok')
	},
	'pipeTo to a failing sink': async (/** @type {Request} */ req) => {
		await req.body
			?.pipeTo(
				new WritableStream({
					write() {
						throw new Error('disk full')
					},
				}),
			)
			.catch(() => {})
		return new Response('ok')
	},
	'abandoned reader': async (/** @type {Request} */ req) => {
		await req.body?.getReader().read()
		return new Response('ok')
	},
})) {
	test(`${name} then responding keeps the connection usable`, async () => {
		const srv = await startServer(handler)
		const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
		let connections = 0
		srv.server.on('connection', () => connections++)
		try {
			assert.equal(
				await request(agent, srv.base, {
					method: 'POST',
					body: Buffer.alloc(1024 * 1024),
				}),
				200,
			)
			assert.equal(await request(agent, srv.base), 200)
			assert.equal(connections, 1)
		} finally {
			agent.destroy()
			await srv.close()
		}
	})
}

test('a body that cannot be drained promptly closes the connection after the response', async () => {
	const srv = await startServer(() => new Response('rejected', { status: 413 }))
	try {
		const client = http.request(srv.base, {
			method: 'POST',
			headers: { 'content-length': String(10 * 1024 * 1024) },
		})
		client.on('error', () => {})
		const res = await new Promise((resolve) => {
			client.on('response', resolve)
			// Send part of the body, then stall.
			client.write(Buffer.alloc(1024 * 1024))
		})
		assert.equal(res.statusCode, 413)
		res.resume()
		// Well inside Node's 5s keepAliveTimeout, which would otherwise mask a
		// drain deadline that never fired.
		await new Promise((resolve, reject) => {
			setTimeout(() => reject(new Error('socket not closed')), 2000)
			res.socket?.once('close', resolve)
		})
	} finally {
		await srv.close()
	}
})

// Cancelling must not start the drain deadline: a handler that cancels and
// then takes a while to answer, while the client is still uploading, must
// still get its response through.
test('a slow response after cancelling the body is still delivered', async () => {
	const srv = await startServer(async (req) => {
		await req.body?.cancel()
		await new Promise((r) => setTimeout(r, 800))
		return new Response('rejected', { status: 413 })
	})
	try {
		const client = http.request(srv.base, {
			method: 'POST',
			headers: { 'content-length': String(4 * 64 * 1024) },
		})
		const response = new Promise((resolve, reject) => {
			client.on('response', resolve)
			client.on('error', reject)
		})
		for (let i = 0; i < 4; i++) {
			client.write(Buffer.alloc(64 * 1024))
			await new Promise((r) => setTimeout(r, 300))
		}
		client.end()
		const res = /** @type {http.IncomingMessage} */ (await response)
		assert.equal(res.statusCode, 413)
		res.resume()
	} finally {
		await srv.close()
	}
})

/**
 * Send a request head declaring a 10MB body, then 1MB of it, then stall.
 * Resolve with the status line once the server closes the connection.
 *
 * @param {number} port
 * @param {string} head
 * @returns {Promise<string>}
 */
function stalledUpload(port, head) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1', () => {
			socket.write(`${head}\r\nContent-Length: ${10 * 1024 * 1024}\r\n\r\n`)
			socket.write(Buffer.alloc(1024 * 1024))
		})
		let received = ''
		socket.setEncoding('utf8')
		socket.on('data', (chunk) => (received += chunk))
		socket.on('error', () => {})
		socket.on('close', () => resolve(received.split('\r\n')[0] ?? ''))
		setTimeout(() => {
			socket.destroy()
			reject(new Error('socket not closed'))
		}, 2000)
	})
}

test('a request rejected before the handler runs is drained within limits', async () => {
	const srv = await startServer(() => new Response('unreached'))
	try {
		const status = await stalledUpload(
			srv.port,
			'POST / HTTP/1.1\r\nHost: bad host',
		)
		assert.match(status, /^HTTP\/1\.1 400\b/)
	} finally {
		await srv.close()
	}
})

test('a GET body the handler never sees is drained within limits', async () => {
	const srv = await startServer(() => new Response('ok'))
	try {
		const status = await stalledUpload(srv.port, 'GET / HTTP/1.1\r\nHost: x')
		assert.match(status, /^HTTP\/1\.1 200\b/)
	} finally {
		await srv.close()
	}
})

test('a body that arrives slowly after the response is still drained', async () => {
	const srv = await startServer(() => new Response('rejected', { status: 413 }))
	try {
		const out = await new Promise((resolve, reject) => {
			const socket = net.connect(srv.port, '127.0.0.1', async () => {
				socket.write(
					'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 4096\r\n\r\n',
				)
				socket.write(Buffer.alloc(1024))
				await new Promise((r) => socket.once('data', r))
				// The rest of the body trickles in over ~300ms, inside the deadline.
				for (let i = 0; i < 3; i++) {
					await new Promise((r) => setTimeout(r, 100))
					socket.write(Buffer.alloc(1024))
				}
				socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
			})
			let received = ''
			socket.setEncoding('utf8')
			socket.on('data', (chunk) => (received += chunk))
			socket.on('close', () => resolve(received))
			socket.on('error', reject)
		})
		assert.equal(
			/** @type {string} */ (out).match(/HTTP\/1\.1 413/g)?.length,
			2,
		)
	} finally {
		await srv.close()
	}
})

/**
 * @param {object} socket
 * @returns {http.IncomingMessage}
 */
function fakeRequest(socket) {
	const req = Object.assign(new EventEmitter(), {
		readableEnded: false,
		destroyed: false,
		socket,
		resume() {},
	})
	return /** @type {http.IncomingMessage} */ (/** @type {unknown} */ (req))
}

test('a body past the 64MB drain limit closes the connection at once', () => {
	let closed = false
	const req = fakeRequest({
		destroyed: false,
		destroySoon: () => (closed = true),
	})
	drainRequest(req)
	const mb = Buffer.alloc(1024 * 1024)
	for (let i = 0; i < 64; i++) req.emit('data', mb)
	assert.equal(closed, false)
	req.emit('data', Buffer.alloc(1))
	assert.equal(closed, true)
})

test('a mocked socket without destroySoon is destroyed instead', () => {
	let destroyed = false
	const req = fakeRequest({
		destroyed: false,
		destroy: () => (destroyed = true),
	})
	drainRequest(req)
	req.emit('data', Buffer.alloc(64 * 1024 * 1024 + 1))
	assert.equal(destroyed, true)
})
