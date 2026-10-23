import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

import { deferred, startServer, waitFor } from './helpers.js'

test('client disconnect mid-request-body aborts request.signal', async () => {
	let aborted = false
	const started = deferred()
	const srv = await startServer(async (req) => {
		started.resolve()
		await new Promise((resolve) => {
			req.signal.addEventListener('abort', () => {
				aborted = true
				resolve(undefined)
			})
		})
		return new Response('done')
	})
	try {
		const client = http.request(`${srv.base}/upload`, {
			method: 'POST',
			headers: { 'content-length': '1000' },
		})
		client.on('error', () => {})
		client.write('partial-body')
		await started.promise
		client.destroy()
		await waitFor(() => aborted)
		assert.equal(aborted, true)
	} finally {
		await srv.close()
	}
})

test('client disconnect mid-response cancels the response body producer', async () => {
	/** @type {unknown} */
	let cancelReason = Symbol('uncalled')
	const srv = await startServer(() => {
		const body = new ReadableStream({
			pull(controller) {
				controller.enqueue(new Uint8Array(8 * 1024).fill(1))
				return new Promise((r) => setTimeout(r, 20))
			},
			cancel(reason) {
				cancelReason = reason
			},
		})
		return new Response(body)
	})
	try {
		await new Promise((resolve) => {
			const client = http.get(`${srv.base}/stream`, (res) => {
				res.once('data', () => {
					client.destroy()
					resolve(undefined)
				})
			})
			client.on('error', () => {})
		})
		await waitFor(() => typeof cancelReason !== 'symbol')
		assert.ok(cancelReason instanceof Error)
		assert.equal(
			/** @type {{ code?: string }} */ (cancelReason).code,
			'ECONNRESET',
		)
	} finally {
		await srv.close()
	}
})

// Mirrors @whatwg-node/server's incremental-cancellation test: read several
// chunks, then abort, and assert the producer's cancel runs exactly once.
test('cancels the response body exactly once after reading several chunks', async () => {
	let cancelCount = 0
	const srv = await startServer(() => {
		const body = new ReadableStream({
			pull(controller) {
				controller.enqueue(new Uint8Array(4 * 1024).fill(1))
				return new Promise((r) => setTimeout(r, 20))
			},
			cancel() {
				cancelCount++
			},
		})
		return new Response(body)
	})
	try {
		await new Promise((resolve) => {
			const client = http.get(`${srv.base}/stream`, (res) => {
				let chunks = 0
				res.on('data', () => {
					if (++chunks >= 3) {
						client.destroy()
						resolve(undefined)
					}
				})
			})
			client.on('error', () => {})
		})
		await waitFor(() => cancelCount > 0)
		// Give any erroneous extra cancellations a chance to land before asserting.
		await new Promise((r) => setTimeout(r, 50))
		assert.equal(cancelCount, 1)
	} finally {
		await srv.close()
	}
})

// A handler awaiting the body must see the read reject when the client
// disconnects mid-upload (so e.g. a `pipeTo` rejects and cleanup runs).
test('body read rejects with a connection error when the client disconnects mid-upload', async () => {
	/** @type {unknown} */
	let readError
	const started = deferred()
	const srv = await startServer(async (req) => {
		started.resolve()
		try {
			await req.arrayBuffer()
		} catch (err) {
			readError = err
		}
		return new Response('done')
	})
	try {
		const client = http.request(`${srv.base}/upload`, {
			method: 'POST',
			headers: { 'content-length': String(10 * 1024 * 1024) },
		})
		client.on('error', () => {})
		client.write(Buffer.alloc(64 * 1024))
		await started.promise
		client.destroy()
		await waitFor(() => readError !== undefined)
		const err = /** @type {Error & { code?: string }} */ (readError)
		assert.equal(err.code, 'ECONNRESET')
		assert.notEqual(err.name, 'AbortError')
	} finally {
		await srv.close()
	}
})

test('signal.reason is a connection error on client disconnect', async () => {
	/** @type {unknown} */
	let reason
	const srv = await startServer((req) => {
		req.signal.addEventListener('abort', () => {
			reason = req.signal.reason
		})
		const body = new ReadableStream({
			pull(controller) {
				controller.enqueue(new Uint8Array(1024))
				return new Promise((r) => setTimeout(r, 20))
			},
		})
		return new Response(body)
	})
	try {
		await new Promise((resolve) => {
			const client = http.get(`${srv.base}/stream`, (res) => {
				res.once('data', () => {
					client.destroy()
					resolve(undefined)
				})
			})
			client.on('error', () => {})
		})
		await waitFor(() => reason !== undefined)
		// Node's own error (`aborted`) or the adapter's equivalent: the same shape
		// either way, and never an AbortError, which would read as a local cancel.
		assert.ok(reason instanceof Error)
		assert.equal(/** @type {{ code?: string }} */ (reason).code, 'ECONNRESET')
		assert.notEqual(reason.name, 'AbortError')
	} finally {
		await srv.close()
	}
})

test('normal completion does NOT abort the signal', async () => {
	/** @type {AbortSignal | undefined} */
	let signal
	const srv = await startServer((req) => {
		signal = req.signal
		return new Response('ok')
	})
	try {
		const res = await fetch(`${srv.base}/`)
		assert.equal(await res.text(), 'ok')
		// Give res 'close' a tick to fire after the response finished.
		await new Promise((r) => setTimeout(r, 30))
		assert.ok(signal)
		assert.equal(signal?.aborted, false)
	} finally {
		await srv.close()
	}
})

test('client disconnect mid-response is not reported to onError', async () => {
	/** @type {unknown[]} */
	const errors = []
	let cancelled = false
	const srv = await startServer(
		() =>
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.enqueue(new Uint8Array(4 * 1024))
						return new Promise((r) => setTimeout(r, 20))
					},
					cancel() {
						cancelled = true
					},
				}),
			),
		{ onError: (e) => errors.push(e) },
	)
	try {
		await new Promise((resolve) => {
			const client = http.get(`${srv.base}/`, (res) => {
				res.once('data', () => {
					client.destroy()
					resolve(undefined)
				})
			})
			client.on('error', () => {})
		})
		await waitFor(() => cancelled)
		await new Promise((r) => setTimeout(r, 50))
		assert.deepEqual(errors, [])
	} finally {
		await srv.close()
	}
})

// The handler may only notice the disconnect after it has built its response;
// the body it hands back must still be cancelled so the producer cleans up.
test('a response produced after the client disconnected is cancelled', async () => {
	let cancelled = false
	const started = deferred()
	const srv = await startServer(async (req) => {
		started.resolve()
		await new Promise((resolve) =>
			req.signal.addEventListener('abort', resolve, { once: true }),
		)
		return new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(1024))
				},
				cancel() {
					cancelled = true
				},
			}),
		)
	})
	try {
		const client = http.get(`${srv.base}/`)
		client.on('error', () => {})
		await started.promise
		client.destroy()
		await waitFor(() => cancelled)
	} finally {
		await srv.close()
	}
})

// Mirrors comapeo-map-server's map-share sender: a source piped through a
// TransformStream whose readable is the response body, with the `pipeTo`
// rejection classified as a dropped connection (`ECONNRESET`) versus the
// sender's own cancel (`AbortError`). The adapter's cancel reason reaches that
// `pipeTo`, so it must be a connection error and never an `AbortError`.
test('the cancel reason a client disconnect propagates to a piped producer is a connection error', async () => {
	/** @type {unknown} */
	let pipeError
	const srv = await startServer(() => {
		const source = new ReadableStream({
			pull(controller) {
				controller.enqueue(new Uint8Array(1024))
				return new Promise((r) => setTimeout(r, 10))
			},
		})
		const { readable, writable } = new TransformStream()
		source.pipeTo(writable).catch((err) => (pipeError = err))
		return new Response(readable)
	})
	try {
		await new Promise((resolve) => {
			const client = http.get(`${srv.base}/`, (res) => {
				res.once('data', () => {
					client.destroy()
					resolve(undefined)
				})
			})
			client.on('error', () => {})
		})
		await waitFor(() => pipeError !== undefined)
		const err = /** @type {Error & { code?: string }} */ (pipeError)
		assert.equal(err.code, 'ECONNRESET')
		assert.notEqual(err.name, 'AbortError')
	} finally {
		await srv.close()
	}
})

test('a disconnect the handler wraps in its own error is not reported', async () => {
	/** @type {unknown[]} */
	const errors = []
	const started = deferred()
	const failed = deferred()
	const srv = await startServer(
		async (request) => {
			const reader = /** @type {ReadableStream<Uint8Array>} */ (
				request.body
			).getReader()
			await reader.read()
			started.resolve()
			try {
				while (!(await reader.read()).done);
			} catch (err) {
				failed.resolve()
				throw new Error('upload failed', { cause: err })
			}
			return new Response('done')
		},
		{ onError: (err) => errors.push(err) },
	)
	try {
		const client = http.request(`${srv.base}/upload`, {
			method: 'POST',
			headers: { 'content-length': '100000' },
		})
		client.on('error', () => {})
		client.write('partial-body')
		await started.promise
		client.destroy()
		await failed.promise
		await new Promise((r) => setImmediate(r))
		assert.deepEqual(errors, [])
	} finally {
		await srv.close()
	}
})

test('a disconnect the handler rethrows is not reported', async () => {
	/** @type {unknown[]} */
	const errors = []
	const started = deferred()
	const failed = deferred()
	const srv = await startServer(
		async (request) => {
			started.resolve()
			try {
				await request.arrayBuffer()
			} finally {
				failed.resolve()
			}
			return new Response('done')
		},
		{ onError: (err) => errors.push(err) },
	)
	try {
		const client = http.request(`${srv.base}/upload`, {
			method: 'POST',
			headers: { 'content-length': '100000' },
		})
		client.on('error', () => {})
		client.write('partial-body')
		await started.promise
		client.destroy()
		await failed.promise
		await new Promise((r) => setImmediate(r))
		assert.deepEqual(errors, [])
	} finally {
		await srv.close()
	}
})

test('an unrelated error after a disconnect is still reported', async () => {
	/** @type {unknown[]} */
	const errors = []
	const started = deferred()
	const bug = new Error('handler bug')
	const srv = await startServer(
		async (request) => {
			started.resolve()
			await request.arrayBuffer().catch(() => {})
			throw bug
		},
		{ onError: (err) => errors.push(err) },
	)
	try {
		const client = http.request(`${srv.base}/upload`, {
			method: 'POST',
			headers: { 'content-length': '100000' },
		})
		client.on('error', () => {})
		client.write('partial-body')
		await started.promise
		client.destroy()
		await waitFor(() => errors.length > 0)
		assert.deepEqual(errors, [bug])
	} finally {
		await srv.close()
	}
})

// Node only sets `req.errored` while the request is still being read, so a
// disconnect after the body was fully read takes the adapter's own error.
test('a disconnect after the request body was fully read is a connection error', async () => {
	/** @type {unknown} */
	let reason
	const srv = await startServer(async (req) => {
		await req.arrayBuffer()
		req.signal.addEventListener('abort', () => (reason = req.signal.reason))
		return new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(1024))
					return new Promise((r) => setTimeout(r, 10))
				},
			}),
		)
	})
	try {
		await new Promise((resolve) => {
			const client = http.request(`${srv.base}/`, { method: 'POST' }, (res) => {
				res.once('data', () => {
					client.destroy()
					resolve(undefined)
				})
			})
			client.on('error', () => {})
			client.end('body')
		})
		await waitFor(() => reason !== undefined)
		const err = /** @type {Error & { code?: string }} */ (reason)
		assert.equal(err.code, 'ECONNRESET')
		assert.notEqual(err.name, 'AbortError')
	} finally {
		await srv.close()
	}
})
