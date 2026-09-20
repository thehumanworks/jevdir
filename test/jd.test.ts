import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { NONE_OF_THE_ABOVE, routePrediction, type Prediction } from "../src/choice";
import { loadHistory } from "../src/history";
import { promptOn, run } from "../src/index";
import { distribution, makeDeps, makeTree, mockJev } from "./helpers";

const TREE = ["src/components", "src/compiler", "docs", "packages/api-server", "packages/api-client"];

describe("exact match bypass", () => {
    test("navigates to an existing directory without calling the model", async () => {
        const root = makeTree(TREE);
        const { model, calls } = mockJev(() => ({ choice: NONE_OF_THE_ABOVE }));
        const deps = makeDeps(root, { model });

        const result = await run(["src/components"], deps);

        expect(result).toEqual({ exitCode: 0, stdout: join(root, "src/components") });
        expect(calls).toHaveLength(0);
        expect(loadHistory(deps.historyFile)[0]).toMatchObject({ query: "src/components", source: "exact" });
    });

    test("a partial name is not an exact match and does call the model", async () => {
        const root = makeTree(TREE);
        const { model, calls } = mockJev((options) => ({
            choice: "src/components",
            probabilities: distribution(options, "src/components", 0.9),
            confidence: 0.9,
        }));

        await run(["compon"], makeDeps(root, { model }));

        expect(calls).toHaveLength(1);
    });
});

describe("model call format", () => {
    test("sends one atomic choice question with every candidate and an escape option", async () => {
        const root = makeTree(TREE);
        const { model, calls } = mockJev((options) => ({
            choice: "packages/api-server",
            probabilities: distribution(options, "packages/api-server", 0.9),
            confidence: 0.9,
        }));

        await run(["api"], makeDeps(root, { model }));

        const { state, questions } = calls[0]!;
        expect(Object.keys(questions)).toEqual(["target_directory"]);
        const question = questions.target_directory!;
        if (question.type !== "choice") throw new Error("expected a choice question");
        expect(typeof question.instructions).toBe("string");
        expect(Object.keys(question.criteria).sort()).toEqual(
            [NONE_OF_THE_ABOVE, "packages/api-client", "packages/api-server"].sort(),
        );
        // Descriptions must separate options: full path, match kind, and visit history.
        expect(question.criteria["packages/api-server"]).toContain(join(root, "packages/api-server"));
        expect(question.criteria["packages/api-server"]).toContain("starts with what the user typed");
        expect(question.criteria["packages/api-server"]).toContain("Never visited via jd");
        // Facts live in state, not in the question.
        expect(state).toEqual({
            typedDirectoryName: "api",
            currentDirectory: root,
            recentNavigationCommands: ["cd ~/work", "jd api"],
        });
    });
});

describe("confidence gating", () => {
    const base = { selected: { path: "/x" } as Prediction["selected"], ranked: [] };

    test.each([
        [0.7, 0.6, "auto"],
        [0.95, 0.9, "auto"],
        [0.69, 0.9, "confirm"],
        [0.9, 0.59, "confirm"],
        [undefined, 0.9, "confirm"], // adapter models return no distribution
        [0.9, undefined, "confirm"], // ...and no TypeSafe confidence
    ] as const)("probability %p + confidence %p → %s", (probability, confidence, expected) => {
        expect(routePrediction({ ...base, probability, confidence })).toBe(expected);
    });

    test("none_of_the_above never navigates, however certain", () => {
        expect(routePrediction({ ...base, selected: null, probability: 0.99, confidence: 0.99 })).toBe("options");
    });

    test("high certainty auto-navigates and reports both metrics", async () => {
        const root = makeTree(TREE);
        const { model } = mockJev((options) => ({
            choice: "src/compiler",
            probabilities: distribution(options, "src/compiler", 0.92),
            confidence: 0.88,
        }));
        const deps = makeDeps(root, { model, prompt: async () => { throw new Error("must not prompt"); } });

        const result = await run(["comp"], deps);

        expect(result.stdout).toBe(join(root, "src/compiler"));
        expect(deps.logs.join("\n")).toContain("probability 92% · confidence 88%");
        expect(loadHistory(deps.historyFile)[0]?.source).toBe("auto");
    });

    test("low certainty asks, and the user can overrule the model", async () => {
        const root = makeTree(TREE);
        const { model } = mockJev((options) => ({
            choice: "src/compiler",
            probabilities: { ...distribution(options, "src/compiler", 0.5), "src/components": 0.45, [NONE_OF_THE_ABOVE]: 0.05 },
            confidence: 0.3,
        }));
        const deps = makeDeps(root, { model, interactive: true, prompt: async () => "2" });

        const result = await run(["comp"], deps);

        expect(result.stdout).toBe(join(root, "src/components"));
        expect(loadHistory(deps.historyFile)[0]).toMatchObject({ source: "confirmed", modelChoiceAccepted: false });
    });

    test("low certainty without a terminal lists options and does not navigate", async () => {
        const root = makeTree(TREE);
        const { model } = mockJev((options) => ({
            choice: "src/compiler",
            probabilities: distribution(options, "src/compiler", 0.4),
            confidence: 0.2,
        }));
        const deps = makeDeps(root, { model });

        const result = await run(["comp"], deps);

        expect(result).toEqual({ exitCode: 1, stdout: "" });
        expect(deps.logs.join("\n")).toContain("src/compiler");
        expect(loadHistory(deps.historyFile)).toHaveLength(0);
    });
});

describe("gating end to end", () => {
    test.each([
        ["no distribution", { choice: "src/compiler" }],
        ["no confidence", { choice: "src/compiler", p: 0.99 }],
    ] as const)("%s never auto-navigates through the real SDK call", async (_name, answer) => {
        const root = makeTree(TREE);
        const { model } = mockJev((options) => ({
            choice: answer.choice,
            probabilities: "p" in answer ? distribution(options, answer.choice, answer.p) : undefined,
        }));

        const result = await run(["comp"], makeDeps(root, { model }));

        expect(result).toEqual({ exitCode: 1, stdout: "" });
    });

    test("when the model abstains, a bare Enter cancels instead of picking a 1% option", async () => {
        const root = makeTree(TREE);
        const { model } = mockJev((options) => ({
            choice: NONE_OF_THE_ABOVE,
            probabilities: distribution(options, NONE_OF_THE_ABOVE, 0.98),
            confidence: 0.95,
        }));
        const deps = makeDeps(root, { model, interactive: true, prompt: async () => "" });

        expect(await run(["comp"], deps)).toEqual({ exitCode: 1, stdout: "" });

        // An explicit pick still works, and is not scored as a wrong model answer.
        deps.prompt = async () => "1";
        expect((await run(["comp"], deps)).exitCode).toBe(0);
        expect(loadHistory(deps.historyFile)[0]?.modelChoiceAccepted).toBeUndefined();
    });

    test("a directory named __proto__ is still offered to the model", async () => {
        const root = makeTree(["__proto__", "proto2"]);
        const { model, calls } = mockJev(() => ({ choice: NONE_OF_THE_ABOVE }));

        await run(["proto"], makeDeps(root, { model }));

        const question = calls[0]!.questions.target_directory!;
        expect(Object.keys(question.criteria as object).sort()).toEqual(["./__proto__", NONE_OF_THE_ABOVE, "proto2"].sort());
    });
});

describe("real prompt", () => {
    const ask = async (typed: string | null) => {
        const input = new PassThrough();
        const answer = promptOn(input, new PassThrough(), "Go to: ");
        if (typed === null) input.end();
        else input.write(typed);
        return answer;
    };

    test("a typed answer is returned, not replaced by the close handler's cancel", async () => {
        expect(await ask("2\n")).toBe("2");
        expect(await ask("\n")).toBe("");
    });

    test("end of input without an answer cancels", async () => {
        expect(await ask(null)).toBe("q");
    });
});

describe("error handling", () => {
    test("model failure without a terminal does not navigate", async () => {
        const root = makeTree(TREE);
        const { model } = mockJev(() => { throw new Error("gateway timeout"); });

        expect(await run(["doc"], makeDeps(root, { model }))).toEqual({ exitCode: 1, stdout: "" });
    });

    test("model failure falls back to the local ranking and never auto-navigates", async () => {
        const root = makeTree(TREE);
        const { model } = mockJev(() => { throw new Error("gateway timeout"); });
        const deps = makeDeps(root, { model, interactive: true, prompt: async () => "" });

        const result = await run(["doc"], deps);

        expect(deps.logs.join("\n")).toContain("model unavailable — gateway timeout");
        expect(result.stdout).toBe(join(root, "docs"));
        expect(loadHistory(deps.historyFile)[0]?.source).toBe("fallback");
    });

    test("no candidates: clear message, no model call", async () => {
        const root = makeTree(TREE);
        const { model, calls } = mockJev(() => ({ choice: NONE_OF_THE_ABOVE }));
        const deps = makeDeps(root, { model });

        const result = await run(["zzzqqq"], deps);

        expect(result.exitCode).toBe(1);
        expect(calls).toHaveLength(0);
        expect(deps.logs.some((line) => line.includes('no directory matching "zzzqqq"'))).toBe(true);
    });
});

describe("tab completion", () => {
    test.each(["zsh", "bash"])("%s completion selects an indexed external path exactly", async (shell) => {
        const root = makeTree(["home/.config/mise", "away/a/b/c/d"]);
        const cwd = join(root, "away/a/b/c/d");
        const init = (await run(["init", shell], makeDeps(root))).stdout;
        const completion = shell === "bash"
            ? 'COMP_WORDS=(jd mise); COMP_CWORD=1; _jd; selected="${COMPREPLY[0]}"'
            : 'compadd() { selected="${argv[-1]}"; }; words=(jd mise); CURRENT=2; _jd';
        const proc = Bun.spawnSync([shell, "-c", `${init}\ncd '${cwd}'\n${completion}\njd "$selected" && pwd`], {
            env: { ...process.env, JD_HISTORY_FILE: join(root, "history.json"),
                HOME: join(root, "home"), JD_INDEX_ROOT: join(root, "home"), JD_INDEX_FILE: join(root, "index.json"),
                AI_GATEWAY_API_KEY: "", TYPESAFE_AI_API_KEY: "", VERCEL_OIDC_TOKEN: "" },
        });
        expect(proc.exitCode).toBe(0);
        expect(proc.stdout.toString().trim()).toBe(join(root, "home/.config/mise"));
        expect(proc.stderr.toString()).toContain("exact match");
        expect(proc.stderr.toString()).toContain("~/.config/mise");
    });
    test("lists matching directories locally, one per line", async () => {
        const root = makeTree(TREE);
        const { model, calls } = mockJev(() => ({ choice: NONE_OF_THE_ABOVE }));

        const result = await run(["--complete", "api"], makeDeps(root, { model }));

        expect(result.stdout.split("\n").sort()).toEqual(["packages/api-client", "packages/api-server"]);
        expect(calls).toHaveLength(0);
    });

    test("init prints a shell function and a completion hook", async () => {
        const zsh = await run(["init", "zsh"], makeDeps(makeTree([])));
        expect(zsh.stdout).toContain("jd() {");
        expect(zsh.stdout).toContain("compdef _jd jd");
        const bash = await run(["init", "bash"], makeDeps(makeTree([])));
        expect(bash.stdout).toContain("complete -o filenames -F _jd jd");
        expect((await run(["init", "fish"], makeDeps(makeTree([])))).exitCode).toBe(2);
    });

    test.each(["zsh", "bash"])("the generated %s function really changes directory, stdout stays clean", async (shell) => {
        const root = makeTree(["my dir/inner"]);
        const init = (await run(["init", shell], makeDeps(root))).stdout;
        const script = `${init}\ncd '${root}' && jd 'my dir' 2>/dev/null && pwd`;
        const proc = Bun.spawnSync([shell, "-c", script], {
            env: { ...process.env, JD_HISTORY_FILE: join(root, "h.json"), JD_INDEX_ROOT: root,
                JD_INDEX_FILE: join(root, "index.json"), AI_GATEWAY_API_KEY: "", TYPESAFE_AI_API_KEY: "" },
        });
        expect(proc.stdout.toString().trim()).toBe(join(root, "my dir"));
    });
});
