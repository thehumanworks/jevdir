---
name: evaluation-question-design
description: >-
  Designs atomic TypeSafe / System One / Jev judgment questions for Vercel AI
  SDK experimental_evaluate. Use when writing or reviewing evaluation questions,
  instructions, criteria, choice vs score vs boolean (Noul), triage, intent
  routing, composite scoring, speculative fan-out, or probability and confidence
  gates. Implement questions only as the ai SDK questions object; compose
  multi-factor judgments in application code.
---

# Evaluation Question Design

Write questions for `experimental_evaluate` from `ai`. TypeSafe/Jev is the preferred **evaluation model** (System One), not a separate client. Never emit TypeSafe SDK calls (`TypeSafeClient`, `system_one`, `Choice()` / `Score()` / `Noul()` constructors).

For how to call the API, resolve models, and read answer types, apply `ai-sdk-evaluate`.

## Name mapping

Use AI SDK type names in code. TypeSafe docs use different labels for the same judgments.

| TypeSafe / Jev | AI SDK `type` | Answer to read |
| --- | --- | --- |
| Choice | `choice` | `answer.choice`, optional `answer.probabilities` |
| Score | `score` | `answer.score`, optional `answer.probabilities` |
| Noul (boolean) | `boolean` | `answer.probability` (P(true); TypeSafe field is `noul`) |

TypeSafe choice/score **confidence** is not an answer field. Read `result.providerMetadata?.typesafe?.confidence[questionId]` when using a native TypeSafe evaluation model. Language-model adapters do not provide it.

## One snap judgment per question

Each question should be a gut-check a knowledgeable person could make in a few seconds given the state. "Does this message convey urgency?" is in scope. "Analyze this and decide the best course of action" is not — that is several factors plus policy.

If a judgment weighs independent factors, split it. Ask each factor, then combine in application code (weights, thresholds, if/else). When priorities change, change coefficients — do not rewrite a mega-prompt.

```ts
// Bad: one multi-factor score the model must secretly weight
{
  type: 'score',
  instructions: 'Rate this startup pitch overall',
  criteria: ['Weak', 'Average', 'Strong'],
}

// Good: atomic scores; compose later
{
  marketSize: {
    type: 'score',
    instructions: 'How large is the stated market?',
    criteria: ['Unclear or tiny', 'Niche', 'Large and growing'],
  },
  technicalFeasibility: {
    type: 'score',
    instructions: 'How feasible is the proposed technical approach?',
    criteria: ['Implausible', 'Hard but known', 'Straightforward'],
  },
  differentiation: {
    type: 'score',
    instructions: 'How distinct is this from named competitors in the state?',
    criteria: ['Undifferentiated', 'Some contrast', 'Clear wedge'],
  },
}
```

Then in application code, for example:

```ts
const composite =
  0.4 * result.answers.marketSize.score +
  0.3 * result.answers.technicalFeasibility.score +
  0.3 * result.answers.differentiation.score;
```

## Choose choice, score, or boolean

Pick the type whose answer your code can act on.

- **`choice`**: one option from an unordered closed set (department, language, intent). Keys are the values your code branches on. Add `other` or `none_of_the_above` when the list may not cover every input. TypeSafe native allows 1–255 options; send the full set rather than a shortlist.
- **`score`**: a position on an ordered rubric you define (severity, frustration, skill). Levels are yours. The answer is a fractional index in `[0, levels.length - 1]`, not a 0–100 grade unless you build that rubric. TypeSafe native allows 2–10 levels.
- **`boolean`**: a yes/no whose useful signal is P(true) (refund requested? contains PII?). Optional `criteria.true` / `criteria.false` sharpen what counts.

Do not use boolean to measure a spectrum. `probability === 0.5` means yes and no are equally likely, **not** "medium skill." For skill, use a score with defined levels. For a decision, write a crisp condition: "Does the resume state that the candidate has used Python at work?"

If two types seem to fit, prefer the one that maps onto a code path: choice → switch, score → threshold, boolean → `if (probability >= t)`.

## Instructions and criteria

- Question IDs (`refund_requested`) are for your code. They are not the prompt. Put the complete question in `instructions`.
- Start with string instructions. Use a JSON object or array when the question needs structured fields (a record to compare against, include/exclude lists). Core does not interpret those keys.
- Choice option keys **and** descriptions are sent to the model. Write descriptions that separate options from each other.
- Keep policy and facts in `state`; keep the judgment in the question. Example: refund request + policy in state; "Does the policy support a refund for this request?" as a boolean.

```ts
questions: {
  isRepeatContact: {
    type: 'boolean',
    instructions: 'Has the customer contacted support about this before?',
    criteria: {
      true: 'Mentions a prior attempt, ticket, or that they have asked before',
      false: 'No sign of any previous contact',
    },
  },
}
```

## Mix types; evaluate independent questions together

Mix `choice`, `score`, and `boolean` in one `questions` object. They share one state. On a native TypeSafe evaluation model, questions are evaluated independently — adding a question does not rewrite the others (no context-rot). Language-model adapters put every question in one prompt and do **not** have that guarantee.

Ask every question the decision tree might need in that one call (**speculative fan-out**). Ignore unused answers in code. Extra questions still cost tokens; do not add junk, but do not serialize the tree into many round-trips either.

Unrelated states (two tickets, two candidates) are separate `experimental_evaluate` calls. An array state is one transcript or list, not a batch.

## Compose in application code

Keep control flow in TypeScript:

1. Read typed answers (`choice`, `score`, `probability`).
2. Apply thresholds and weights you own.
3. Route to deterministic code, a specialist LLM, or a human.

The evaluation model classifies and scores. Granting a refund, paging someone, or executing a transfer is application policy.

## Probabilities and confidence for routing

Use uncertainty as a second axis. The answer is *what*; probability/confidence is *whether to act*.

| Signal | Use when | Treat as |
| --- | --- | --- |
| Boolean `probability` | Every boolean answer | P(true). Fit `t` on labeled data. Raise `t` when a false yes is expensive. |
| Choice/score `probabilities` | Native TypeSafe (optional elsewhere) | Full distribution. Gate on `probabilities[choice]` only after a null check. |
| `providerMetadata.typesafe.confidence` | Native TypeSafe choice/score | Concentration of that distribution. Not portable; not the selected probability. |

Adapters omit choice/score distributions and TypeSafe confidence. Branch on `choice` / `score` / boolean `probability` only, or do not use adapters for gated routing.

Starting pattern (fit numbers to the task):

- **High certainty** → act automatically
- **Medium** → confirm, flag, or gather more state
- **Low** → human, clarification, or a different system

Scale the floor with risk. Showing a balance can use a lower bar than approving a transfer. Example shape (TypeSafe native):

```ts
const intent = result.answers.intent;
const confidence = result.providerMetadata?.typesafe?.confidence?.intent ?? 0;
const selected = intent.probabilities?.[intent.choice];

if (confidence < 0.6 || selected == null || selected < 0.7) {
  return { action: 'human-review' as const };
}
if (intent.choice === 'check_balance') return { action: 'show-balance' as const };
if (intent.choice === 'approve_transfer' && confidence > 0.85) {
  return { action: 'approve' as const };
}
return { action: 'confirm' as const };
```

Do not copy these thresholds into a new domain. Start conservative, measure, then adjust.

## Patterns

**Intent routing.** One choice (plus optional complexity score) in front of handlers: deterministic lookup, specialist LLM, or human. Evaluation stays cheap and narrow; expensive models run only when routed there.

**Composite scoring.** Several atomic scores in one call; normalize (for example `score / (levels.length - 1)`) and weight in code. Change weights per role or product without new questions.

**Confidence-gated routing.** `choice` says which path; confidence or selected probability says whether that path is safe.

**Speculative fan-out.** Category + bug severity + refund-requested + frustration in one call. Code reads severity only when category is `bug_report`.

## Anti-patterns

- TypeSafe SDK or raw `https://api.typesafe.ai/v1/systemone` instead of `experimental_evaluate`
- One vague question that hides weighting, ranking, and policy
- Boolean used as a 0–1 skill meter
- Treating `~0.5` boolean probability as a middle rubric level
- Assuming adapter answers have `probabilities` or TypeSafe confidence
- Using one call's array `state` to evaluate unrelated records
- Multilabel "pick all that apply" (not supported — use parallel booleans or a choice with `other`)
- Copying exploratory app snippets as the architecture; keep questions and routing explicit in the call site
