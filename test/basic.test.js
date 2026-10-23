import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers.js'

test('GET: url composition, method, status, body', async () => {
  const srv = await startServer(
    (req) =>
      new Response(JSON.stringify({ url: req.url, method: req.method }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
  )
  try {
    const res = await fetch(`${srv.base}/foo/bar?x=1&y=2`)
    assert.equal(res.status, 201)
    const body = /** @type {{ url: string, method: string }} */ (
      await res.json()
    )
    assert.equal(body.method, 'GET')
    const url = new URL(body.url)
    assert.equal(url.protocol, 'http:')
    assert.equal(url.pathname, '/foo/bar')
    assert.equal(url.search, '?x=1&y=2')
    assert.equal(url.host, `127.0.0.1:${srv.port}`)
  } finally {
    await srv.close()
  }
})

test('https option forces the URL scheme to https', async () => {
  const srv = await startServer(
    (req) => new Response(new URL(req.url).protocol),
    { https: true },
  )
  try {
    const res = await fetch(`${srv.base}/`)
    assert.equal(await res.text(), 'https:')
  } finally {
    await srv.close()
  }
})

test('default scheme is http when socket is not encrypted', async () => {
  const srv = await startServer(
    (req) => new Response(new URL(req.url).protocol),
  )
  try {
    const res = await fetch(`${srv.base}/`)
    assert.equal(await res.text(), 'http:')
  } finally {
    await srv.close()
  }
})

test('early return without reading the request body delivers the response', async () => {
  const srv = await startServer(() => new Response('rejected', { status: 422 }))
  try {
    const res = await fetch(`${srv.base}/`, {
      method: 'POST',
      body: 'x'.repeat(4096),
    })
    assert.equal(res.status, 422)
    assert.equal(await res.text(), 'rejected')
  } finally {
    await srv.close()
  }
})

test('handles DELETE (no body) and PATCH (with body)', async () => {
  const srv = await startServer(async (req) => {
    const body = req.body ? await req.text() : ''
    return new Response(`${req.method}:${body}`)
  })
  try {
    const del = await fetch(`${srv.base}/x`, { method: 'DELETE' })
    assert.equal(await del.text(), 'DELETE:')
    const patch = await fetch(`${srv.base}/x`, {
      method: 'PATCH',
      body: 'payload',
    })
    assert.equal(await patch.text(), 'PATCH:payload')
  } finally {
    await srv.close()
  }
})

test('https option can be a per-request function', async () => {
  const srv = await startServer(
    (req) => new Response(new URL(req.url).protocol),
    { https: (req) => req.url === '/secure' },
  )
  try {
    assert.equal(await (await fetch(`${srv.base}/secure`)).text(), 'https:')
    assert.equal(await (await fetch(`${srv.base}/plain`)).text(), 'http:')
  } finally {
    await srv.close()
  }
})

test('a protocol-relative-looking target stays a path on the request host', async () => {
  const srv = await startServer((req) => new Response(req.url))
  try {
    const url = new URL(await (await fetch(`${srv.base}//evil.com/x`)).text())
    assert.equal(url.host, `127.0.0.1:${srv.port}`)
    assert.equal(url.pathname, '//evil.com/x')
  } finally {
    await srv.close()
  }
})

// Like a client-side `fetch`, a request without Content-Length or
// Transfer-Encoding has no body at all, rather than an empty stream.
test('request.body is null when the request carries no body', async () => {
  const srv = await startServer(
    (req) => new Response(req.body === null ? 'null' : 'stream'),
  )
  try {
    assert.equal(
      await (await fetch(`${srv.base}/`, { method: 'DELETE' })).text(),
      'null',
    )
    assert.equal(
      await (await fetch(`${srv.base}/`, { method: 'POST', body: '' })).text(),
      'stream',
    )
  } finally {
    await srv.close()
  }
})
