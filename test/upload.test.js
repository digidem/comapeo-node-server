import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { deferred, startServer, waitFor } from './helpers.js'

test('request.body is a real ReadableStream', async () => {
  let wasStream = false
  const srv = await startServer(async (req) => {
    wasStream = req.body instanceof ReadableStream
    await req.arrayBuffer()
    return new Response('ok')
  })
  try {
    await fetch(`${srv.base}/`, { method: 'POST', body: 'hello' })
    assert.equal(wasStream, true)
  } finally {
    await srv.close()
  }
})

test('a large PUT body (32MB) arrives intact', async () => {
  const total = 32 * 1024 * 1024
  const srv = await startServer(async (req) => {
    let count = 0
    const sink = new WritableStream({
      write(chunk) {
        count += chunk.byteLength
      },
    })
    await req.body?.pipeTo(sink)
    return new Response(String(count))
  })
  try {
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
      `${srv.base}/maps/x`,
      /** @type {RequestInit & { duplex: 'half' }} */ ({
        method: 'PUT',
        body,
        duplex: 'half',
      }),
    )
    assert.equal(await res.text(), String(total))
  } finally {
    await srv.close()
  }
})

// Mirrors comapeo-map-server's PUT /maps/:mapId upload, where the handler does
// `request.body.pipeTo(writable)` and `writable.abort()` deletes the temp file.
// A client disconnect mid-upload MUST abort the destination so no temp leaks.
test('client disconnect mid-upload aborts the pipeTo destination (temp cleanup)', async () => {
  /** @type {unknown} */
  let abortReason
  const started = deferred()
  const srv = await startServer(async (req) => {
    started.resolve()
    const writable = new WritableStream({
      write() {
        /* simulate writing to a temp file */
      },
      abort(reason) {
        abortReason = reason
      },
    })
    await req.body?.pipeTo(writable)
    return new Response(null, { status: 200 })
  })
  try {
    const client = http.request(`${srv.base}/maps/custom`, {
      method: 'PUT',
      headers: { 'content-length': String(50 * 1024 * 1024) },
    })
    client.on('error', () => {})
    client.write(Buffer.alloc(64 * 1024))
    await started.promise
    client.destroy()
    await waitFor(() => abortReason !== undefined)
    const err = /** @type {Error & { code?: string }} */ (abortReason)
    assert.equal(err.code, 'ECONNRESET')
  } finally {
    await srv.close()
  }
})

test('the handler sees the first chunk before the upload has finished', async () => {
  const srv = await startServer(async (req) => {
    const reader = /** @type {ReadableStream<Uint8Array>} */ (
      req.body
    ).getReader()
    const { value } = await reader.read()
    await reader.cancel()
    return new Response(String(value?.byteLength))
  })
  try {
    const client = http.request(srv.base, {
      method: 'POST',
      headers: { 'content-length': String(1024 * 1024) },
    })
    client.on('error', () => {})
    const response = new Promise((resolve, reject) => {
      client.on('response', resolve)
      setTimeout(
        () => reject(new Error('no response before upload ended')),
        1000,
      )
    })
    // Only 16KB of the declared 1MB is ever sent.
    client.write(Buffer.alloc(16 * 1024))
    const res = /** @type {http.IncomingMessage} */ (await response)
    assert.equal(res.statusCode, 200)
    res.resume()
    client.destroy()
  } finally {
    await srv.close()
  }
})
