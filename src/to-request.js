import {
  InvalidHost,
  InvalidRequestTarget,
  MethodNotSupported,
} from './errors.js'
import { requestBody } from './request-body.js'

// Letters, digits, `.-_:` and IPv6 brackets only: anything else could smuggle
// a path, userinfo or another authority into the URL. `new URL` then checks
// the structure (bracket matching, port range).
const HOST_RE = /^[A-Za-z0-9.\-:_[\]]+$/

/**
 * Convert a Node `IncomingMessage` into a Web `Request`. The body is `null`
 * when the request carries none, as with a client-side `fetch`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {AbortSignal} signal
 * @param {boolean} https
 * @returns {Request}
 */
export function toRequest(req, res, signal, https) {
  const proto = https ? 'https:' : 'http:'
  const host = req.headers.host
  // RFC 9110 §7.2: a request with more than one Host must be rejected.
  if ((req.headersDistinct?.host?.length ?? 0) > 1) {
    throw new InvalidHost({ host: '(repeated)' })
  }
  if (
    host === undefined ||
    !HOST_RE.test(host) ||
    !URL.canParse(`${proto}//${host}`)
  ) {
    throw new InvalidHost({
      host: host === undefined ? '(missing)' : truncate(host),
    })
  }

  const target = req.url ?? '/'
  // Origin-form (`/path?query`) composes with Host; absolute-form
  // (`http://host/path`) carries an authority that RFC 9112 §3.2.2 says
  // replaces it. Anything else (`OPTIONS *`, `evil.com`) is rejected.
  const href = target.startsWith('/') ? `${proto}//${host}${target}` : target
  const url = URL.canParse(href) ? new URL(href) : null
  if (
    !url ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    // `new Request` refuses URLs with credentials.
    url.username ||
    url.password
  ) {
    throw new InvalidRequestTarget({ target: truncate(target) })
  }
  // The scheme is a property of the connection, never of what the client sent.
  url.protocol = proto
  url.hash = ''

  const method = req.method ?? 'GET'
  // The one forbidden fetch method Node's parser accepts; `new Request` would
  // throw a TypeError.
  if (method === 'TRACE') throw new MethodNotSupported({ method })

  /** @type {RequestInit} */
  const init = {
    method,
    // Only `set-cookie` is array-valued, and it is meaningless on a request.
    headers: /** @type {Record<string, string>} */ (req.headers),
    signal,
  }
  if (
    method !== 'GET' &&
    method !== 'HEAD' &&
    ('content-length' in req.headers || 'transfer-encoding' in req.headers)
  ) {
    init.body = requestBody(req, res)
    init.duplex = 'half'
  }

  return new Request(url, init)
}

/**
 * @param {string} value
 * @returns {string}
 */
function truncate(value) {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value
}
