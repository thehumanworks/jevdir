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
jd never calls the TypeSafe SDK or HTTP API itself. Without a key jd still works: exact matches navigate, and
everything else shows a locally ranked list to pick from.

## Usage

```sh
jd src/components   # a real path from here: goes straight there, no API call
jd comp             # partial name: the model picks, jd jumps if it is sure
jd api<Tab>         # tab completion: matching directories, ranked locally (no API call)
jd --stats          # how past navigations were decided
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
2. **Candidates.** Otherwise jd collects directories up to 3 levels below the current directory, the parent
   directories (3 levels up) and their children, and every directory in jd history. `node_modules`, build
   output, and hidden directories are skipped (hidden ones are included when the query starts with `.`).
   A directory is kept if its name matches the query (exact, prefix, substring, path fragment, or letters in
   order) or if this same query led there before. Directories from history are included even when hidden.
   Up to 200 go to the model (its limit is 255 options), ordered by match quality and visit frequency.
3. **One question.** A single `choice` question, `target_directory`, lists every candidate plus
   `none_of_the_above`. Each option's description states the full path, where it sits relative to the
   current directory, how the name matches, and its visit history, so options are distinguishable from each
   other. The typed text, current directory, and recent `cd`/`jd` commands go in `state`.
4. **Gate.** jd reads `answer.choice`, `answer.probabilities[choice]`, and
   `result.providerMetadata.typesafe.confidence.target_directory`:

   | Condition | What happens |
   | --- | --- |
   | probability ≥ 0.7 **and** confidence ≥ 0.6 | jump |
   | anything lower, or either number missing | show the top 5 by probability and ask |
   | `none_of_the_above` | show the closest candidates; Enter cancels, only an explicit number jumps |
   | model error, timeout (10 s), or no key | show the local ranking and ask; never jumps |

The thresholds live in `THRESHOLDS` in `src/choice.ts`. They are starting values, not fitted ones; see
[Measuring accuracy](#measuring-accuracy).

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

### Testing

The fast-check properties in `test/*.property.test.ts` test hostile strings, shell-history privacy,
matching and path displays, history persistence and decay, unique model options, confidence thresholds,
and end-to-end navigation. Model tests use `Experimental_EvaluationMockModelV4` through the real
`experimental_evaluate`; they make no provider requests. Filesystem tests use temporary directories,
and shell-quoting tests execute a real `sh`. Run all tests with `bun test`.

Failures print a seed, shrink path, and counterexample. Replay a single failing property with its reported
values (use the exact test name so the shrink path applies to the same property):

```sh
FC_SEED=-123 FC_PATH='0:1:2' bun test test/choice.property.test.ts -t 'option keys remain bijective'
```

Omit `FC_PATH` to rerun all cases for a seed. Pure properties run 100–300 cases; filesystem and SDK
properties use smaller budgets to keep the full suite fast. Regression tests preserve discovered cases:
colliding escaped option names, a zero shell-history limit, and newline-containing destinations.
The CLI rejects newline-containing destination paths without recording a navigation, so stdout remains
one directory per line.

| File | Role |
| --- | --- |
| `src/index.ts` | CLI: argument handling, exact-match bypass, prompting, shell init and completion |
| `src/candidates.ts` | Directory discovery, name matching, local ranking |
| `src/choice.ts` | The `experimental_evaluate` call, question construction, confidence gate, model resolution |
| `src/history.ts` | History file, frequency analysis, shell-history navigation commands |
| `scripts/accuracy.ts` | Live labeled accuracy check |

A directory literally named `init` can be reached with `jd ./init`.
