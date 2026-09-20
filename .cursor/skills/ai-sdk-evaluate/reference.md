# Evaluation API reference

Details for `experimental_evaluate` from `ai`. Read this when you need provider tables, TypeSafe limits, errors, or rounding rules.

## Provider factories

Use each provider's `evaluationModel` factory. Example IDs show API compatibility, not recommended defaults.

| Provider | Package | Example |
| --- | --- | --- |
| TypeSafe AI (native) | `@ai-sdk/typesafe-ai` | `typeSafeAi.evaluationModel('jev-latest')` |
| AI Gateway | `ai` / `@ai-sdk/gateway` | `gateway.evaluationModel('typesafe-ai/jev')` or string `'typesafe-ai/jev'` |
| OpenAI (adapter) | `@ai-sdk/openai` | `openai.evaluationModel('gpt-5.6-luna')` |
| Anthropic (adapter) | `@ai-sdk/anthropic` | `anthropic.evaluationModel('claude-haiku-4-5-20251001')` |
| Google (adapter) | `@ai-sdk/google` | `google.evaluationModel('gemini-3.5-flash-lite')` |

Native TypeSafe env: `TYPESAFE_AI_API_KEY` (`createTypeSafeAi` also accepts `apiKey`, `baseURL` default `https://api.typesafe.ai/v1`, `headers`, `fetch`). Gateway env: `AI_GATEWAY_API_KEY` or Vercel OIDC.

`gateway.evaluation(...)` is an alias of `gateway.evaluationModel(...)`.

## TypeSafe native limits (via `ai`)

The SDK name is always `boolean`. TypeSafe's HTTP field is `noul`; the provider maps it.

| Question | TypeSafe primitive | Limits / payload |
| --- | --- | --- |
| `choice` | Choice | 1–255 options; `choice` + full `probabilities` |
| `score` | Score | 2–10 ordered levels; fractional `score` + full `probabilities` |
| `boolean` | Noul | Required P(true); no separate confidence |

TypeSafe typically rounds scores and probabilities to two decimals. `result.rounding` reports `probabilityDecimals` / `scoreDecimals` so core can allow rounding error. Returned numbers are preserved, not rewritten.

Choice/score confidence: `result.providerMetadata?.typesafe?.confidence[questionId]`.

## Input validation

Thrown as `InvalidArgumentError` before provider I/O:

- `state` must be a JSON-compatible string, object, or array
- `questions` must be a nonempty map
- `instructions` must be a JSON-compatible string, object, or array
- `choice` criteria: nonempty option map
- `score` criteria: array of at least two levels
- `boolean` criteria: omit, or only `true` / `false` keys
- Criteria descriptions: JSON-compatible string, object, array, or `null`

## Answer validation

Thrown as `InvalidResponseDataError` (not retried):

- Exactly one answer per question ID; `answer.type` matches the question
- Choice must be a known option; if `probabilities` exist they must cover every option, each in `[0, 1]`, sum to 1 (within tolerance), and the selected option must have maximal probability
- Score must be finite in `[0, levels.length - 1]`; if `probabilities` exist, keys are `"0"`…`"${n-1}"` and `score` equals the probability-weighted mean
- Boolean must return finite P(true) in `[0, 1]`

Default absolute tolerance is `0.000001`. If the provider sets `rounding.probabilityDecimals` or `rounding.scoreDecimals` (integers 0–15), validation also allows half a unit in the last place per rounded value, accumulated over the sum or weighted mean. Example: two-decimal probabilities may sum to `0.99`.

## Errors

| Error | When |
| --- | --- |
| `Experimental_EvaluationUnsupportedQuestionTypeError` | A question `type` is not in `model.supportedQuestionTypes` (checked before I/O). Fields: `questionId`, `questionType`, `provider`, `modelId`. Use `.isInstance(error)`. |
| `InvalidArgumentError` | Bad `state`, `questions`, or criteria |
| `InvalidResponseDataError` | Missing, mistyped, or invalid answers |
| `NoSuchProviderError` | Unknown registry provider ID (`modelType: 'evaluationModel'`) |
| `NoSuchModelError` | Unknown model or provider lacks `evaluationModel` (`modelType: 'evaluationModel'`) |
| `UnsupportedModelVersionError` | Resolved model is not evaluation spec `v4` |
| `APICallError` | TypeSafe/provider HTTP, auth, or validation failure |

Use `Experimental_EvaluationUnsupportedQuestionTypeError.isInstance` (works across package copies).

## Result fields

```ts
type Experimental_EvaluationResult<QUESTIONS> = {
  answers: { [ID in keyof QUESTIONS]: Experimental_EvaluationAnswer<QUESTIONS[ID]> };
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  };
  warnings: SharedV4Warning[];
  rounding?: { probabilityDecimals?: number; scoreDecimals?: number };
  providerMetadata?: SharedV4ProviderMetadata;
  response: { timestamp: Date; modelId: string; id?: string; headers?: ...; body?: unknown };
};
```

Choice answers infer `choice` as `Extract<keyof criteria, string>`.

## Model contract

`Experimental_EvaluationModelV4` (`@ai-sdk/provider`): `specificationVersion: 'v4'`, `provider`, `modelId`, `supportedQuestionTypes`, `doEvaluate(options)`. Isolated from stable `ProviderV4`.

`doEvaluate` options: `state`, `questions`, `abortSignal`, `headers`, `providerOptions`. Must return every question; no partial results.

## Mock constructor

`Experimental_EvaluationMockModelV4` from `ai/test`:

- defaults: `provider: 'mock-provider'`, `modelId: 'mock-model-id'`, `supportedQuestionTypes: ['choice', 'score', 'boolean']`
- override `doEvaluate` (defaults to `notImplemented`)
