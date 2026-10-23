# @comapeo/node-server

Minimal Node.js adapter that runs fetch-style (Request, ctx) => Response handlers on a node:http server.

## Commands

```sh
npm test            # types, lint, unused (knip), unit tests
npm run coverage    # unit tests with lcov + text coverage
npm run check:pkg   # publint + attw on the packed tarball
npm run format      # prettier
npm run bench       # compare with @whatwg-node/server and @hono/node-server (npm --prefix bench ci first)
```

## Conventions

JavaScript with JSDoc types, checked by `tsc` (`checkJs`). `src/` ships as-is; only `.d.ts` files are emitted to `dist/`.
ESM only. No default exports (enforced by ESLint).
Errors via `custom-error-creator`, exported from `src/errors`. Prettier with
tabs, no semicolons, single quotes. Conventional Commits, `!` for breaking changes.
Releases are cut with the Release workflow (optic-release-automation); its
notes come from PR titles, so make them clear Conventional Commits.
