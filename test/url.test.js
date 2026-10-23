import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rawRequest, startServer } from './helpers.js'

/**
 * Send a raw request head and return the status code and the URL the handler
 * saw, if it ran.
 *
 * @param {string} head
 * @param {import('../src/index.js').AdapterOptions<undefined>} [options]
 */
async function probe(head, options) {
  /** @type {string | undefined} */
  let url
  const srv = await startServer((request) => {
    url = request.url
    return new Response('ok')
  }, options)
  try {
    const out = await rawRequest(
      srv.port,
      `${head}\r\nConnection: close\r\n\r\n`,
    )
    return { status: Number(out.slice(9, 12)), url }
  } finally {
    await srv.close()
  }
}

test('an absolute-form target cannot change the scheme', async () => {
  const r = await probe(
    'GET https://other.example/admin HTTP/1.1\r\nHost: good.example',
  )
  assert.deepEqual(r, { status: 200, url: 'http://other.example/admin' })
})

test('an absolute-form target gets https from the https option', async () => {
  const r = await probe('GET http://a.example/x HTTP/1.1\r\nHost: a.example', {
    https: true,
  })
  assert.deepEqual(r, { status: 200, url: 'https://a.example/x' })
})

test('a fragment in the target is dropped', async () => {
  const r = await probe('GET /a?b=1#frag HTTP/1.1\r\nHost: x')
  assert.deepEqual(r, { status: 200, url: 'http://x/a?b=1' })
})

test('more than one Host header is a 400', async () => {
  const r = await probe('GET / HTTP/1.1\r\nHost: a.example\r\nHost: b.example')
  assert.deepEqual(r, { status: 400, url: undefined })
})

test('composes the URL from the Host header and the path', async () => {
  for (const [host, target, url] of [
    ['localhost', '/a/b', 'http://localhost/a/b'],
    ['localhost:8080', '/x', 'http://localhost:8080/x'],
    ['127.0.0.1', '/', 'http://127.0.0.1/'],
    ['LOCALHOST', '/x', 'http://localhost/x'],
    ['[::1]', '/x', 'http://[::1]/x'],
    ['[::1]:8080', '/x', 'http://[::1]:8080/x'],
    ['localhost', '/static/../foo.txt', 'http://localhost/foo.txt'],
    ['localhost', '/a/./b/../c', 'http://localhost/a/c'],
    ['localhost', '/static\\..\\foo.txt', 'http://localhost/foo.txt'],
  ]) {
    const r = await probe(`GET ${target} HTTP/1.1\r\nHost: ${host}`)
    assert.deepEqual(r, { status: 200, url }, `${host} ${target}`)
  }
})

test('drops the default port for the scheme', async () => {
  const r = await probe('GET /x HTTP/1.1\r\nHost: [2001:db8::1]:443', {
    https: true,
  })
  assert.deepEqual(r, { status: 200, url: 'https://[2001:db8::1]/x' })
})

test('ignores x-forwarded headers', async () => {
  const r = await probe(
    'GET /x HTTP/1.1\r\nHost: a.example\r\n' +
      'X-Forwarded-Proto: https\r\nX-Forwarded-Host: b.example',
  )
  assert.deepEqual(r, { status: 200, url: 'http://a.example/x' })
})

test('a Host that could smuggle into the URL is a 400', async () => {
  for (const host of [
    '',
    'a b',
    'localhost/foo',
    'localhost?x=1',
    'user@host',
    'localhost#x',
    'localhost:65536',
  ]) {
    const r = await probe(`GET / HTTP/1.1\r\nHost: ${host}`)
    assert.deepEqual(r, { status: 400, url: undefined }, JSON.stringify(host))
  }
})

test('a missing Host is a 400, including on HTTP/1.0', async () => {
  for (const version of ['1.1', '1.0']) {
    const r = await probe(`GET / HTTP/${version}`)
    assert.deepEqual(r, { status: 400, url: undefined }, version)
  }
})

test('a target that is neither a path nor an http(s) URL is a 400', async () => {
  for (const [method, target] of [
    ['OPTIONS', '*'],
    ['GET', 'evil.com'],
    ['GET', 'javascript:alert(1)'],
    ['GET', 'ftp://x/y'],
    ['GET', 'http://user:pw@proxy.example/x'],
  ]) {
    const r = await probe(`${method} ${target} HTTP/1.1\r\nHost: localhost`)
    assert.deepEqual(r, { status: 400, url: undefined }, target)
  }
})

test('an invalid Host or target is truncated in the reported error', async () => {
  const long = 'a'.repeat(300)
  for (const [head, label, value] of [
    [`GET / HTTP/1.1\r\nHost: ${long} b`, 'Host header', long],
    [
      `GET ftp://${long} HTTP/1.1\r\nHost: localhost`,
      'request target',
      `ftp://${long}`,
    ],
  ]) {
    /** @type {unknown[]} */
    const errors = []
    await probe(head, { onError: (err) => errors.push(err) })
    assert.equal(
      /** @type {Error} */ (errors[0]).message,
      `Invalid ${label}: ${value.slice(0, 200)}…`,
    )
  }
})
