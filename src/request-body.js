import { connectionReset } from './errors.js'
import { drainRequest } from './drain.js'

/**
 * Expose `req` as a web `ReadableStream`. Not `Readable.toWeb`: its cancel
 * destroys the socket, and cancel is what a failed `pipeTo` or a `for await`
 * `break` does. Here cancel only stops reading, and the rest is drained once
 * the response has finished.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {ReadableStream<Uint8Array>}
 */
export function requestBody(req, res) {
  /** @type {ReadableStreamDefaultController<Uint8Array>} */
  let controller

  /** @param {Buffer} chunk */
  const onData = (chunk) => {
    controller.enqueue(chunk)
    // One chunk per pull (`highWaterMark: 0`).
    req.pause()
  }
  const onEnd = () => {
    detach()
    controller.close()
  }
  /** @param {Error} err */
  const onError = (err) => {
    detach()
    controller.error(err)
  }
  const onClose = () => onError(req.errored ?? connectionReset())
  function detach() {
    req.off('data', onData)
    req.off('end', onEnd)
    req.off('error', onError)
    req.off('close', onClose)
    // A pull may have resumed `req` just before a cancel; with no listener left
    // it would otherwise flow uncapped instead of waiting under backpressure.
    req.pause()
  }

  res.on('finish', () => {
    if (req.readableEnded) return
    // No-op if the stream is already closed or errored.
    controller.error(
      new DOMException(
        'Response finished before the request body was read',
        'AbortError',
      ),
    )
    detach()
    drainRequest(req)
  })

  return new ReadableStream(
    {
      start(c) {
        controller = c
        req.on('data', onData)
        req.on('end', onEnd)
        req.on('error', onError)
        req.on('close', onClose)
        // Adding a 'data' listener starts the flow; hold it until pulled.
        req.pause()
      },
      pull() {
        req.resume()
      },
      cancel: detach,
    },
    { highWaterMark: 0 },
  )
}
