import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers.js'

test('getContext receives the raw IncomingMessage and its value reaches the handler', async () => {
  /** @type {string | undefined} */
  let remoteAddress
  /** @type {import('../src/index.js').FetchHandler<{ remoteDeviceId: string }>} */
  const handler = (_req, ctx) => new Response(ctx.remoteDeviceId)
  const srv = await startServer(handler, {
    getContext: (req) => {
      remoteAddress = req.socket.remoteAddress
      return { remoteDeviceId: 'device-123' }
    },
  })
  try {
    const res = await fetch(`${srv.base}/`)
    assert.equal(await res.text(), 'device-123')
    assert.equal(remoteAddress, '127.0.0.1')
  } finally {
    await srv.close()
  }
})

test('getContext is invoked once per request with an independent value', async () => {
  let calls = 0
  /** @type {import('../src/index.js').FetchHandler<{ id: number }>} */
  const handler = (_req, ctx) => new Response(String(ctx.id))
  const srv = await startServer(handler, {
    getContext: () => ({ id: ++calls }),
  })
  try {
    assert.equal(await (await fetch(`${srv.base}/`)).text(), '1')
    assert.equal(await (await fetch(`${srv.base}/`)).text(), '2')
    assert.equal(calls, 2)
  } finally {
    await srv.close()
  }
})

test('throwing in getContext responds 500 and reports to onError', async () => {
  /** @type {unknown[]} */
  const errors = []
  const srv = await startServer(() => new Response('unreached'), {
    getContext: () => {
      throw new Error('context boom')
    },
    onError: (e) => errors.push(e),
  })
  try {
    const res = await fetch(`${srv.base}/`)
    assert.equal(res.status, 500)
    assert.equal(errors.length, 1)
  } finally {
    await srv.close()
  }
})
