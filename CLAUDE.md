# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This repository is a fresh Node.js/TypeScript project bootstrapped from the
`node-typescript-boilerplate` template (see `package.json` name/description).
The only source file is `src/main.ts`, which currently contains template
placeholder code (a `greeter`/`delayedHello` demo), and `__tests__/unit/main.test.ts`
tests it. There is no application-specific architecture yet — when adding real
functionality, expect to replace this placeholder rather than build around it.

## Commands

Both npm and pnpm lockfiles are present; CI (`.github/workflows/nodejs.yml`) uses npm,
the README uses pnpm. Either works — stay consistent with whichever you touch.

```sh
npm run build          # tsc build to build/ (runs lint first via `prebuild`)
npm run build:watch    # tsc in watch mode
npm run build:release  # clean + tsc using tsconfig.release.json (no sourcemaps/comments)
npm start              # run build/src/main.js (must build first)
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
npx vitest run __tests__/unit/main.test.ts --config __tests__/vitest.config.ts
npx vitest run -t "greets a user" --config __tests__/vitest.config.ts
```

## Structure and conventions

- `src/` — TypeScript sources, ES modules (`"type": "module"` in package.json).
  Import compiled-relative paths with explicit `.js` extensions (e.g.
  `from '../../src/main.js'`), since `moduleResolution` is `node16`.
- `__tests__/unit/` — vitest tests, mirroring `src/` structure; the vitest
  config lives at `__tests__/vitest.config.ts`, not the repo root.
- `build/` — compiled output (gitignored); never edit files here.
- `tsconfig.json` — base config used for dev/test (`strict`, `noUnusedLocals`,
  `noUnusedParameters`, `noImplicitReturns` all on); includes `src`, `__tests__`,
  `examples`.
- `tsconfig.release.json` — extends the base config for `build:release`, restricted
  to `src`, excludes test files, strips sourcemaps/comments.
- ESLint (`eslint.config.mjs`) uses `typescript-eslint` recommended rules plus
  `@typescript-eslint/explicit-function-return-type` as a warning, and a vitest
  plugin scoped to `__tests__/**`. Prettier config (`.prettierrc`) is applied via
  `eslint-config-prettier`, so ESLint won't fight Prettier's formatting choices.
- Node engine is pinned to `>= 22.11 < 23` (see `package.json` `engines`/`volta`).
