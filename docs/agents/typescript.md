# TypeScript conventions

Applies to `src/`, `tests/` and the build config. The compiler settings in [tsconfig.json](../../tsconfig.json) are strict; write against them rather than to a separate style guide.

## Compiler-driven rules

`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `module` and `moduleResolution` `NodeNext`, target ES2024. Practically:

- **Relative imports carry the real extension:** `./app/runtime.ts`, `../src/policy.ts` — never `.js`. `allowImportingTsExtensions` and `rewriteRelativeImportExtensions` keep that working through the build.
- **Types come in with `import type`.** A value import of a type is an error under `verbatimModuleSyntax`.
- **Every index access may be `undefined`** under `noUncheckedIndexedAccess`. Handle it; do not `!` past it in new code. The existing `!` uses are in tests, where a fixture is known.
- **Import the core through its barrel** `src/core/index.ts`. Other directories are imported by file path.

## Style the tooling does not enforce

No linter or formatter runs. The shape across `src/` is consistent, so follow the file you edit:

- no semicolons at the end of a statement (a `for` header is not a statement end);
- one statement per line, small functions, early returns;
- comments explain **why**, briefly and densely — `src/index.ts` shows the volume expected. A comment that restates the code is noise;
- no `any`; narrow with a schema, `unknown`, or an explicit type at the boundary.

## Boundaries

- **Server code is ESM on Node** (`src/**` except `src/client`); **the panel is CJS in the browser** (`src/client/**`, the second tsdown entry). Do not import Node built-ins into `src/client`.
- **DSH packages are peer dependencies and are never bundled** (`deps.neverBundle` in [tsdown.config.ts](../../tsdown.config.ts)). A new runtime dependency goes on that list, or the build inlines it.
- **Settings are schemas first:** `zod` for the settings blocks ([src/policy.ts](../../src/policy.ts)), `@deepseek-ai/schemastery` for the plugin `Config` ([src/deployment.ts](../../src/deployment.ts)). Validate at the edge and pass typed values inward.
- **`?raw` imports** work in vitest and tsdown through the `raw` plugin in tsdown.config.ts. Keep that plugin if you touch the config.
