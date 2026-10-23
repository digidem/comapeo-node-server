import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { rawRequest, startServer } from './helpers.js'

/**
 * Two pipelined requests on one connection, so a framing error in the first
 * response shows up as a corrupted second one.
 *
 * @param {number} port
 * @param {string} path
 */
function twoRequests(port, path) {
	return rawRequest(
		port,
		`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n` +
			'GET /ok HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
	)
}

/** @param {(path: string) => Response} route */
function server(route) {
	/** @type {unknown[]} */
	const errors = []
	const srv = startServer(
		(request) => {
			const { pathname } = new URL(request.url)
			return pathname === '/ok' ? new Response('second') : route(pathname)
		},
		{ onError: (err) => errors.push(err) },
	)
	return { srv, errors }
}

test('a body longer than its Content-Length resets the connection', async () => {
	const { srv: s, errors } = server(
		() => new Response('hello world', { headers: { 'content-length': '3' } }),
	)
	const srv = await s
	try {
		const out = await twoRequests(srv.port, '/')
		assert.doesNotMatch(out, /second/)
		assert.doesNotMatch(out, /lo world/)
		assert.equal(errors.length, 1)
	} finally {
		await srv.close()
	}
})

test('a body shorter than its Content-Length resets the connection', async () => {
	const { srv: s, errors } = server(
		() => new Response('hi', { headers: { 'content-length': '10' } }),
	)
	const srv = await s
	try {
		const out = await twoRequests(srv.port, '/')
		assert.doesNotMatch(out, /second/)
		assert.equal(errors.length, 1)
	} finally {
		await srv.close()
	}
})

test('a body matching its Content-Length keeps the connection usable', async () => {
	const { srv: s, errors } = server(
		() => new Response('hello', { headers: { 'content-length': '5' } }),
	)
	const srv = await s
	try {
		const out = await twoRequests(srv.port, '/')
		assert.match(out, /^HTTP\/1\.1 200 OK\r\n[^]*\r\n\r\nhelloHTTP\/1\.1 200/)
		assert.match(out, /second/)
		assert.deepEqual(errors, [])
	} finally {
		await srv.close()
	}
})

test('a non-zero Content-Length with no body is a 500', async () => {
	const { srv: s, errors } = server(
		() => new Response(null, { headers: { 'content-length': '5' } }),
	)
	const srv = await s
	try {
		const out = await twoRequests(srv.port, '/')
		assert.match(out, /^HTTP\/1\.1 500\b/)
		assert.match(out, /second/)
		assert.equal(errors.length, 1)
	} finally {
		await srv.close()
	}
})

test('a 204 never carries a Content-Length', async () => {
	const { srv: s } = server(
		() =>
			new Response(null, { status: 204, headers: { 'content-length': '5' } }),
	)
	const srv = await s
	try {
		const out = await twoRequests(srv.port, '/')
		assert.match(out, /^HTTP\/1\.1 204\b/)
		assert.doesNotMatch(out.split('\r\n\r\n')[0] ?? '', /content-length/i)
		assert.match(out, /second/)
	} finally {
		await srv.close()
	}
})

test('HEAD keeps the declared Content-Length without sending a body', async () => {
	const srv = await startServer(
		() => new Response('hello', { headers: { 'content-length': '5' } }),
	)
	try {
		const out = await rawRequest(
			srv.port,
			'HEAD / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
		)
		assert.match(out, /content-length: 5\r\n/i)
		assert.ok(out.endsWith('\r\n\r\n'))
	} finally {
		await srv.close()
	}
})

test('a transfer coding without chunked is still framed', async () => {
	const gz = gzipSync('hello world')
	const { srv: s } = server(
		() => new Response(gz, { headers: { 'transfer-encoding': 'gzip' } }),
	)
	const srv = await s
	try {
		const out = await twoRequests(srv.port, '/')
		assert.match(out, /transfer-encoding: gzip, chunked\r\n/i)
		assert.match(out, /second/)
	} finally {
		await srv.close()
	}
})

test('a handler Transfer-Encoding replaces its Content-Length', async () => {
	const { srv: s, errors } = server(
		() =>
			new Response('hello', {
				headers: { 'transfer-encoding': 'chunked', 'content-length': '99' },
			}),
	)
	const srv = await s
	try {
		const out = await twoRequests(srv.port, '/')
		assert.doesNotMatch(out, /content-length: 99/i)
		assert.match(out, /second/)
		assert.deepEqual(errors, [])
	} finally {
		await srv.close()
	}
})

test('Response.error() is a 500, reported', async () => {
	const { srv: s, errors } = server(() => Response.error())
	const srv = await s
	try {
		const out = await twoRequests(srv.port, '/')
		assert.match(out, /^HTTP\/1\.1 500\b/)
		assert.equal(errors.length, 1)
	} finally {
		await srv.close()
	}
})

test('error responses are framed with Content-Length: 0', async () => {
	const srv = await startServer(() => {
		throw new Error('boom')
	})
	try {
		const out = await rawRequest(
			srv.port,
			'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
		)
		assert.match(out, /^HTTP\/1\.1 500\b[^]*content-length: 0\r\n/i)
		assert.doesNotMatch(out, /transfer-encoding/i)
	} finally {
		await srv.close()
	}
})

test('a non-numeric Content-Length is a 500', async () => {
	const { srv: s, errors } = server(
		() => new Response('hello', { headers: { 'content-length': 'abc' } }),
	)
	const srv = await s
	try {
		const out = await twoRequests(srv.port, '/')
		assert.match(out, /^HTTP\/1\.1 500\b/)
		assert.equal(errors.length, 1)
	} finally {
		await srv.close()
	}
})
