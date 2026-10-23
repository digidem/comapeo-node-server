# @comapeo/node-server

A small adapter that runs a fetch-style handler
(`(Request, ctx) => Response | Promise<Response>`) on a `node:http` server,
using Node's built-in `Request`, `Response` and `Headers`.

The handler can be a plain function, Hono's `app.fetch`, itty-router's
`router.fetch`, or anything else that takes a Web `Request` and returns a Web
`Response`.

- Requires Node 22 or later.
- Request bodies are streamed, never buffered.
- `request.signal` aborts when the client disconnects, and the disconnect
  cancels the response body.
- Streaming responses send their headers straight away, so server-sent events
  and long-poll handlers work.
- Reliability and correct cancellation come before performance.

## Why not `@whatwg-node/server` or `@hono/node-server`?

Both are good general-purpose adapters. This package is for applications that
depend on streaming and cancellation behaving precisely, such as long uploads
and downloads that either side may cancel. The differences below were checked
on Node 24.21 with `@whatwg-node/server` 0.11.0 and `@hono/node-server` 1.19.14
and 2.0.4, in October 2026; later releases may differ.

`@whatwg-node/server` aborts `request.signal` with an `AbortError` when the
client disconnects, the same error a handler sees when it cancels work itself,
so the two cannot be told apart. If a handler stops a transfer by erroring its
own streaming response with an `AbortError`, the connection is left open, so
the client never learns the transfer has stopped; when the client then
disconnects, an unhandled rejection crashes the process. Streaming responses
send no headers until the first chunk, so a server-sent events stream with
nothing to send yet leaves the client waiting. It also bundles its own fetch
implementation (about 1.8MB across 9 packages), which is loaded even when
`fetchAPI` is set to Node's classes; when it is used, cancelling a request body
closed the keep-alive connection. An absolute URL as the request target
produces a malformed `request.url`.

`@hono/node-server` replaces `globalThis.Request` and `globalThis.Response`
with its own classes unless you pass `overrideGlobalObjects: false`. On client
disconnect it aborts `request.signal` with a string, and cancels the response
body with no reason at all, so code reading that body through `pipeTo` gets
`undefined` instead of an error it can inspect. Errors while sending a
response are written to `console.error` and to the client as
`Error: <message>`, with no hook to report them elsewhere. Version 2 also needs
`hono` itself installed (about 2.9MB), even when you use a different router.
An absolute URL as the request target sets the scheme of `request.url`, so a
client can make a plain connection look like `https`.

Neither checks a handler's `Content-Length` against the body, so returning a
`fetch()` response unchanged can corrupt the next response on a reused
connection.

This package uses Node's own classes and patches no globals. A disconnect
aborts `request.signal` and cancels the response body with Node's connection
error (`code: 'ECONNRESET'`); a handler that errors its own response body gets
the connection reset; streaming headers are sent straight away; and errors go
to an `onError` callback. It is about 70kB installed, including its one
dependency, `custom-error-creator`, which has none of its own. In exchange it is
slower on small responses (see [`bench/`](bench/README.md)) and does much less:
no HTTP/2, WebSockets, static file serving or other runtimes (see
[Scope](#scope)).

## Install

```sh
npm install @comapeo/node-server
```

## Usage

```js
import http from 'node:http'
import { createAdapter } from '@comapeo/node-server'

const handler = async (request) => {
  if (request.method === 'POST') {
    const body = await request.text()
    return new Response(`you said: ${body}`, { status: 201 })
  }
  return new Response('hello')
}

http.createServer(createAdapter(handler)).listen(3000)
```

With a router, pass its `fetch` method:

```js
import { Hono } from 'hono'

const app = new Hono()
app.get('/hello', (c) => c.text('hi'))

http.createServer(createAdapter((request) => app.fetch(request))).listen(3000)
```

### Per-request context

`getContext(req, res)` runs synchronously before the `Request` is built, and
its return value is passed to the handler as the second argument. Use it for
values that come from the raw Node request or socket, including properties set
by a wrapping transport.

```js
const adapter = createAdapter(
  (request, ctx) => new Response(`you are ${ctx.remoteAddress}`),
  { getContext: (req) => ({ remoteAddress: req.socket.remoteAddress }) },
)
```

## API

```ts
function createAdapter<Ctx = undefined>(
  handler: (request: Request, context: Ctx) => Response | Promise<Response>,
  options?: AdapterOptions<Ctx>,
): (req: IncomingMessage, res: ServerResponse) => void
```

| Option       | Type                            | Default                       | Description                                                         |
| ------------ | ------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `getContext` | `(req, res) => Ctx`             | —                             | Builds the per-request context. Throwing responds 500.              |
| `https`      | `boolean \| ((req) => boolean)` | detect `req.socket.encrypted` | Sets the URL scheme. Set it behind a trusted TLS-terminating proxy. |
| `onError`    | `(err, req) => void`            | no-op                         | Called with errors the adapter caught. See below.                   |

### Errors

`onError` receives errors from your handler and its response body unchanged.
Errors the adapter raises itself are instances of the classes below, each with
a stable `code` and the `status` the client received (unless headers had
already been sent). Where one wraps another error, that error is its `cause`.
Error messages are never sent to the client.

| Class                    | `code`                     | `status` | When                                                                                                          |
| ------------------------ | -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `InvalidHost`            | `INVALID_HOST`             | 400      | `Host` is missing, repeated or malformed                                                                      |
| `InvalidRequestTarget`   | `INVALID_REQUEST_TARGET`   | 400      | The target is not a path or an absolute `http(s)` URL                                                         |
| `MethodNotSupported`     | `METHOD_NOT_SUPPORTED`     | 501      | `TRACE`                                                                                                       |
| `ContextFailed`          | `CONTEXT_FAILED`           | 500      | `getContext` threw (`cause`)                                                                                  |
| `InvalidResponse`        | `INVALID_RESPONSE`         | 500      | The handler returned something other than a `Response`, `Response.error()`, or a non-numeric `Content-Length` |
| `ResponseSendFailed`     | `RESPONSE_SEND_FAILED`     | 500      | The response could not be sent, for example because its body was already read (`cause`)                       |
| `ResponseLengthMismatch` | `RESPONSE_LENGTH_MISMATCH` | 500      | The body does not match its `Content-Length`; once headers are sent, the connection is reset                  |

`isAdapterError(err)` is true for any of them, including errors from another
installed copy of this package, and narrows `err` so that `code` and `status`
are typed. Match on `err.code` rather than `instanceof` the classes, which only
holds within one copy.

```js
import { createAdapter, isAdapterError } from '@comapeo/node-server'

const adapter = createAdapter(handler, {
  onError(err, req) {
    if (!isAdapterError(err)) {
      // Thrown by your handler or its response body.
      console.error(`${req.method} ${req.url} failed`, err)
    } else if (err.status < 500) {
      // A malformed request from the client.
      console.debug(`rejected ${err.code}`)
    } else if (err.code === 'RESPONSE_LENGTH_MISMATCH') {
      console.error('a handler set the wrong Content-Length', err)
    } else {
      console.error(err.code, err.cause ?? err)
    }
  },
})
```

## Behaviour

- **Errors.** If `getContext` or request construction fails, the handler
  throws, or the response body errors, the adapter chooses the outcome (a 4xx
  or 5xx, or a socket reset once headers are sent) and then calls `onError`.
  It is for logging, not recovery, and runs after the client has its status;
  if it throws, the error is rethrown as an uncaught exception. A handler
  error named `TimeoutError` (such as from `AbortSignal.timeout` on an upstream
  call) is a 504. Errors caused by the client disconnecting are not reported,
  including when the handler wraps one as the `cause` of its own error. If
  your handler deliberately errors a streaming body (for example by aborting a
  `pipeTo`), the resulting `AbortError` is reported and the socket reset;
  filter it in `onError` if that is expected.
- **Disconnects** abort `request.signal`, and reject any body read in
  progress, with Node's connection error (`code: 'ECONNRESET'`), never an
  `AbortError`.
- **Request bodies.** `request.body` is `null` when the request has no
  `Content-Length` or `Transfer-Encoding`. Cancelling the body stops reading
  without closing the connection. Once the response has been sent, a read
  still in progress rejects with an `AbortError`, so read the body before
  returning. Any unread body, including one on a request rejected before the
  handler ran, is then read and thrown away so the connection can be reused;
  if that would take more than 64MB or 500ms, the adapter stops and closes
  the connection instead.
- **Headers** come from Node's `req.headers`: duplicates are joined with `, `
  (`; ` for `Cookie`), and singleton headers such as `Authorization` keep the
  first value. Hop-by-hop headers such as `Transfer-Encoding` are passed
  through; Node's `fetch` rejects some of them, so remove them before
  forwarding `request.headers`.
- **Response framing.** A `Content-Length` set by the handler is checked
  against the body: if they differ, the connection is reset and `onError` is
  called, and a non-zero length with no body is a 500. A `Transfer-Encoding`
  that does not end in `chunked` gets `, chunked` added, and replaces any
  `Content-Length`. A 204 never carries a `Content-Length`. When returning a
  `fetch()` response, note that `fetch` decompresses the body but keeps the
  original `Content-Length` and `Content-Encoding`; remove both.
- **URLs** take their scheme from the socket (or the `https` option) and
  their host from the `Host` header, or from the request target when it is an
  absolute URL, as RFC 9112 requires. `x-forwarded-*` headers are ignored and
  fragments are dropped. A missing, repeated or malformed `Host` (including on
  HTTP/1.0), or a request target other than a path or an absolute `http(s)`
  URL (including `OPTIONS *`), is a 400. `TRACE` is a 501, since a fetch
  `Request` cannot represent it.

## Scope

Not supported:

- HTTP/2. Requests through Node's HTTP/2 compatibility API have no `Host`
  header and get a 400.
- WebSockets. Handle upgrades with the server's `'upgrade'` event; without a
  listener, upgrade requests reach the handler as ordinary requests.
- Response trailers and 1xx responses such as 103 Early Hints, which a fetch
  `Response` cannot represent.
- Runtimes other than Node.

## Development

Plain JavaScript with JSDoc types and no build step. Type declarations are
generated by `tsc` when packing for publish.

```sh
npm install
npm test       # type-check, lint, then node --test with coverage
npm run format # prettier --write .
npm run bench  # compare with @whatwg-node/server and @hono/node-server
```

CI runs the tests on Node 22 and 24.

## License

MIT
