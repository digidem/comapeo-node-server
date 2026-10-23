// Same limits as @hono/node-server: enough to keep a keep-alive connection
// usable after a typical early rejection, without reading a huge upload to
// the end just to reuse the socket.
const MAX_DRAIN_BYTES = 64 * 1024 * 1024
const DRAIN_TIMEOUT_MS = 500

/** @type {WeakSet<import('node:http').IncomingMessage>} */
const draining = new WeakSet()

/**
 * Read and discard the rest of a request body so the connection stays framed
 * for keep-alive, mirroring Node's own `req._dump()`. If the body is too large
 * or too slow to drain, close the connection instead. The caller must have
 * removed its own 'data' listeners first.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {void}
 */
export function drainRequest(req) {
	if (req.readableEnded || req.destroyed || draining.has(req)) return
	draining.add(req)
	let bytes = 0
	const cleanup = () => {
		clearTimeout(timer)
		req.off('data', onData)
		req.off('end', cleanup)
		req.off('close', cleanup)
	}
	const closeConnection = () => {
		cleanup()
		const socket = req.socket
		if (!socket || socket.destroyed) return
		// Mocked sockets (e.g. light-my-request) may lack `destroySoon`.
		if (typeof socket.destroySoon === 'function') socket.destroySoon()
		else socket.destroy()
	}
	const timer = setTimeout(closeConnection, DRAIN_TIMEOUT_MS)
	timer.unref()
	/** @param {Buffer} chunk */
	const onData = (chunk) => {
		bytes += chunk.length
		if (bytes > MAX_DRAIN_BYTES) closeConnection()
	}
	req.on('data', onData)
	req.on('end', cleanup)
	req.on('close', cleanup)
	req.resume()
}
