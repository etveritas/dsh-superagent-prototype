# Documentation

Docs are a product surface here: [tests/docs.spec.ts](../../tests/docs.spec.ts) runs on every change and fails on a broken link, a gap in the numbering, a merge-conflict marker, or a table that no longer matches the tree.

## The numbered series

- `docs/NNN-slug.md`, numbered consecutively from `000`, read in order. Each document may build only on the ones before it.
- **A numbered document may link only to an earlier numbered document** in `docs/`. That is what the numbering test enforces: a link to a later document, or to any other `.md`, fails it.
- Every local link from `README.md`, `README.zh-CN.md`, `SETUP.md` and the numbered documents must resolve.
- Appending a document at the end is cheap; inserting one in the middle means renumbering and fixing every link to it.

## Tables that must match the tree

[007 Architecture](../007-architecture.md) carries a `## Modules` table and a `## Tests` table. Every file under `src/` and every `tests/**/*.spec.ts(x)` must appear, and only files that exist may appear. Update the table in the same change that adds, renames or deletes a file.

## `docs/agents/`

Agent-facing instructions live here and are **not** part of the numbered series: they are read on demand from the root [AGENTS.md](../../AGENTS.md), not in order. Two consequences: do not link to `docs/agents/` from a numbered document, because the numbering test fails; and keep each page short, because a rule needed for *every* task belongs in the root file instead.

## Other documents

- `README.md` and `README.zh-CN.md` are a pair; a user-facing change to one belongs in the other.
- `SETUP.md` is a procedure an agent follows, not prose: change it together with the setup code and panel fields it drives.
- `prompts/*.md` are product, not documentation. A prompt edit changes agent behaviour, so it needs a test the way a code change does.
