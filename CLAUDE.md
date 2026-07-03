# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`syncables` reads an OpenAPI document and produces two things from it:

- a **mock API server** (`createMockServer`) that implements the document,
  backed by an in-memory CRUD store per resource, seeded with fake data
  generated from the document's schemas;
- an **API client** (`createApiClient`) that talks to any server implementing
  that document and keeps a local copy of each resource collection in sync.

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
   `router.ts` (`findRoute`) to match an incoming path against the OpenAPI
   path templates, then either treats the match as a resource
   (`ResourceStore` in `store.ts`, one in-memory `Map` per collection path,
   CRUD semantics based on collection vs. item path and HTTP method) or
   falls back to serving the operation's documented example/generated schema
   response verbatim. Collections are lazily seeded with `SEED_COUNT` fake
   records (via `fake-data/generate.ts`) on first `GET`.

4. **`client/`** — `client.ts`'s `createApiClient` also runs `discoverResources`
   against the same document to know what resources/routes exist, then talks
   to a live server over `fetch`. Reads are served from local storage
   (`StorageAdapter`, `storage.ts`; `InMemoryStorageAdapter` is the default —
   pass a custom adapter to persist elsewhere), writes go to the server first
   and update local storage only after the server confirms.

`fake-data/generate.ts` (`generateFromSchema`) is shared by both the mock
server (seeding + example responses) and is the only place schema-to-value
synthesis logic lives — it prefers a schema's own `example`, then `enum`,
then handles `allOf`/`oneOf`/`anyOf`/type-based generation recursively.

Tests under `__tests__/unit/` mirror this `src/` layout one-to-one (e.g.
`unit/client/client.test.ts`, `unit/mock-server/server.test.ts`), plus
`__tests__/fixtures/pets.ts`, a shared OpenAPI fixture document used across
multiple test files — reuse it for new tests involving a resource-shaped API
rather than inlining another fixture.

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
