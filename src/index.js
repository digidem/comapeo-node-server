import { toRequest } from './to-request.js'
import { writeResponseHead } from './response-head.js'
import {
  connectionReset,
  ContextFailed,
  InvalidResponse,
  isAdapterError,
  ResponseSendFailed,
} from './errors.js'
import { drainRequest } from './drain.js'

export {
  ContextFailed,
  InvalidHost,
  InvalidRequestTarget,
  InvalidResponse,
  isAdapterError,
  MethodNotSupported,
  ResponseLengthMismatch,
  ResponseSendFailed,
} from './errors.js'

/**
 * @template [Ctx=unknown]
 * @typedef {(request: Request, context: Ctx) => Response | Promise<Response>} FetchHandler
 */

/**
 * @template Ctx
 * @typedef {object} AdapterOptions
 * @property {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Ctx} [getContext]
 *   Build the per-request context passed as the second arg to the handler. Called
 *   synchronously, before the `Request` is constructed. Throwing responds 500.
 * @property {boolean | ((req: import('node:http').IncomingMessage) => boolean)} [https]
 *   Treat the request as HTTPS (sets the URL scheme). Defaults to detecting
 *   `req.socket.encrypted`. Set behind a trusted TLS-terminating proxy.
 * @property {(err: unknown, req: import('node:http').IncomingMessage) => void} [onError]
 *   Notified of any error the adapter caught while running the handler or
 *   (de)serializing the request/response. The adapter has already chosen the
 *   HTTP outcome (a 4xx/5xx, or a socket reset once headers are sent); this is
 *   an out-of-band hook for logging/reporting, not error recovery. Defaults to
 *   a no-op.
 */

/** @returns {void} */
function noop() {}

/**
 * @param {AdapterOptions<unknown>['https']} https
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function resolveHttps(https, req) {
  if (typeof https === 'function') return https(req)
  if (typeof https === 'boolean') return https
  return Boolean(/** @type {{ encrypted?: boolean }} */ (req.socket).encrypted)
}

/**
 * Respond with an empty `status` if nothing has been committed yet; otherwise
 * reset the socket. (`headersSent` is set by `writeHead`, before the headers
 * are flushed, so a stream that errors before its first chunk also resets.)
 *
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} err
 * @param {number} status
 * @returns {void}
 */
function fail(res, err, status) {
  if (res.writableEnded || res.destroyed) return
  if (res.headersSent) {
    res.destroy(err instanceof Error ? err : new Error(String(err)))
    return
  }
  res.writeHead(status, { 'content-length': '0' })
  res.end()
}

/**
 * @param {unknown} err
 * @returns {number}
 */
function statusFor(err) {
  if (isAdapterError(err)) return err.status
  return err instanceof Error && err.name === 'TimeoutError' ? 504 : 500
}

/**
 * Create a `node:http` request listener that runs a fetch-style handler.
 *
 * @template [Ctx=undefined]
 * @param {FetchHandler<Ctx>} handler
 * @param {AdapterOptions<Ctx>} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createAdapter(handler, options = {}) {
  const onError = options.onError ?? noop
  /**
   * A throwing `onError` surfaces once as an uncaught exception, rather than
   * being swallowed or becoming an unhandled rejection.
   *
   * @param {unknown} err
   * @param {import('node:http').IncomingMessage} req
   */
  const report = (err, req) => {
    try {
      onError(err, req)
    } catch (hookErr) {
      process.nextTick(() => {
        throw hookErr
      })
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {void}
   */
  return function listener(req, res) {
    const controller = new AbortController()
    /** @type {import('node:stream').Readable | null} */
    let piping = null
    // Set once a request body stream exists; it then drains the body itself.
    let bodyOwned = false

    // Every other path (an early error, a GET that carries a body) must still
    // be bounded by the drain limits, not left to Node's unlimited dump.
    res.on('finish', () => {
      if (!bodyOwned) drainRequest(req)
    })

    /**
     * The disconnect itself is not reportable: the error the signal aborted
     * with, or one the handler wrapped it in.
     *
     * @param {unknown} err
     * @returns {boolean}
     */
    const isDisconnect = (err) => {
      if (!controller.signal.aborted) return false
      for (let e = err, depth = 0; e != null && depth < 10; depth++) {
        if (e === controller.signal.reason) return true
        e = /** @type {{ cause?: unknown }} */ (e).cause
      }
      return false
    }

    // A client disconnect at any stage (mid-upload included) closes `res`,
    // with `req.errored` already set when Node raised an error.
    res.on('close', () => {
      if (res.writableFinished) return
      // `res.errored` is set when the adapter destroyed the response itself
      // (a failed body producer); a client disconnect leaves it null.
      const reason = res.errored ?? req.errored ?? connectionReset()
      controller.abort(reason)
      // Cancels the web stream behind `Readable.fromWeb` with the same reason.
      piping?.destroy(reason)
    })

    void run()

    async function run() {
      try {
        const context = getContext()
        const request = toRequest(
          req,
          res,
          controller.signal,
          resolveHttps(options.https, req),
        )
        bodyOwned = request.body !== null
        const response = await handler(request, context)
        if (!(response instanceof Response)) {
          throw new InvalidResponse({ what: 'a value that is not a Response' })
        }
        // The client left, or `getContext` ended `res` itself.
        if (res.destroyed || res.writableEnded) {
          response.body?.cancel(controller.signal.reason).catch(noop)
          return
        }
        const node = writeHead(response, request.method)
        if (node) pipeBody(node)
      } catch (err) {
        fail(res, err, statusFor(err))
        if (!isDisconnect(err)) report(err, req)
      }
    }

    /** @returns {Ctx} */
    function getContext() {
      try {
        return options.getContext
          ? options.getContext(req, res)
          : /** @type {Ctx} */ (undefined)
      } catch (cause) {
        throw new ContextFailed(undefined, { cause })
      }
    }

    /**
     * @param {Response} response
     * @param {string} method
     */
    function writeHead(response, method) {
      try {
        return writeResponseHead(res, response, method)
      } catch (cause) {
        if (isAdapterError(cause)) throw cause
        throw new ResponseSendFailed(undefined, { cause })
      }
    }

    /** @param {import('node:stream').Readable} node */
    function pipeBody(node) {
      piping = node
      node.on('error', (err) => {
        if (!res.destroyed) res.destroy(err)
        if (!isDisconnect(err)) report(err, req)
      })
      // `pipe`, not `pipeline`: the 'close' listener above already cancels the
      // producer with the disconnect reason, which `pipeline` would replace with
      // a generic premature-close error, and `pipe` is cheaper.
      node.pipe(res)
      // Headers only go out with the first chunk. Let one that is already
      // available coalesce with them (cheaper), but do not let an SSE or
      // long-poll response sit with no status line until its first event.
      setImmediate(() => {
        if (!node.readableDidRead && !res.writableEnded && !res.destroyed) {
          res.flushHeaders()
        }
      })
    }
  }
}
