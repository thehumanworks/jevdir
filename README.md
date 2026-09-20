# jd

`jd <partial-dir>` jumps to the directory you most likely mean. It looks at directories near you, how often
you have jumped to each one before, and how well each name matches what you typed, then asks an evaluation
model (TypeSafe Jev, through the Vercel AI SDK's `experimental_evaluate`) to pick one. It only jumps without
asking when the model is sure.

```
~/work/shop $ jd comp
jd → web/src/components (probability 92% · confidence 88%)
~/work/shop/web/src/components $
```

## Install

Requires [Bun](https://bun.sh) to build; the result is a standalone binary.

```sh
bun install
bun run install:bin     # compiles dist/jd and copies it to ~/.local/bin/jd (must be on your PATH)
```

A program cannot change its parent shell's directory, so `jd` runs as a small shell function that calls the
binary and `cd`s to the path it prints. Add one line to `~/.zshrc` (or `~/.bashrc` with `init bash`):

```sh
eval "$(jd init zsh)"
```

Open a new shell after the first install. Later rebuilds need nothing: the function points at the binary's
path, which does not change. To run from source instead, use `eval "$(bun /path/to/jd/src/index.ts init zsh)"`.

This also installs tab completion.

## API key

Set **one** of these in your shell profile:

| Variable | Route | Extra setup |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway → `gateway.evaluationModel("typesafe-ai/jev")` | none |
| `TYPESAFE_AI_API_KEY` | TypeSafe directly → `typeSafeAi.evaluationModel("jev-latest")` | `bun add @ai-sdk/typesafe-ai`; run from source only (the compiled binary cannot load it) |

```sh
export AI_GATEWAY_API_KEY="..."   # create one in the Vercel dashboard under AI Gateway → API keys
```

If both are set, the native TypeSafe route is used when `@ai-sdk/typesafe-ai` is installed, otherwise the
Gateway. On Vercel, `VERCEL_OIDC_TOKEN` also enables the Gateway route. Both routes go through `experimental_evaluate` from `ai`;
jd never calls the TypeSafe SDK or HTTP API itself. Without a key jd still works: exact matches and confident
cache hits navigate, and everything else shows a locally ranked list to pick from.

## Usage

```sh
jd src/components   # a real path from here: goes straight there, no API call
jd comp             # partial name: the model picks, jd jumps if it is sure
jd api<Tab>         # tab completion: matching directories, ranked locally (no API call)
jd --stats          # how past navigations were decided
jd index            # rebuild the home directory index (also: jd --reindex)
```

When the model is not sure, jd asks instead of guessing:

```
~/work/shop $ jd api
jd: not sure enough to jump (probability 48% · confidence 31%). Did you mean:
  1) services/api-client  48%  visited 3×
  2) services/api-server  41%
  3) docs/api  9%
Go to [1-3, Enter = 1, q = cancel]:
```

In a script or pipe (no terminal) it lists the options, exits with status 1, and does not move.

## How it decides

1. **Exact match.** If the argument resolves to a directory from the current one (`src`, `../docs`, `~/work`,
   an absolute path), jd goes there. No model call.
2. **Prediction cache.** Before scanning directories, jd checks recent history for a confident, unambiguous
   mapping whose target still exists as a directory. A hit skips both the scan and the model. See below.
3. **Candidates.** Otherwise jd collects directories up to 3 levels below the current directory, the parent
   directories (3 levels up) and their children, every directory in jd history, and a persistent home
   directory index. Equally good nearby matches and frequently visited directories rank above unvisited
   indexed matches. In the local scan, `node_modules`, build
   output, and hidden directories are skipped (hidden ones are included when the query starts with `.`).
   A directory is kept if its name matches the query (exact, prefix, substring, path fragment, or letters in
   order) or if this same query led there before. Directories from history are included even when hidden.
   Up to 200 go to the model (its limit is 255 options), ordered by match quality and visit frequency.
4. **One question.** A single `choice` question, `target_directory`, lists every candidate plus
   `none_of_the_above`. Each option's description states the full path, where it sits relative to the
   current directory, how the name matches, and its visit history, so options are distinguishable from each
   other. The typed text, current directory, and recent `cd`/`jd` commands go in `state`.
5. **Gate.** jd reads `answer.choice`, `answer.probabilities[choice]`, and
   `result.providerMetadata.typesafe.confidence.target_directory`:

   | Condition | What happens |
   | --- | --- |
   | probability ≥ 0.7 **and** confidence ≥ 0.6 | jump |
   | anything lower, or either number missing | show the top 5 by probability and ask |
   | `none_of_the_above` | show the closest candidates; Enter cancels, only an explicit number jumps |
   | model error, timeout (10 s), or no key | show the local ranking and ask; never jumps |

The thresholds live in `THRESHOLDS` in `src/choice.ts`. They are starting values, not fitted ones; see
[Measuring accuracy](#measuring-accuracy).

## Prediction cache

After about three recent independent uses of the same query, jd can jump without a directory scan or
model call: `jd → web/src/components (cached · 3 recent uses)`. Queries ignore case, surrounding
whitespace, and trailing slashes. The mapping is independent of your current directory, so an unambiguous
alias works anywhere. Exact paths still take priority. Deleted, renamed, or non-directory targets miss.

The existing history file is the only cache store. Each eligible navigation contributes
`0.5^(age / half-life)` to its target's score, and entries older than the TTL do not count. A target needs
at least the minimum score and 80% of the query's total decayed weight; ambiguous names still go to the
model. An explicit correction (`confirmed` with the model's choice rejected) counts twice, for the path
you picked. This gives deliberate feedback more influence than an automatic jump without letting one
correction establish a mapping on its own. Other confirmed choices, automatic jumps, and local fallback
selections count once. Exact-path and cached jumps never count, so cache hits cannot renew themselves.
The displayed recent-use count is the number of eligible entries for the winning target, not its score.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `JD_CACHE_TTL_DAYS` | `14` | Hard evidence lifetime; limits stale mappings after directory changes |
| `JD_CACHE_HALF_LIFE_DAYS` | `7` | Score halves each week, so long gaps force a fresh prediction |
| `JD_CACHE_MIN_SCORE` | `2.5` | Requires roughly three fresh uses rather than trusting one prediction |
| `JD_NO_CACHE` | unset | Any non-empty value other than `0` skips lookup for that run |

The numeric settings must be finite and positive; invalid values use the defaults. For example,
`JD_NO_CACHE=1 jd comp` asks for a fresh prediction (or local selection without a model), while still
recording the resulting navigation. This also lets you correct a currently cached mapping.
`jd --stats` reports cached navigations separately. Model answers still require probability ≥ 0.7 and
confidence ≥ 0.6 for an automatic jump.

## Home directory discovery

From any directory, `jd mise`, `jd .config`, and completion can find `~/.config/mise` and `~/.config`.
Path fragments such as `config/mise` and `.config/mi` work too. Completion stays model-free; selecting a
completion navigates by exact path in bash and zsh, including `~`-abbreviated paths outside cwd.

The index includes hidden directories, scans breadth-first to depth 5, and stops at 50,000 directories or
150 ms of scanning work. Filesystem calls already in progress cannot be interrupted, so slow or network
filesystems can exceed this budget. Directory symlinks are offered but never traversed. It skips
`node_modules`, `.git`, `.cache`, `.Trash`, `.npm`, `.bun/install`, `.cargo/registry`, all of macOS `Library`,
common build output and virtual environments. Unreadable subtrees are skipped. Large homes can have a
partial index; increase the limits and run `jd index` if needed.

The first lookup builds the index synchronously and reports this on stderr. After 24 hours, lookups use
the old index immediately and start a detached refresh. Deleted directories are removed from lookup
results. Refreshes publish complete snapshots with atomic rename, including when multiple shells refresh
at once. `jd index` prints its count and elapsed time on stderr; use `jd ./index` to enter a directory
literally named `index`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JD_INDEX_ROOT` | Home directory | Discovery root |
| `JD_INDEX_FILE` | `$XDG_CACHE_HOME/jd/directories.json`, or `~/.cache/jd/directories.json` | Index state file |
| `JD_INDEX_DEPTH` | `5` | Maximum depth (up to 20) |
| `JD_INDEX_MAX_ENTRIES` | `50000` | Maximum directory count (up to 200000) |
| `JD_INDEX_BUDGET_MS` | `150` | Scan budget (up to 2000 ms) |
| `JD_INDEX_MAX_AGE_MS` | `86400000` | Refresh age (up to 30 days) |

Run `jd index` after changing scan limits. The index stores directory paths locally, not file contents.
Indexed candidate paths can be sent to the model under the same rules as local and history candidates.

For a reproducible warm-index benchmark, run `bun test/dirindex.bench.ts`. On the development machine,
loading 50,000 live directory paths and gathering candidates took **8.31 ms median / 9.91 ms p95** for
`mise`, and **31.34 ms median / 32.13 ms p95** for `src` (almost all entries match). These measurements
include local scanning, ranking, and existence checks, but exclude process startup and initial indexing.

## History and privacy

Every navigation is appended to `~/.jd_history.json` (override with `JD_HISTORY_FILE`), capped at the latest
500. Visits count less as they age (half as much per week). A missing or corrupt file is treated as empty.

What is sent to the model: the text you typed, the current directory path, candidate directory paths with
their visit counts, and your last 15 `cd` / `pushd` / `jd` commands from the shell history file. A history
line is used only if it is nothing but the command and plain path words. A line with any other shell syntax
(chaining, redirection, substitution, quotes, `KEY=value`) is dropped whole, and other commands are never read.

## Measuring accuracy

```sh
bun run eval        # needs an API key; makes ~12 model calls
```

Runs labeled queries (plain matches, ambiguous names resolved by history, a non-matching alias, and a query
that should match nothing) against the live model and prints top-1 accuracy, the auto-navigate rate, and
auto-navigate precision. A wrong automatic jump is the costly error, so precision is the number to protect:
raise the thresholds if it drops below 100%, lower them if precision holds and jd asks too often.

`jd --stats` gives the same signal from real use: how many jumps were automatic, and how often the model's
top pick was the one you chose when it asked.

## Development

```sh
bun test            # unit tests; the model is Experimental_EvaluationMockModelV4, no network
bun run typecheck
```

| File | Role |
| --- | --- |
| `src/index.ts` | CLI: argument handling, exact-match bypass, prompting, shell init and completion |
| `src/candidates.ts` | Directory discovery, name matching, local ranking |
| `src/dirindex.ts` | Bounded home discovery, persistent snapshots, background refresh |
| `src/choice.ts` | The `experimental_evaluate` call, question construction, confidence gate, model resolution |
| `src/history.ts` | History file, frequency analysis, shell-history navigation commands |
| `src/cache.ts` | Pure history-backed prediction cache, decay, dominance, and environment options |
| `scripts/accuracy.ts` | Live labeled accuracy check |

A directory literally named `init` can be reached with `jd ./init`.
