import { experimental_evaluate, gateway, type Experimental_EvaluationModel } from "ai";
import type { Candidate, MatchKind } from "./candidates";

export const QUESTION_ID = "target_directory";
export const NONE_OF_THE_ABOVE = "none_of_the_above";

/** Starting thresholds; tune against `bun run eval` and `jd --stats`. */
export const THRESHOLDS = { probability: 0.7, confidence: 0.6 } as const;

const MATCH_DESCRIPTION: Record<MatchKind, string> = {
    "exact-name": "Its name is exactly what the user typed",
    prefix: "Its name starts with what the user typed",
    substring: "Its name contains what the user typed",
    path: "Its path contains what the user typed",
    fuzzy: "Its name contains the typed letters in order, but not contiguously",
    history: "Its name does not match, but the user typed this same text to get here before",
};

function describeAge(timestamp: number, now: number): string {
    const hours = (now - timestamp) / 3_600_000;
    if (hours < 1) return "within the last hour";
    if (hours < 48) return `${Math.round(hours)} hours ago`;
    return `${Math.round(hours / 24)} days ago`;
}

export function describeCandidate(candidate: Candidate, now = Date.now()): string {
    const location =
        candidate.relation === "descendant"
            ? `${candidate.depth} level${candidate.depth === 1 ? "" : "s"} below the current directory`
            : candidate.relation === "nearby"
              ? "outside the current directory, next to one of its parent directories"
              : "elsewhere on disk, known only from past jd navigation";
    const stats = candidate.stats;
    const visits = stats
        ? `Visited ${stats.visits} time${stats.visits === 1 ? "" : "s"} via jd (${stats.queryHits} from this same typed text), last ${describeAge(stats.lastVisited, now)}`
        : "Never visited via jd";
    return `Directory ${candidate.path}, ${location}. ${MATCH_DESCRIPTION[candidate.match]}. ${visits}.`;
}

/** Option keys are what the code branches on, so map each one back to its candidate. */
export function buildOptions(candidates: Candidate[], now = Date.now()) {
    const byKey = new Map<string, Candidate>();
    const criteria: Record<string, string> = {};
    for (const candidate of candidates) {
        // `__proto__` cannot be set as a plain-object key; `~` and the escape option would collide.
        const reserved = [NONE_OF_THE_ABOVE, "__proto__"].includes(candidate.display) || byKey.has(candidate.display);
        let key = reserved || candidate.display.startsWith("~") && candidate.relation === "descendant"
            ? `./${candidate.display}`
            : candidate.display;
        while (byKey.has(key)) key = `./${key}`;
        byKey.set(key, candidate);
        criteria[key] = describeCandidate(candidate, now);
    }
    criteria[NONE_OF_THE_ABOVE] =
        "None of the listed directories is a plausible destination for what the user typed";
    return { byKey, criteria };
}

export type RankedCandidate = { candidate: Candidate; probability: number | undefined };

export type Prediction = {
    /** Selected candidate, or null when the model answered none_of_the_above. */
    selected: Candidate | null;
    /** P(selected option). Undefined when the model returns no distribution (adapters). */
    probability: number | undefined;
    /** TypeSafe concentration statistic. Undefined for non-native models. */
    confidence: number | undefined;
    /** All candidates, most probable first (input order when there is no distribution). */
    ranked: RankedCandidate[];
};

export type ChooseDirInput = {
    model: Experimental_EvaluationModel;
    query: string;
    cwd: string;
    candidates: Candidate[];
    recentNavigation: string[];
    now?: number;
    abortSignal?: AbortSignal;
};

export async function chooseDir(input: ChooseDirInput): Promise<Prediction> {
    const { byKey, criteria } = buildOptions(input.candidates, input.now);

    const result = await experimental_evaluate({
        model: input.model,
        abortSignal: input.abortSignal,
        state: {
            typedDirectoryName: input.query,
            currentDirectory: input.cwd,
            recentNavigationCommands: input.recentNavigation,
        },
        questions: {
            [QUESTION_ID]: {
                type: "choice",
                instructions:
                    "The user typed a partial or approximate directory name instead of a full path. Which directory do they want to change into?",
                criteria,
            },
        },
    });

    const answer = result.answers[QUESTION_ID];
    if (answer?.type !== "choice") throw new Error(`No choice answer returned for ${QUESTION_ID}`);

    const probabilities = answer.probabilities as Record<string, number> | undefined;
    const confidence = (result.providerMetadata?.typesafe?.confidence as Record<string, unknown> | undefined)?.[
        QUESTION_ID
    ];

    const ranked = [...byKey].map(([key, candidate]) => ({ candidate, probability: probabilities?.[key] }));
    if (probabilities) ranked.sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
    const selected = byKey.get(answer.choice) ?? null;
    if (selected && !probabilities) {
        ranked.sort((a, b) => Number(b.candidate === selected) - Number(a.candidate === selected));
    }

    return {
        selected,
        probability: probabilities?.[answer.choice],
        confidence: typeof confidence === "number" ? confidence : undefined,
        ranked,
    };
}

export type Route = "auto" | "confirm" | "options";

/**
 * Confidence-gated routing. The model says *which* directory; this decides *whether to act*.
 * A missing probability or confidence (non-native model) never auto-navigates.
 */
export function routePrediction(prediction: Prediction, thresholds = THRESHOLDS): Route {
    if (!prediction.selected) return "options";
    const { probability, confidence } = prediction;
    if (probability == null || confidence == null) return "confirm";
    return probability >= thresholds.probability && confidence >= thresholds.confidence ? "auto" : "confirm";
}

export type ResolvedModel =
    | { model: Experimental_EvaluationModel; label: string }
    | { model: null; reason: string };

/** Native TypeSafe provider when its key and package are present, otherwise AI Gateway. */
export async function resolveModel(env: NodeJS.ProcessEnv = process.env): Promise<ResolvedModel> {
    if (env.TYPESAFE_AI_API_KEY) {
        try {
            // Optional dependency: resolved at runtime so jd works with only `ai` installed.
            const specifier = "@ai-sdk/typesafe-ai";
            const { typeSafeAi } = await import(specifier);
            return { model: typeSafeAi.evaluationModel("jev-latest"), label: "typesafe-ai jev-latest" };
        } catch {
            if (!env.AI_GATEWAY_API_KEY && !env.VERCEL_OIDC_TOKEN) {
                return {
                    model: null,
                    reason: "TYPESAFE_AI_API_KEY is set but @ai-sdk/typesafe-ai is not installed (bun add @ai-sdk/typesafe-ai)",
                };
            }
        }
    }
    if (env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN) {
        return { model: gateway.evaluationModel("typesafe-ai/jev"), label: "gateway typesafe-ai/jev" };
    }
    return { model: null, reason: "no API key: set AI_GATEWAY_API_KEY or TYPESAFE_AI_API_KEY" };
}
