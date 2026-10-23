// The ONLY test that imports a router library. The adapter itself must remain
// agnostic — itty-router's `router.fetch(request, ctx)` simply happens to match
// the fetch-style `(Request, ctx) => Response` signature the adapter expects.
import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

import { AutoRouter } from 'itty-router'

import { startServer, waitFor } from './helpers.js'

function buildRouter() {
	const router = AutoRouter()

	// Streaming GET (tile-like): emits a fixed number of chunks.
	router.get('/tiles/:z', () => {
		let i = 0
		const body = new ReadableStream({
			pull(controller) {
				if (i++ >= 16) {
					controller.close()
					return
				}
				controller.enqueue(new Uint8Array(1024).fill(3))
			},
		})
		return new Response(body, {
			headers: { 'content-type': 'application/octet-stream' },
		})
	})

	// Large PUT upload into a WritableStream sink.
	router.put('/maps/:id', async (request) => {
		let count = 0
		await request.body?.pipeTo(
			new WritableStream({
				write(chunk) {
					count += chunk.byteLength
				},
			}),
		)
		return new Response(JSON.stringify({ bytes: count }), {
			headers: { 'content-type': 'application/json' },
		})
	})

	return router
}

/**
 * @template T
 * @param {(base: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withServer(fn) {
	const router = buildRouter()
	const srv = await startServer((req, ctx) => router.fetch(req, ctx))
	try {
		return await fn(srv.base)
	} finally {
		await srv.close()
	}
}

test('itty: streaming GET happy path', async () => {
	await withServer(async (base) => {
		const res = await fetch(`${base}/tiles/12`)
		assert.equal(res.status, 200)
		const buf = new Uint8Array(await res.arrayBuffer())
		assert.equal(buf.length, 16 * 1024)
	})
})

test('itty: large PUT upload happy path', async () => {
	await withServer(async (base) => {
		const total = 4 * 1024 * 1024
		const chunk = new Uint8Array(64 * 1024)
		let sent = 0
		const body = new ReadableStream({
			pull(controller) {
				if (sent >= total) {
					controller.close()
					return
				}
				controller.enqueue(chunk)
				sent += chunk.byteLength
			},
		})
		const res = await fetch(
			`${base}/maps/abc`,
			/** @type {RequestInit & { duplex: 'half' }} */ ({
				method: 'PUT',
				body,
				duplex: 'half',
			}),
		)
		const json = /** @type {{ bytes: number }} */ (await res.json())
		assert.equal(json.bytes, total)
	})
})

test('itty: SSE stream aborts when the client disconnects', async () => {
	let aborted = false
	const router = AutoRouter()
	router.get('/events', (request) => {
		request.signal.addEventListener('abort', () => {
			aborted = true
		})
		const body = new ReadableStream({
			start(controller) {
				const enc = new TextEncoder()
				const timer = setInterval(
					() => controller.enqueue(enc.encode('data: tick\n\n')),
					20,
				)
				request.signal.addEventListener('abort', () => clearInterval(timer))
			},
		})
		return new Response(body, {
			headers: { 'content-type': 'text/event-stream' },
		})
	})
	const srv = await startServer((req, ctx) => router.fetch(req, ctx))
	try {
		await new Promise((resolve) => {
			const client = http.get(`${srv.base}/events`, (res) => {
				res.once('data', () => {
					client.destroy()
					resolve(undefined)
				})
			})
			client.on('error', () => {})
		})
		await waitFor(() => aborted)
		assert.equal(aborted, true)
	} finally {
		await srv.close()
	}
})
