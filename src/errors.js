import { createErrorClassesByName } from 'custom-error-creator'

const classes = createErrorClassesByName([
  {
    code: 'INVALID_HOST',
    message: 'Invalid Host header: {host}',
    status: 400,
  },
  {
    code: 'INVALID_REQUEST_TARGET',
    message: 'Invalid request target: {target}',
    status: 400,
  },
  {
    code: 'METHOD_NOT_SUPPORTED',
    message: 'Unsupported method: {method}',
    status: 501,
  },
  { code: 'CONTEXT_FAILED', message: 'getContext threw', status: 500 },
  {
    code: 'INVALID_RESPONSE',
    message: 'Handler returned {what}',
    status: 500,
  },
  {
    code: 'RESPONSE_SEND_FAILED',
    message: 'Could not send the response',
    status: 500,
  },
  {
    code: 'RESPONSE_LENGTH_MISMATCH',
    message: 'Response body does not match Content-Length {declared}',
    status: 500,
  },
])

export const {
  InvalidHost,
  InvalidRequestTarget,
  MethodNotSupported,
  ContextFailed,
  InvalidResponse,
  ResponseSendFailed,
  ResponseLengthMismatch,
} = classes

// A registered symbol, so errors from another installed copy of this package
// are recognised too, which `instanceof` would miss. Never rename it.
const kAdapterError = Symbol.for('@comapeo/node-server.AdapterError')
for (const ErrorClass of Object.values(classes)) {
  // Each class's own prototype: their parent is `Error.prototype` itself.
  Object.defineProperty(ErrorClass.prototype, kAdapterError, { value: true })
}

/**
 * Whether `err` was raised by the adapter itself rather than by the handler
 * or its response body. Deliberately not `isCustomError` or a `code` match: a
 * handler's own error with a `status` must not choose the response status.
 *
 * @param {unknown} err
 * @returns {err is InstanceType<(typeof classes)[keyof typeof classes]>}
 */
export function isAdapterError(err) {
  return typeof err === 'object' && err !== null && kAdapterError in err
}

/**
 * The same shape as the error Node raises when a socket drops mid-message, so
 * a client disconnect looks the same to the handler whether or not Node saw
 * it: a connection error, never an `AbortError` (which would read as the
 * handler's own cancellation).
 *
 * @returns {Error & { code: 'ECONNRESET' }}
 */
export function connectionReset() {
  return Object.assign(new Error('aborted'), {
    code: /** @type {const} */ ('ECONNRESET'),
  })
}
