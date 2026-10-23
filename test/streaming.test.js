import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startServer, waitFor } from './helpers.js'

test('large streamed response body arrives intact', async () => {
  const chunks = 256
  const chunkSize = 16 * 1024
  const srv = await startServer(() => {
    let i = 0
    const body = new ReadableStream({
      pull(controller) {
        if (i++ >= chunks) {
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array(chunkSize).fill(7))
      },
    })
    return new Response(body)
  })
  try {
    const res = await fetch(`${srv.base}/`)
    const buf = new Uint8Array(await res.arrayBuffer())
    assert.equal(buf.length, chunks * chunkSize)
    assert.equal(buf[0], 7)
    assert.equal(buf[buf.length - 1], 7)
  } finally {
    await srv.close()
  }
})

test('HEAD request short-circuits the body', async () => {
  const srv = await startServer(
    () =>
      new Response('this body should not be pumped', {
        headers: { 'x-mark': '1' },
      }),
  )
  try {
    const res = await fetch(`${srv.base}/`, { method: 'HEAD' })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-mark'), '1')
    assert.equal(await res.text(), '')
  } finally {
    await srv.close()
  }
})

// A HEAD response must not pump the body, but the producer still holds resources
// (e.g. a file handle) that need releasing — so the body must be cancelled, not
// silently abandoned.
test('HEAD cancels an unsent response body so the producer can clean up', async () => {
  let cancelled = false
  const srv = await startServer(() => {
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024))
      },
      cancel() {
        cancelled = true
      },
    })
    return new Response(body, {
      headers: { 'content-type': 'application/octet-stream' },
    })
  })
  try {
    const res = await fetch(`${srv.base}/`, { method: 'HEAD' })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), '')
    await waitFor(() => cancelled)
    assert.equal(cancelled, true)
  } finally {
    await srv.close()
  }
})

test('null body response ends cleanly (204)', async () => {
  const srv = await startServer(() => new Response(null, { status: 204 }))
  try {
    const res = await fetch(`${srv.base}/`)
    assert.equal(res.status, 204)
    assert.equal(await res.text(), '')
  } finally {
    await srv.close()
  }
})

test('null-body statuses (205, 304) round-trip without a body', async () => {
  for (const status of [205, 304]) {
    const srv = await startServer(() => new Response(null, { status }))
    try {
      const res = await fetch(`${srv.base}/`)
      assert.equal(res.status, status)
      assert.equal(await res.text(), '')
    } finally {
      await srv.close()
    }
  }
})

// A handler that sets `transfer-encoding: chunked` on a streamed response must
// not produce a duplicate header (Node adds its own for chunked streams).
test('does not duplicate transfer-encoding: chunked', async () => {
  const srv = await startServer(() => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('chunk1'))
        c.enqueue(new TextEncoder().encode('chunk2'))
        c.close()
      },
    })
    return new Response(body, {
      headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
    })
  })
  try {
    const rawHeaders = /** @type {string[]} */ (
      await new Promise((resolve, reject) => {
        const req = http.request(
          { port: srv.port, host: '127.0.0.1', path: '/' },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.rawHeaders))
          },
        )
        req.on('error', reject)
        req.end()
      })
    )
    /** @type {string[]} */
    const transferEncodings = []
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
      if (rawHeaders[i].toLowerCase() === 'transfer-encoding') {
        transferEncodings.push(rawHeaders[i + 1])
      }
    }
    assert.deepEqual(transferEncodings, ['chunked'])
  } finally {
    await srv.close()
  }
})

test('a response body that errors mid-stream tears down the connection', async () => {
  const srv = await startServer(
    () => {
      let i = 0
      const body = new ReadableStream({
        pull(controller) {
          if (i++ === 0) {
            controller.enqueue(new Uint8Array(1024))
          } else {
            controller.error(new Error('producer boom'))
          }
        },
      })
      return new Response(body)
    },
    { onError() {} },
  )
  try {
    await assert.rejects(async () => {
      const res = await fetch(`${srv.base}/`)
      await res.arrayBuffer()
    })
  } finally {
    await srv.close()
  }
})

// An SSE or long-poll response may not produce its first chunk for a while;
// the status line and headers must not wait for it.
test('headers for a streaming response are sent before the first chunk', async () => {
  const srv = await startServer(
    () =>
      new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  )
  try {
    const client = http.get(`${srv.base}/`)
    client.on('error', () => {})
    const res = await /** @type {Promise<http.IncomingMessage>} */ (
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no headers')), 500)
        client.on('response', (res) => {
          clearTimeout(timer)
          resolve(res)
        })
      })
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'text/event-stream')
    client.destroy()
  } finally {
    await srv.close()
  }
})

test('a null body is framed with Content-Length: 0, except for 204 and 304', async () => {
  const srv = await startServer((req) => {
    const status = Number(new URL(req.url).searchParams.get('status'))
    return new Response(null, { status })
  })
  try {
    for (const [status, expected] of [
      [404, '0'],
      [201, '0'],
      [204, undefined],
      [304, undefined],
    ]) {
      const res = await fetch(`${srv.base}/?status=${status}`)
      assert.equal(res.status, status)
      assert.equal(res.headers.get('content-length') ?? undefined, expected)
      assert.equal(res.headers.get('transfer-encoding'), null)
    }
  } finally {
    await srv.close()
  }
})
