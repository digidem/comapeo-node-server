import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

import { startServer } from './helpers.js'

test('forwards the request content-length header to the handler', async () => {
	const srv = await startServer(
		(req) => new Response(req.headers.get('content-length') ?? 'none'),
	)
	try {
		const withBody = await fetch(`${srv.base}/`, {
			method: 'POST',
			body: 'Hello World',
		})
		assert.equal(await withBody.text(), '11')
		const empty = await fetch(`${srv.base}/`, { method: 'POST', body: '' })
		assert.equal(await empty.text(), '0')
	} finally {
		await srv.close()
	}
})

test('duplicate request headers are preserved (combined)', async () => {
	const srv = await startServer(
		(req) => new Response(req.headers.get('x-multi')),
	)
	try {
		const res = await fetch(`${srv.base}/`, {
			headers: [
				['x-multi', 'a'],
				['x-multi', 'b'],
			],
		})
		assert.equal(await res.text(), 'a, b')
	} finally {
		await srv.close()
	}
})

test('multiple Set-Cookie response headers round-trip as separate headers', async () => {
	const srv = await startServer(() => {
		const headers = new Headers()
		headers.append('set-cookie', 'a=1; Path=/')
		headers.append('set-cookie', 'b=2; Path=/')
		return new Response('ok', { headers })
	})
	try {
		const res = await fetch(`${srv.base}/`)
		const cookies = res.headers.getSetCookie()
		assert.deepEqual(cookies, ['a=1; Path=/', 'b=2; Path=/'])
	} finally {
		await srv.close()
	}
})

test('statusText is forwarded', async () => {
	const srv = await startServer(
		() => new Response('teapot', { status: 418, statusText: 'I am a teapot' }),
	)
	try {
		const res = await fetch(`${srv.base}/`)
		assert.equal(res.status, 418)
		assert.equal(res.statusText, 'I am a teapot')
	} finally {
		await srv.close()
	}
})

// Duplicates follow Node's `req.headers` rules rather than a blanket `, ` join.
test('duplicate Cookie headers join with "; " and singleton headers keep the first', async () => {
	const srv = await startServer(
		(req) =>
			new Response(
				`${req.headers.get('cookie')}|${req.headers.get('authorization')}`,
			),
	)
	try {
		const body = await new Promise((resolve, reject) => {
			const req = http.request(
				srv.base,
				{
					headers: [
						'host',
						'127.0.0.1',
						'cookie',
						'a=1',
						'cookie',
						'b=2',
						'authorization',
						'x',
						'authorization',
						'y',
					],
				},
				(res) => {
					let data = ''
					res.setEncoding('utf8')
					res.on('data', (c) => (data += c))
					res.on('end', () => resolve(data))
				},
			)
			req.on('error', reject)
			req.end()
		})
		assert.equal(body, 'a=1; b=2|x')
	} finally {
		await srv.close()
	}
})
