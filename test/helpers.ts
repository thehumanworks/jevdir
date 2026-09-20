import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import type { Deps } from "../src/index";

type DoEvaluate = Experimental_EvaluationMockModelV4["doEvaluate"];
export type EvaluateOptions = Parameters<DoEvaluate>[0];

/** Creates a temp workspace containing the given relative directories. */
export function makeTree(dirs: string[]): string {
    // Nested so the "nearby" scan of parent directories sees only empty, test-owned folders.
    const root = join(realpathSync(mkdtempSync(join(tmpdir(), "jd-test-"))), "l1", "l2", "l3", "ws");
    mkdirSync(root, { recursive: true });
    for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
    return root;
}

/**
 * Mock Jev: answers the single choice question with the given distribution and records
 * every call so tests can assert on the exact request the SDK sent.
 */
export function mockJev(
    answer: (options: EvaluateOptions) => { choice: string; probabilities?: Record<string, number>; confidence?: number },
) {
    const calls: EvaluateOptions[] = [];
    const model = new Experimental_EvaluationMockModelV4({
        doEvaluate: async (options) => {
            calls.push(options);
            const { choice, probabilities, confidence } = answer(options);
            return {
                answers: { target_directory: { type: "choice", choice, probabilities } },
                warnings: [],
                providerMetadata:
                    confidence == null ? undefined : { typesafe: { confidence: { target_directory: confidence } } },
            };
        },
    });
    return { model, calls };
}

/** Spreads the probability left over after `top` evenly across the other options. */
export function distribution(options: EvaluateOptions, top: string, p: number): Record<string, number> {
    const question = options.questions.target_directory;
    if (question?.type !== "choice") throw new Error("expected a choice question");
    const keys = Object.keys(question.criteria);
    const rest = (1 - p) / (keys.length - 1);
    return Object.fromEntries(keys.map((key) => [key, key === top ? p : rest]));
}

export function makeDeps(cwd: string, overrides: Partial<Deps> = {}): Deps & { logs: string[] } {
    const logs: string[] = [];
    return {
        cwd,
        historyFile: join(cwd, ".jd_history_test.json"),
        recentNavigation: () => ["cd ~/work", "jd api"],
        interactive: false,
        prompt: async () => "",
        log: (line) => logs.push(line),
        now: () => 1_800_000_000_000,
        logs,
        ...overrides,
    };
}
