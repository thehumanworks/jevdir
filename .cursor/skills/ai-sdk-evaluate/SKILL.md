---
name: ai-sdk-evaluate
description: >-
  Calls Vercel AI SDK experimental_evaluate with an evaluation model, one shared
  state, and typed choice, score, and boolean questions. Use when writing or
  reviewing evaluation code, experimental_evaluate, evaluationModel, TypeSafe
  Jev through the ai package, AI Gateway evaluation IDs, provider registries,
  probability routing, retries, or Experimental_EvaluationMockModelV4 tests.
  Prefer typeSafeAi.evaluationModel(...) via ai, not the TypeSafe SDK.
---

# AI SDK Evaluate

Use `experimental_evaluate` from `ai` as the only integration path. TypeSafe/Jev is an evaluation model behind that API — do not call TypeSafe's own SDK (`TypeSafeClient`, `system_one`, `choice()` / `noul()` helpers).

For question wording, type choice, and routing policy, also apply `evaluation-question-design`.

## Experimental API

`experimental_evaluate` and the v4 evaluation-model spec may change in patch releases. Public types keep the `Experimental_` prefix (`Experimental_EvaluationModel`, `Experimental_EvaluationQuestion`, `Experimental_EvaluationAnswer`, `Experimental_EvaluationResult`).

## Call shape

```ts
import { experimental_evaluate, type Experimental_EvaluationModel } from 'ai';

async function triage(model: Experimental_EvaluationModel, message: string) {
  return experimental_evaluate({
    model,
    state: { message },
    questions: {
      department: {
        type: 'choice',
        instructions: 'Which team should handle this?',
        criteria: {
          billing: 'Payments and refunds',
          support: 'Other requests',
        },
      },
      severity: {
        type: 'score',
        instructions: 'How severe is the issue?',
        criteria: ['Cosmetic', 'Workaround exists', 'Blocking; no workaround'],
      },
      requestsRefund: {
        type: 'boolean',
        instructions: 'Is the customer requesting money back?',
      },
    },
  });
}
```

A successful call returns one answer per question ID. There is no partial success and no automatic model substitution.

Optional call fields: `maxRetries` (default `2`), `abortSignal`, `headers`, `providerOptions`.

## Resolve an evaluation model

Pass a v4 evaluation-model instance, a registry alias, or a string ID.

### Prefer TypeSafe native through `ai`

```ts
import { typeSafeAi } from '@ai-sdk/typesafe-ai';
import { experimental_evaluate } from 'ai';

const result = await experimental_evaluate({
  model: typeSafeAi.evaluationModel('jev-latest'),
  state: 'I was charged twice. Please refund the extra charge.',
  questions: {
    refund: {
      type: 'boolean',
      instructions: 'Is the customer asking for a refund?',
    },
  },
});

result.answers.refund.probability; // P(true) in [0, 1]
```

Requires `@ai-sdk/typesafe-ai` and `TYPESAFE_AI_API_KEY`. Use `createTypeSafeAi({ apiKey, baseURL, headers, fetch })` when the default provider is not enough.

### Gateway (string ID or `gateway.evaluationModel`)

When no `AI_SDK_DEFAULT_PROVIDER` is set, string IDs resolve through Vercel AI Gateway (`AI_GATEWAY_API_KEY` or Vercel OIDC). The typed Gateway ID is `typesafe-ai/jev`. Docs also show `typesafe-ai/jev-latest`.

```ts
import { experimental_evaluate, gateway } from 'ai';

await experimental_evaluate({
  model: 'typesafe-ai/jev',
  state: 'The support agent issued a full refund.',
  questions: {
    refunded: {
      type: 'boolean',
      instructions: 'Was a refund issued?',
    },
  },
});

// Equivalent explicit instance:
gateway.evaluationModel('typesafe-ai/jev');
```

Gateway-specific settings go in `providerOptions.gateway` (for example `{ zeroDataRetention: true }`).

### Registry aliases

```ts
import { typeSafeAi } from '@ai-sdk/typesafe-ai';
import { openai } from '@ai-sdk/openai';
import {
  createProviderRegistry,
  customProvider,
  experimental_evaluate,
} from 'ai';

const registry = createProviderRegistry({
  triage: customProvider({
    evaluationModels: {
      native: typeSafeAi.evaluationModel('jev-latest'),
      compact: openai.evaluationModel('gpt-5.6-luna'),
    },
    fallbackProvider: typeSafeAi,
  }),
  openai,
});

const result = await experimental_evaluate({
  model: registry.evaluationModel('triage:native'),
  state: 'I was charged twice.',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'Charges and refunds', support: 'Other requests' },
    },
  },
});

result.answers.department.choice; // 'billing' | 'support'
```

IDs are `providerId:modelId`. Only the first separator counts. Custom aliases beat `fallbackProvider`. A fallback only resolves unknown IDs — it does not retry failures or swap models when a question type is unsupported. Language/image middleware does not wrap evaluation models. Keep the inferred registry type, or use `Experimental_EvaluationProviderRegistry`, to retain `evaluationModel`.

### Default-provider strings

Set once at process startup, not per request (it affects other AI SDK calls):

```ts
globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
  evaluationModels: { native: registry.evaluationModel('triage:native') },
});

await experimental_evaluate({
  model: 'native',
  state: 'I was charged twice.',
  questions: {
    refund: { type: 'boolean', instructions: 'Is the customer asking for a refund?' },
  },
});
```

A direct provider such as `typeSafeAi` can be the default; then pass its unprefixed ID (`'jev-latest'`). Prefer model instances inside `evaluationModels` to avoid resolution cycles. An explicit default provider must expose `evaluationModel`; Gateway is used only when none is configured.

Example factory IDs (`gpt-5.6-luna`, `claude-haiku-4-5-20251001`, `gemini-3.5-flash-lite`) show API compatibility. They are not recommended defaults. Judge quality on labeled task data.

## Native TypeSafe vs language-model adapters

| | TypeSafe native (`typeSafeAi` / Gateway Jev) | OpenAI / Anthropic / Google `evaluationModel` |
| --- | --- | --- |
| Execution | Independent questions against one state | One structured-output prompt for all questions |
| Choice / score | Selected value **and** full `probabilities` | Selected value only — no distributions |
| Boolean | Native P(true) | Prompted P(true); finite and in `[0, 1]`, not calibrated |
| Confidence | `result.providerMetadata?.typesafe?.confidence[questionId]` for choice/score | Not provided |
| Reasoning | Native evaluation; no LM reasoning knob | Adapters send `reasoning: 'none'` by default; override with `providerOptions` |

Adapters do not give TypeSafe independent-question semantics. Enable reasoning only when the adapter model supports it, for example `providerOptions: { openai: { reasoningEffort: 'high' } }` (takes precedence over the default).

Pick a model that supports the provider's structured-output API when using adapters.

## One shared state

`state` is a JSON-compatible **string**, **object**, or **array**. An array is one state (for example a transcript), not a batch of unrelated inputs. Run a separate call per unrelated state.

Not JSON-compatible: functions, class instances, cycles, `undefined`, non-finite numbers. Jev is text-only (no images/audio/video).

Put facts in `state`. Put judgments in `questions`. Question IDs are for your code; write the full question in `instructions`.

## Question types and answers

| Type | Criteria | Answer |
| --- | --- | --- |
| `choice` | Nonempty map of option key → description | `choice` (union of keys); optional `probabilities` |
| `score` | At least two ordered level descriptions | Fractional `score` in `[0, levels.length - 1]`; optional `probabilities` |
| `boolean` | Optional `{ true, false }` descriptions | Required `probability` = P(true), not confidence |

Instructions and descriptions: string, JSON object, or JSON array. Descriptions may be `null`. Core treats structured descriptions as content and does not interpret keys.

When a choice distribution is present, it includes every option and the selected `choice` has maximal probability. Score distributions use string keys `"0"`, `"1"`, …; `score` equals the probability-weighted mean. Without a distribution, `score` is the model's estimated rubric position.

Invalid provider output is rejected. Values are never silently renormalized. See [reference.md](reference.md) for tolerances and TypeSafe limits.

## Probabilities vs confidence

- **Boolean `probability`**: `0.98` is a strong yes, `0.02` a strong no, `~0.5` is uncertain. It is not confidence in either outcome.
- **Choice/score `probabilities`**: optional. Check before reading — adapters omit them.
- **TypeSafe confidence**: a separate concentration statistic at `result.providerMetadata?.typesafe?.confidence`, keyed by question ID. It is not the selected option's probability and is not portable across providers.

```ts
const answer = result.answers.department;
const selectedProbability = answer.probabilities?.[answer.choice];
if (selectedProbability != null && selectedProbability >= 0.9) {
  // Route automatically; otherwise use the application's review path.
}

if (result.answers.requestsRefund.probability >= 0.8) {
  // Route to the refunds queue. Fit the threshold on labeled task data.
}
```

The SDK does not promise calibration across providers. Fit thresholds per model and task.

## Errors, retries, cancellation

Unsupported types are rejected **before** provider I/O with `Experimental_EvaluationUnsupportedQuestionTypeError`. Invalid inputs throw `InvalidArgumentError`. Missing/mismatched answers or invalid options, scores, or probabilities throw `InvalidResponseDataError` (not retried). Missing registry providers throw `NoSuchProviderError`. Missing models or `evaluationModel` throw `NoSuchModelError` with `modelType: 'evaluationModel'`. Wrong spec versions throw `UnsupportedModelVersionError`.

Transient provider failures use the normal retry policy (`maxRetries: 2`). Use `abortSignal` to cancel. TypeSafe provider failures surface as `APICallError`; unknown `providerOptions.typesafe` keys warn.

`result` also has `usage` (`inputTokens` / `outputTokens` / `totalTokens` — `totalTokens` only when both sides are known), `warnings`, `rounding`, `providerMetadata`, and `response`.

## Testing

```ts
import { Experimental_EvaluationMockModelV4 } from 'ai/test';

const model = new Experimental_EvaluationMockModelV4({
  doEvaluate: async () => ({
    answers: {
      department: {
        type: 'choice',
        choice: 'billing',
        probabilities: { billing: 0.92, support: 0.08 },
      },
    },
    warnings: [],
    providerMetadata: { typesafe: { confidence: { department: 0.88 } } },
  }),
});
```

Pass the mock as `model` to exercise routing branches without network I/O.

## Scope

One complete result for one shared state. No streaming answers, no multilabel classification, no batch of unrelated states. The SDK does not pick a model.

Official runnable samples live in the AI SDK repo under `examples/ai-functions/src/evaluate`.

## Additional resources

- Provider tables, TypeSafe limits, errors, rounding: [reference.md](reference.md)
- Official API: https://ai-sdk.dev/docs/ai-sdk-core/evaluation
- TypeSafe provider: https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai
