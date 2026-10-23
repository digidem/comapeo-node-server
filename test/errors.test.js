import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import { rawRequest, startServer } from './helpers.js'
import {
  ContextFailed,
  InvalidHost,
  InvalidResponse,
  isAdapterError,
  ResponseLengthMismatch,
} from '../src/index.js'

const execFile = promisify(execFileCb)

test('handler throws synchronously -> 500', async () => {
  /** @type {unknown[]} */
  const errors = []
  const srv = await startServer(
    () => {
      throw new Error('sync boom')
    },
    { onError: (e) => errors.push(e) },
  )
  try {
    const res = await fetch(`${srv.base}/`)
    assert.equal(res.status, 500)
    assert.equal(errors.length, 1)
  } finally {
    await srv.close()
  }
})

test('handler returns a non-Response -> 500', async () => {
  /** @type {unknown[]} */
  const errors = []
  const srv = await startServer(
    // @ts-expect-error intentionally wrong return type
    () => ({ not: 'a response' }),
    { onError: (e) => errors.push(e) },
  )
  try {
    const res = await fetch(`${srv.base}/`)
    assert.equal(res.status, 500)
    assert.ok(errors[0] instanceof InvalidResponse)
  } finally {
    await srv.close()
  }
})

test('TimeoutError before headers -> 504', async () => {
  const srv = await startServer(
    () => {
      const err = new Error('slow')
      err.name = 'TimeoutError'
      throw err
    },
    { onError() {} },
  )
  try {
    const res = await fetch(`${srv.base}/`)
    assert.equal(res.status, 504)
  } finally {
    await srv.close()
  }
})

test('producer error after headers sent is reported to onError', async () => {
  /** @type {unknown[]} */
  const errors = []
  const srv = await startServer(
    () => {
      let i = 0
      const body = new ReadableStream({
        pull(controller) {
          if (i++ === 0) controller.enqueue(new Uint8Array(1024))
          else controller.error(new Error('late boom'))
        },
      })
      return new Response(body)
    },
    { onError: (e) => errors.push(e) },
  )
  try {
    await assert.rejects(async () => {
      const res = await fetch(`${srv.base}/`)
      await res.arrayBuffer()
    })
    assert.equal(errors.length, 1)
    assert.equal(/** @type {Error} */ (errors[0]).message, 'late boom')
  } finally {
    await srv.close()
  }
})

// If a handler returns a Response whose body was already read/locked, converting
// it throws. Because the conversion happens before headers are committed, this
// must surface as a clean 500 rather than a 200 status line followed by a reset.
test('an already-disturbed response body -> 500, not a truncated 200', async () => {
  /** @type {unknown[]} */
  const errors = []
  const srv = await startServer(
    () => {
      const body = new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1))
          controller.close()
        },
      })
      const res = new Response(body)
      res.body?.getReader() // disturb + lock the body before returning it
      return res
    },
    { onError: (e) => errors.push(e) },
  )
  try {
    const res = await fetch(`${srv.base}/`)
    assert.equal(res.status, 500)
    assert.equal(errors.length, 1)
  } finally {
    await srv.close()
  }
})

// A handler given the raw ServerResponse (via getContext) may commit the
// response itself. If it then throws, the adapter has already lost the chance to
// send a 500, so it must reset the socket rather than write headers twice.
test('handler that commits headers itself then throws -> socket reset, reported once', async () => {
  /** @type {unknown[]} */
  const errors = []
  const boom = new Error('boom after headers')
  /** @type {import('../src/index.js').FetchHandler<import('node:http').ServerResponse>} */
  const handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.flushHeaders()
    throw boom
  }
  const srv = await startServer(handler, {
    getContext: (_req, res) => res,
    onError: (e) => errors.push(e),
  })
  try {
    await assert.rejects(async () => {
      const res = await fetch(`${srv.base}/`)
      await res.text()
    })
    assert.equal(errors.length, 1)
    assert.equal(errors[0], boom)
  } finally {
    await srv.close()
  }
})

test('malformed Host header -> 400', async () => {
  const srv = await startServer(() => new Response('unreached'))
  try {
    const statusLine = await new Promise((resolve, reject) => {
      const socket = net.connect(srv.port, '127.0.0.1', () => {
        socket.write(
          'GET / HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\n\r\n',
        )
      })
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', (c) => (data += c))
      socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''))
      socket.on('error', reject)
    })
    assert.match(/** @type {string} */ (statusLine), /^HTTP\/1\.1 400\b/)
  } finally {
    await srv.close()
  }
})

/** @type {Array<[string, string, (() => Response) | null, string, number, boolean]>} */
const adapterErrorCases = [
  // [name, request head, handler, code, status, has a cause]
  [
    'bad Host',
    'GET / HTTP/1.1\r\nHost: bad host',
    null,
    'INVALID_HOST',
    400,
    false,
  ],
  [
    'out-of-range port',
    'GET / HTTP/1.1\r\nHost: a:99999',
    null,
    'INVALID_HOST',
    400,
    false,
  ],
  [
    'bad target',
    'GET http://user:pw@a/ HTTP/1.1\r\nHost: a',
    null,
    'INVALID_REQUEST_TARGET',
    400,
    false,
  ],
  [
    'TRACE',
    'TRACE / HTTP/1.1\r\nHost: a',
    null,
    'METHOD_NOT_SUPPORTED',
    501,
    false,
  ],
  [
    'non-Response',
    'GET / HTTP/1.1\r\nHost: a',
    () => /** @type {Response} */ (/** @type {unknown} */ ('nope')),
    'INVALID_RESPONSE',
    500,
    false,
  ],
  [
    'Response.error()',
    'GET / HTTP/1.1\r\nHost: a',
    () => Response.error(),
    'INVALID_RESPONSE',
    500,
    false,
  ],
  [
    'locked body',
    'GET / HTTP/1.1\r\nHost: a',
    () => {
      const response = new Response('x')
      response.body?.getReader()
      return response
    },
    'RESPONSE_SEND_FAILED',
    500,
    true,
  ],
  [
    'Content-Length with no body',
    'GET / HTTP/1.1\r\nHost: a',
    () => new Response(null, { headers: { 'content-length': '3' } }),
    'RESPONSE_LENGTH_MISMATCH',
    500,
    false,
  ],
]

for (const [name, head, handler, code, status, hasCause] of adapterErrorCases) {
  test(`${name} -> ${status}, reported with code ${code}`, async () => {
    /** @type {unknown[]} */
    const errors = []
    const srv = await startServer(
      handler ?? (() => new Response('unreached')),
      {
        onError: (e) => errors.push(e),
      },
    )
    try {
      const out = await rawRequest(
        srv.port,
        `${head}\r\nConnection: close\r\n\r\n`,
      )
      assert.equal(out.slice(9, 12), String(status))
      assert.equal(errors.length, 1)
      assert.ok(isAdapterError(errors[0]))
      const err = /** @type {Error & { code: string, status: number }} */ (
        errors[0]
      )
      assert.equal(err.code, code)
      assert.equal(err.status, status)
      assert.equal(err.cause !== undefined, hasCause)
    } finally {
      await srv.close()
    }
  })
}

test('getContext throwing is reported as CONTEXT_FAILED with the cause', async () => {
  /** @type {unknown[]} */
  const errors = []
  const boom = new Error('boom')
  const srv = await startServer(() => new Response('unreached'), {
    getContext: () => {
      throw boom
    },
    onError: (e) => errors.push(e),
  })
  try {
    const res = await fetch(`${srv.base}/`)
    assert.equal(res.status, 500)
    assert.ok(errors[0] instanceof ContextFailed)
    assert.equal(errors[0].cause, boom)
  } finally {
    await srv.close()
  }
})

test('a body that overruns its Content-Length is reported as RESPONSE_LENGTH_MISMATCH', async () => {
  /** @type {unknown[]} */
  const errors = []
  const srv = await startServer(
    () => new Response('hello world', { headers: { 'content-length': '3' } }),
    { onError: (e) => errors.push(e) },
  )
  try {
    await rawRequest(srv.port, 'GET / HTTP/1.1\r\nHost: a\r\n\r\n', 500)
    assert.ok(errors[0] instanceof ResponseLengthMismatch)
  } finally {
    await srv.close()
  }
})

test('errors thrown by the handler are passed through unchanged', async () => {
  /** @type {unknown[]} */
  const errors = []
  // Even with an adapter error's code, a handler error must not choose the
  // response status.
  const boom = Object.assign(new Error('boom'), {
    status: 418,
    code: 'INVALID_HOST',
  })
  const srv = await startServer(
    () => {
      throw boom
    },
    { onError: (e) => errors.push(e) },
  )
  try {
    const res = await fetch(`${srv.base}/`)
    assert.equal(res.status, 500)
    assert.deepEqual(errors, [boom])
    assert.equal(isAdapterError(boom), false)
  } finally {
    await srv.close()
  }
})

// Committing headers via the raw `res` and then also returning a Response is a
// handler bug; the second status line cannot be sent, so reset instead.
test('handler that commits headers itself then returns a Response -> socket reset, reported once', async () => {
  /** @type {unknown[]} */
  const errors = []
  let cancelled = false
  /** @type {import('../src/index.js').FetchHandler<import('node:http').ServerResponse>} */
  const handler = (_req, res) => {
    res.writeHead(200)
    res.flushHeaders()
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
    )
  }
  const srv = await startServer(handler, {
    getContext: (_req, res) => res,
    onError: (e) => errors.push(e),
  })
  try {
    await assert.rejects(async () => {
      const res = await fetch(`${srv.base}/`)
      await res.text()
    })
    assert.equal(errors.length, 1)
    assert.equal(cancelled, true)
  } finally {
    await srv.close()
  }
})

// `onError` must not throw. If it does, the client still gets its status, and
// the error surfaces once as an uncaught exception, never swallowed. Run in a
// child process: node:test would otherwise fail this file on that exception.
for (const stage of ['handler', 'getContext']) {
  test(`a throwing onError surfaces as an uncaught exception after the response (${stage})`, async () => {
    const script = `
    import http from 'node:http'
    import { createAdapter } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)}
    const seen = []
    process.on('uncaughtException', (err) => seen.push(err.message))
    process.on('unhandledRejection', (err) => seen.push('unhandled: ' + err.message))
    const boom = () => { throw new Error('${stage} boom') }
    const server = http.createServer(
      createAdapter(boom, {
        getContext: ${stage === 'getContext' ? 'boom' : 'undefined'},
        onError() { throw new Error('logger boom') },
      }),
    )
    server.listen(0, '127.0.0.1', async () => {
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/')
      await new Promise((r) => setTimeout(r, 20))
      console.log(JSON.stringify({ status: res.status, seen }))
      server.closeAllConnections()
      server.close()
    })
  `
    const { stdout } = await execFile(process.execPath, [
      '--input-type=module',
      '-e',
      script,
    ])
    assert.deepEqual(JSON.parse(stdout), { status: 500, seen: ['logger boom'] })
  })
}

test('onError runs after the client has its status', async () => {
  /** @type {import('node:http').ServerResponse | undefined} */
  let res
  /** @type {boolean[]} */
  const sentWhenReported = []
  const srv = await startServer(
    () => {
      throw new Error('boom')
    },
    {
      getContext: (_req, r) => {
        res = r
      },
      onError: () => sentWhenReported.push(Boolean(res?.headersSent)),
    },
  )
  try {
    const response = await fetch(`${srv.base}/`)
    assert.equal(response.status, 500)
    assert.deepEqual(sentWhenReported, [true])
  } finally {
    await srv.close()
  }
})

test('a handler that errors its own body with an AbortError is reported, and the socket reset', async () => {
  /** @type {unknown[]} */
  const errors = []
  const srv = await startServer(
    () => {
      let sent = false
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent) {
              controller.error(new DOMException('stopped', 'AbortError'))
            } else {
              sent = true
              controller.enqueue(new Uint8Array(1024))
            }
          },
        }),
      )
    },
    { onError: (e) => errors.push(e) },
  )
  try {
    await assert.rejects(async () => {
      const res = await fetch(`${srv.base}/`)
      await res.arrayBuffer()
    })
    assert.equal(errors.length, 1)
    assert.equal(/** @type {Error} */ (errors[0]).name, 'AbortError')
  } finally {
    await srv.close()
  }
})

test('every exported error class is recognised by isAdapterError', async () => {
  const exports = Object.values(await import('../src/index.js'))
  const classes = exports.filter(
    (value) => typeof value === 'function' && 'code' in value,
  )
  assert.equal(classes.length, 7)
  for (const ErrorClass of classes) {
    const Ctor = /** @type {new (params: object) => Error} */ (ErrorClass)
    assert.ok(isAdapterError(new Ctor({})), Ctor.name)
  }
})

test('isAdapterError recognises errors from another copy of the package', async () => {
  // A different specifier loads a second, independent module instance.
  const specifier = '../src/errors.js?copy'
  const copy = /** @type {typeof import('../src/errors.js')} */ (
    await import(specifier)
  )
  const err = new copy.InvalidHost({ host: 'x' })
  assert.equal(err instanceof InvalidHost, false)
  assert.equal(isAdapterError(err), true)
})

test('isAdapterError is false for plain errors and non-objects', () => {
  for (const value of [new Error('x'), { code: 'INVALID_HOST' }, null, 'x']) {
    assert.equal(isAdapterError(value), false)
  }
})
