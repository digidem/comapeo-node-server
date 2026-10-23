import { Readable } from 'node:stream'

import { InvalidResponse, ResponseLengthMismatch } from './errors.js'

/**
 * Write a Web `Response`'s status and headers to a Node `ServerResponse`.
 *
 * Returns the Node `Readable` for the body, which the caller must pipe into
 * `res`, or `null` when there is no body and the response has been ended.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Response} response
 * @param {string} method
 * @returns {Readable | null}
 */
export function writeResponseHead(res, response, method) {
	if (response.type === 'error') {
		throw new InvalidResponse({ what: 'Response.error()' })
	}
	const { status } = response
	const bodyless = method === 'HEAD' || status === 204 || status === 304
	const transferEncoding = response.headers.get('transfer-encoding')
	const contentLength = transferEncoding
		? null
		: response.headers.get('content-length')

	// Flat name/value list: `Headers` iteration yields each Set-Cookie
	// separately, and the list form keeps them separate on the wire.
	/** @type {string[]} */
	const headers = []
	for (const [name, value] of response.headers) {
		if (name === 'content-length' && (transferEncoding || status === 204)) {
			continue
		}
		if (name === 'transfer-encoding' && !/(^|,)\s*chunked\s*$/i.test(value)) {
			// Node only frames the body itself when `chunked` is the final coding;
			// without it the client can only find the end by the connection closing.
			headers.push(name, `${value}, chunked`)
			continue
		}
		headers.push(name, value)
	}

	/** @type {ReadableStream<Uint8Array> | null} */
	let body = bodyless ? null : response.body
	if (response.body == null && !transferEncoding && !bodyless) {
		if (contentLength == null) headers.push('content-length', '0')
		else if (contentLength !== '0') {
			throw new ResponseLengthMismatch({ declared: contentLength })
		}
	}
	if (body && contentLength != null) {
		body = body.pipeThrough(checkLength(contentLength))
	}

	// Convert the body before committing headers: a locked body throws here, and
	// that should be a 500 rather than a truncated 200.
	const node =
		body == null
			? null
			: Readable.fromWeb(
					/** @type {import('node:stream/web').ReadableStream} */ (body),
				)

	try {
		res.writeHead(status, response.statusText || undefined, headers)
	} catch (err) {
		// Headers already written through the raw `res` from `getContext`: release
		// the body locked above so its producer is cancelled, not left hanging.
		node?.destroy()
		throw err
	}

	if (node) return node
	// A bodyless response may still carry a body the producer expects to release
	// (e.g. a file handle); cancel it rather than abandon it unread.
	response.body?.cancel().catch(() => {})
	res.end()
	return null
}

/**
 * Error the body if it does not match its declared `Content-Length`, so the
 * connection is reset instead of desynchronising the next response.
 *
 * @param {string} declared
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function checkLength(declared) {
	if (!/^\d+$/.test(declared)) {
		throw new InvalidResponse({
			what: `an invalid Content-Length: ${declared}`,
		})
	}
	const expected = Number(declared)
	let received = 0
	return new TransformStream({
		transform(chunk, controller) {
			received += chunk.byteLength
			if (received > expected) throw new ResponseLengthMismatch({ declared })
			controller.enqueue(chunk)
		},
		flush() {
			if (received < expected) throw new ResponseLengthMismatch({ declared })
		},
	})
}
