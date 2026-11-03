# tally — a small line/word/char counter

Build a Node.js (>=22) CLI called `tally` in this repository. No external runtime dependencies.

## Behaviour
- `tally [files...]` counts lines, words and characters for each file and prints a per-file row plus a `total` row when more than one file is given.
- With no file arguments it reads stdin.
- Flags `-l`, `-w`, `-c` restrict output to lines / words / chars (combinable; default is all three).
- `--json` prints a JSON array of `{ file, lines, words, chars }` objects instead of the table.
- A missing file prints `tally: <name>: No such file` to stderr, exits 1 after processing the others.
- Word = maximal run of non-whitespace. Lines = number of `\n` characters. Chars = UTF-8 code points, not bytes.

## Deliverables
- `bin/tally.js` (executable), `src/count.js` (pure counting logic, exported), `package.json` with `"bin"` and `"test": "node --test"`.
- Tests under `test/` using `node:test` covering: counting logic incl. unicode, each flag, `--json`, stdin, and the missing-file exit code.
- `README.md` with usage.

## Done means
`node --test` passes, `echo "a b\nc" | node bin/tally.js` prints the right numbers, and the work is committed.
