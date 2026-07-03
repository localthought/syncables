# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`syncables` reads an OpenAPI document and produces two things from it:

- a **mock API server** (`createMockServer`) that implements the document,
  backed by an in-memory CRUD store per resource, seeded with fake data
  generated from the document's schemas;
- an **API client** (`createApiClient`) that talks to any server implementing
  that document and keeps a local copy of each resource collection in sync.

Both understand the [OpenAPI Pagination Schemes Extension](https://github.com/pondersource/openapi-pagination-schemes-extension)
when a document declares `components.paginationSchemes` (see below) —
the mock server paginates list responses accordingly, and the client walks
every page automatically.

The public API surface is defined entirely by `src/index.ts` re-exports —
check there first to see what's intended to be used from outside the package.

## Commands

Both npm and pnpm lockfiles are present; CI (`.github/workflows/nodejs.yml`) uses npm,
the README uses pnpm. Either works — stay consistent with whichever you touch.

```sh
npm run build          # tsc build to build/ (runs lint first via `prebuild`)
npm run build:watch    # tsc in watch mode
npm run build:release  # clean + tsc using tsconfig.release.json (no sourcemaps/comments)
npm test               # vitest run, config __tests__/vitest.config.ts
npm run test:watch     # vitest in watch mode
npm run test:coverage  # vitest with v8 coverage
npm run lint           # eslint .
npm run prettier       # format src/ and __tests__/ in place
npm run prettier:check # check formatting without writing
npm run clean          # rimraf coverage build tmp
```

Run a single test file or case with vitest directly, e.g.:

```sh
npx vitest run __tests__/unit/client/client.test.ts --config __tests__/vitest.config.ts
npx vitest run -t "keeps a local copy in sync" --config __tests__/vitest.config.ts
```

This package has no `main.ts`/CLI entrypoint — it's a library (`build/src/index.js`,
see `package.json` `exports`), so there's no `npm start`.

## Architecture

Data flows through four stages, each its own directory under `src/`:

1. **`openapi/`** — `load.ts` reads a document from a file path or an in-memory
   object (`js-yaml` parses both YAML and JSON) and passes it through
   `resolve-refs.ts`, which inlines all local `#/...` JSON-pointer `$ref`s
   in place (with cycle/diamond-ref handling — see the comment in that file).
   Everything downstream assumes refs are already resolved; `types.ts` holds
   the minimal OpenAPI type surface actually used (not a full spec typing).

2. **`resources/discover.ts`** — turns `document.paths` into a list of
   `ResourceRoute`s by pairing each collection path (`/pets`) with its direct
   item-path child (`/pets/{petId}`). This pairing is the core concept the
   rest of the codebase builds on: a "resource" only exists where that
   pairing holds. Paths without a matching item path (health checks, one-off
   actions) are not resources and are handled separately as raw
   request/response passthroughs.

3. **`mock-server/`** — `server.ts` is the request handler; it uses
   `routing/router.ts` (`findRoute`) to match an incoming path against the
   OpenAPI path templates. For a GET operation, it first checks whether a
   pagination scheme applies (see below) and, if so, serves it as a
   paginated list; otherwise it treats the match as a resource
   (`ResourceStore` in `store.ts`, one in-memory `Map` per collection path,
   CRUD semantics based on collection vs. item path and HTTP method) or
   falls back to serving the operation's documented example/generated schema
   response verbatim. Resource collections are lazily seeded with
   `SEED_COUNT` fake records (via `fake-data/generate.ts`) on first `GET`.

4. **`client/`** — `client.ts`'s `createApiClient` also runs `discoverResources`
   against the same document to know what resources/routes exist, then talks
   to a live server over `fetch`. Reads are served from local storage
   (`StorageAdapter`, `storage.ts`; `InMemoryStorageAdapter` is the default —
   pass a custom adapter to persist elsewhere), writes go to the server first
   and update local storage only after the server confirms. `sync()` and the
   standalone `paginate()` method both walk every page of a paginated GET
   operation before returning (see below).

`fake-data/generate.ts` (`generateFromSchema`) is shared by both the mock
server (seeding + example responses) and is the only place schema-to-value
synthesis logic lives — it prefers a schema's own `example`, then `enum`,
then handles `allOf`/`oneOf`/`anyOf`/type-based generation recursively. A
schema's own fixed `example` is reused verbatim on every call, so callers
generating more than one item from the same schema (resource seeding,
paginated list generation) must inject their own unique `id` afterward
rather than relying on the generated value to differ per item.

### Pagination (`src/pagination/`)

Implements the [OpenAPI Pagination Schemes Extension](https://github.com/pondersource/openapi-pagination-schemes-extension)
(`components.paginationSchemes`), applied to third-party documents via
[OpenAPI Overlays](https://spec.openapis.org/overlay/v1.0.0.html)
(`src/openapi/overlay.ts`, `applyOverlay`/`loadOverlay` — an intentionally
minimal Overlay implementation: `update`/`remove` actions with plain
dot-path targets like `$.components`, not the full JSONPath grammar).

- `types.ts` mirrors the extension's spec objects verbatim.
- `validate.ts` checks a scheme against the spec's own rules (§9); an
  invalid scheme (e.g. a `type` outside `pageNumber`/`pageToken`/`nextLink`)
  is excluded from auto-detection rather than throwing — one broken scheme
  in a document shouldn't disable the rest.
- `autodetect.ts`'s `resolveEffectiveScheme(document, operation)` picks the
  scheme that applies to an operation: an explicit `x-pagination` entry
  first, else auto-detection by matching the scheme's declared query
  parameter/body field names against the operation's own (§6.2 default
  rules — a dimension with zero declared fields never vacuously matches).
- `items.ts` locates which top-level response property actually holds the
  list of items — the extension itself only describes pagination metadata,
  not where items live, so this excludes whatever fields the scheme claims
  as metadata, then picks the remaining array-typed property (falling back
  to common envelope names: `items`/`data`/`results`/`records`/`content`).
  This is also what makes real enveloped responses (e.g. `{ data: [...],
  meta, pagination }`) work at all, pagination or not.
- `request-builder.ts` builds query parameters for a page from a `PageCursor`
  (offset/page/pageToken) and computes the next cursor from response state.
- `response-parser.ts` parses that state back out of a response
  (`bodyFields` keys may be dotted paths into nested objects, e.g.
  `pagination.total_count`; `headers` supports RFC 8288 `Link` parsing for
  `nextLink`-role headers) and derives `hasNextPage`.

**Pagination is orthogonal to the collection/item resource model.** In
real APIs, the paths that pair into a "resource" (batch-get-by-IDs style,
e.g. Giphy's `/gifs`, Spotify's `/albums`) are often *not* the paginated
ones — real pagination usually lives on separate search/list endpoints
(`/gifs/trending`, `/artists/{id}/albums`) that have no sibling item path
and are therefore invisible to `discoverResources`. So pagination support
in both the mock server and `client.paginate()` operates on *any* GET
operation matched by a scheme, not just discovered resources; `sync()`
additionally upgrades a resource's collection GET to use it when it
qualifies, but falls back to today's single-request behavior otherwise.

Tests under `__tests__/unit/` mirror this `src/` layout one-to-one (e.g.
`unit/client/client.test.ts`, `unit/mock-server/server.test.ts`,
`unit/pagination/*.test.ts`), plus:
- `__tests__/fixtures/pets.ts`, a shared hand-written OpenAPI fixture used
  across multiple test files for CRUD-resource-shaped scenarios.
- `__tests__/fixtures/real-world/`, real OpenAPI documents and pagination
  overlays vendored unmodified from apis.guru and localthought/overlays
  (see the header comment in each file for provenance). `acceptance/*.test.ts`
  runs the full pipeline against these and deliberately documents real
  quirks rather than working around them — e.g. an enveloped (non-array)
  collection response, a 405 on a collection that only supports `POST`, or
  a vendored pagination overlay whose scheme fails the extension's own
  validation. When extending these, keep that spirit: assert what actually
  happens against the unmodified real document, not an idealized result.

## Conventions

- ESM throughout (`"type": "module"`); intra-package imports use explicit
  `.js` extensions (e.g. `from '../resources/discover.js'`) because
  `moduleResolution` is `node16`.
- `tsconfig.json` (base, used for dev/test) has `strict`, `noUnusedLocals`,
  `noUnusedParameters`, `noImplicitReturns` all on, and includes `src`,
  `__tests__`, `examples`. `tsconfig.release.json` extends it for
  `build:release`, restricted to `src`, excluding test files, without
  sourcemaps/comments.
- ESLint (`eslint.config.mjs`) uses `typescript-eslint` recommended rules plus
  `@typescript-eslint/explicit-function-return-type` as a warning, and a
  vitest plugin scoped to `__tests__/**`. Prettier config (`.prettierrc`) is
  applied via `eslint-config-prettier`, so ESLint won't fight Prettier.
- Node engine is pinned to `>= 22.11 < 23` (see `package.json`
  `engines`/`volta`).
