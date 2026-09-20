# Reviewer checklist

For an independent reviewer. Verify each item yourself; do not rely on the author's claims. Each item names
the command or file that proves it.

## 0. Baseline

- [ ] `bun install && bun test` → all tests pass, no network access needed
- [ ] `bun run typecheck` → no errors under the existing strict `tsconfig.json`
- [ ] `package.json` still depends only on `ai` (+ `@types/bun`); `@ai-sdk/typesafe-ai` is optional and loaded
      dynamically in `resolveModel`

## 1. SDK compliance

- [ ] `grep -rn "TypeSafeClient\|system_one\|api.typesafe.ai\|from \"typesafe" src scripts` → no results
- [ ] The only model call is `experimental_evaluate` imported from `ai` (`src/choice.ts`, `chooseDir`)
- [ ] Models are `gateway.evaluationModel("typesafe-ai/jev")` and `typeSafeAi.evaluationModel("jev-latest")`
- [ ] `state` is one JSON object of facts (typed text, cwd, recent navigation); no judgment text in it
- [ ] The answer is read as `answer.choice`, `answer.probabilities?.[choice]`, and
      `result.providerMetadata?.typesafe?.confidence?.[QUESTION_ID]`, each with a null check
- [ ] Tests use `Experimental_EvaluationMockModelV4` from `ai/test` and go through the real
      `experimental_evaluate` (so SDK answer validation runs), not a stub of `chooseDir`

## 2. Question design (`evaluation-question-design` skill)

- [ ] Exactly one question, type `choice`; it asks one snap judgment ("which directory?") and hides no
      weighting or policy. Test: `model call format`
- [ ] The full question is in `instructions`; the ID `target_directory` is only used by code
- [ ] Every candidate is an option, plus `none_of_the_above`; option count ≤ 201, within TypeSafe's 255 limit
- [ ] Descriptions separate options: print a real request and read them. Two similarly named directories
      must differ in path, location, match kind, or visit history
- [ ] Multi-factor logic (match weights, frecency, thresholds, routing) is TypeScript: `gatherCandidates`,
      `routePrediction`
- [ ] Judge for yourself: each option description carries four facts (location, match kind, visit count,
      recency) and the model weighs them unguided. Is that still one snap judgment? The spec asked for
      criteria descriptions that separate options; the alternative is a candidates table in `state`
- [ ] Candidates are capped at 200 (the set is unbounded on a real disk); only the weakest matches are cut

## 3. Required behaviors

| Behavior | Test | Manual check |
| --- | --- | --- |
| Exact match makes no model call | `exact match bypass` | `jd src` with no API key set jumps immediately |
| History frequency affects ranking | `history analysis` | |
| Request format | `model call format` | |
| Gate at p ≥ 0.7 and confidence ≥ 0.6, boundaries included | `confidence gating` (table test) | |
| Missing probability or confidence never auto-navigates | `confidence gating` | |
| `none_of_the_above` never navigates | `confidence gating` | |
| Model failure → local list, no auto-jump | `error handling` | unset both keys, run `jd sr` |
| Empty / corrupt history | `history file` | `echo '{' > ~/.jd_history.json; jd src` |
| Tab completion, no model call | `tab completion` | `jd sr<Tab>` after `eval "$(bun src/index.ts init zsh)"` |

- [ ] stdout carries only the destination path (or `init` / `--complete` output); all messages go to stderr
- [ ] Only `cd` / `pushd` / `jd` lines made of plain path words can reach the model; a line with any other
      shell syntax is dropped whole (allowlist, not a delimiter blacklist; tests: `shell history secrets`)
- [ ] The real readline prompt returns the typed answer (test: `real prompt`; the other tests inject a prompt)
- [ ] `init` output single-quotes the install path; the `tab completion` tests evaluate it in real zsh and bash

## 4. Accuracy metrics

**Not yet measured by the author: no API key was available when this was written.** The reviewer must run:

- [ ] `bun run eval` with a key set. Record the three numbers here:
  - top-1 accuracy: ____ / 12
  - auto-navigate rate: ____ / 12
  - auto-navigate precision: ____ / ____ (target: every automatic jump correct)
- [ ] Confirm the live response actually contains `probabilities` and `providerMetadata.typesafe.confidence`.
      If confidence is absent on the Gateway route, every answer routes to "confirm" and jd never
      auto-navigates; that must be fixed or documented before release
- [ ] If precision < 100%, raise `THRESHOLDS`; if it holds and the auto rate is low, consider lowering them.
      0.7 / 0.6 came from the spec, not from data
- [ ] Add 5+ cases from your own directory layout to `CASES` in `scripts/accuracy.ts` and re-run
- [ ] After a week of use, check `jd --stats`: the "top pick was right when it asked" rate shows whether
      the confirm band is too wide

## 5. Known limitations to weigh

- Scans 3 levels down and 3 up; deeper directories are reachable only after one visit puts them in history
- `jd -` and `jd` with no argument are not mapped to `cd -` / `cd ~`
- History writes are atomic per write but two simultaneous `jd` runs can lose one entry
- A corrupt history file is read as empty and overwritten by the next navigation, with no backup
- Confidence is a concentration statistic; its scale with up to 201 options is unknown until the eval runs
