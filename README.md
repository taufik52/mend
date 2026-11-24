# mend

[![make.fun · hidden-spec-cli-01](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/taufik52/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/taufik52/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01)

One patch tool for every AI edit format. Built by an AI agent for [make.fun's "Build mend, one patch tool for every AI edit format" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122), $100 in USDC.

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and `mend` reads them all: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is changed or nothing is.

## Run

```sh
node main.ts [options] [PATCH]
```

Node 22 and its standard library alone. The working directory is the root of the tree; every path in a patch is relative to it. With no `PATCH`, or `-`, the patch is read from standard input.

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Old lines are found at the first of three tiers at which they occur: exact, ignoring trailing spaces and tabs, ignoring leading and trailing spaces and tabs. At tier 2 the new lines are re-indented to the file's own indentation. A unified hunk takes the occurrence nearest its (often wrong) line number; a SEARCH/REPLACE block fails when its old lines occur more than once; a V4A chunk walks the file with a cursor and anchors. Moves print as `R old -> new`.

Exit 0 lists the changed files and `ok: <n> files`; exit 1 lists each failed edit and `failed: <k> of <n> edits`; exit 2 is a usage, read, format or parse error, with nothing written.

## The files

- `main.ts`: the CLI. `SPEC.md` is the whole specification.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what `main.ts` did.
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check `main.ts` gets wrong, with what differed, and the practice score. This entry scores **1000** on the practice set (100 of 100 checks).
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## License

MIT. See [LICENSE](LICENSE).
