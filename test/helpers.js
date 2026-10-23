import http from 'node:http'
import net from 'node:net'
import { createAdapter } from '../src/index.js'

/**
 * @typedef {object} TestServer
 * @property {string} base
 * @property {number} port
 * @property {http.Server} server
 * @property {() => Promise<void>} close
 */

/**
 * Start an http server wired to the adapter and resolve once it is listening.
 *
 * @template [Ctx=undefined]
 * @param {import('../src/index.js').FetchHandler<Ctx>} handler
 * @param {import('../src/index.js').AdapterOptions<Ctx>} [options]
 * @returns {Promise<TestServer>}
 */
export async function startServer(handler, options) {
  const server = http.createServer(createAdapter(handler, options))
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  )
  const { port } = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  )
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    server,
    close() {
      return new Promise((resolve, reject) => {
        // A connection still open after the grace period is a leak, or a test
        // that failed before closing its client: fail instead of hanging.
        const timer = setTimeout(() => {
          server.closeAllConnections()
          reject(new Error('server closed with connections still open'))
        }, 1000)
        server.close((err) => {
          clearTimeout(timer)
          if (err) reject(err)
          else resolve(undefined)
        })
      })
    },
  }
}

/**
 * Poll until `predicate()` is true or `timeout` ms elapse.
 *
 * @param {() => boolean} predicate
 * @param {number} [timeout]
 * @returns {Promise<void>}
 */
export async function waitFor(predicate, timeout = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * @template [T=void]
 * @returns {{ promise: Promise<T>, resolve: (value: T) => void, reject: (err: unknown) => void }}
 */
export function deferred() {
  /** @type {(value: T) => void} */
  let resolve = () => {}
  /** @type {(err: unknown) => void} */
  let reject = () => {}
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Write raw bytes to the server and resolve with everything it sends back
 * before closing the connection, or after `timeout` ms.
 *
 * @param {number} port
 * @param {string} data
 * @param {number} [timeout]
 * @returns {Promise<string>}
 */
export function rawRequest(port, data, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(data))
    let received = ''
    const timer = setTimeout(() => socket.destroy(), timeout)
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => (received += chunk))
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(received)
    })
    socket.on('error', (err) => {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ECONNRESET')
        return
      reject(err)
    })
  })
}
