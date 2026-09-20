import { expect, test } from "bun:test";
import fc from "fast-check";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "../src/index";
import { loadHistory } from "../src/history";
import { distribution, hostileString, makeDeps, makeTree, mockJev, propertyParameters } from "./helpers";

const name = hostileString.map((s) => "jdprop-" + s.replaceAll(/[\/\0]/g, "_").slice(0, 35));
const cleanup = (cwd: string) => rmSync(resolve(cwd, "../../../.."), { recursive: true, force: true });

function checkOutput(result: { exitCode: number; stdout: string }) {
    if (result.exitCode !== 0) expect(result.stdout).toBe("");
    if (result.stdout) {
        expect(isAbsolute(result.stdout)).toBe(true);
        expect(result.stdout).not.toContain("\n");
        expect(statSync(result.stdout).isDirectory()).toBe(true);
    }
}

test("generated exact directory trees bypass the model and keep stdout path-only", async () => {
    await fc.assert(fc.asyncProperty(fc.array(name, { minLength: 1, maxLength: 3 }), async (parts) => {
        const relative = join(...parts);
        const cwd = makeTree([relative]);
        try {
            const { model, calls } = mockJev(() => { throw new Error("exact matching must not evaluate"); });
            const deps = makeDeps(cwd, { model });
            const result = await run(["./" + relative], deps);
            checkOutput(result);
            expect(calls).toHaveLength(0);
            if (!relative.includes("\n")) {
                expect(result.stdout).toBe(join(cwd, relative));
                expect(loadHistory(deps.historyFile)).toHaveLength(1);
            } else {
                expect(loadHistory(deps.historyFile)).toEqual([]);
            }
        } finally {
            cleanup(cwd);
        }
    }), propertyParameters(20));
});

test("noninteractive low-certainty predictions never navigate or change history", async () => {
    await fc.assert(fc.asyncProperty(fc.array(name, { minLength: 2, maxLength: 4 }), fc.constantFrom("probability", "confidence", "missing"), fc.double({ min: 0.5, max: 0.7 - Number.EPSILON, noNaN: true }), fc.double({ min: 0, max: 0.6 - Number.EPSILON, noNaN: true }), fc.boolean(), async (names, mode, lowP, lowC, existing) => {
        const cwd = makeTree(names.map((n, i) => `branch-${i}/${n}`));
        try {
            const { model, calls } = mockJev((options) => {
                const question = options.questions.target_directory;
                if (question?.type !== "choice") throw new Error("expected choice");
                const choice = Object.keys(question.criteria).find((key) => key !== "none_of_the_above")!;
                return { choice, probabilities: mode === "missing" ? undefined : distribution(options, choice, mode === "probability" ? lowP : 0.9), confidence: mode === "confidence" ? lowC : 0.9 };
            });
            const deps = makeDeps(cwd, { model });
            if (existing) writeFileSync(deps.historyFile, '{"entries":[]}');
            const before = existing ? readFileSync(deps.historyFile, "utf8") : null;
            const result = await run(["jdprop"], deps);
            checkOutput(result);
            expect(calls).toHaveLength(1);
            expect(result.exitCode).not.toBe(0);
            expect(result.stdout).toBe("");
            expect(loadHistory(deps.historyFile)).toEqual([]);
            expect(existsSync(deps.historyFile) ? readFileSync(deps.historyFile, "utf8") : null).toBe(before);
        } finally {
            cleanup(cwd);
        }
    }), propertyParameters(20));
});

test("confident mock predictions emit only an existing directory", async () => {
    await fc.assert(fc.asyncProperty(name, async (generated) => {
        const cwd = makeTree([`branch/${generated}`]);
        try {
            const { model, calls } = mockJev((options) => {
                const question = options.questions.target_directory;
                if (question?.type !== "choice") throw new Error("expected choice");
                const choice = Object.keys(question.criteria).find((key) => key !== "none_of_the_above")!;
                return { choice, probabilities: distribution(options, choice, 0.9), confidence: 0.9 };
            });
            const deps = makeDeps(cwd, { model });
            const result = await run(["jdprop"], deps);
            checkOutput(result);
            expect(calls).toHaveLength(1);
            expect(loadHistory(deps.historyFile)).toHaveLength(result.stdout ? 1 : 0);
        } finally {
            cleanup(cwd);
        }
    }), propertyParameters(15));
});

test("init quotes generated install paths byte-for-byte through a real sh", async () => {
    await fc.assert(fc.asyncProperty(name, async (generated) => {
        const cwd = makeTree([]);
        try {
            // Copy source beside a node_modules symlink so import.meta.path is a real hostile install path.
            const install = join(cwd, "install ' $ ` space " + generated);
            mkdirSync(install);
            for (const file of ["index.ts", "history.ts", "choice.ts", "candidates.ts"]) {
                writeFileSync(join(install, file), readFileSync(join(import.meta.dir, "../src", file)));
            }
            symlinkSync(resolve(import.meta.dir, "../node_modules"), join(install, "node_modules"));
            const path = join(install, "index.ts");
            const init = spawnSync(process.execPath, [path, "init", "bash"], {
                encoding: "utf8",
                env: { ...process.env, JD_HISTORY_FILE: join(cwd, "history.json"), AI_GATEWAY_API_KEY: "", TYPESAFE_AI_API_KEY: "", VERCEL_OIDC_TOKEN: "" },
            });
            expect(init.status).toBe(0);
            const start = init.stdout.indexOf("command bun ") + "command bun ".length;
            const end = init.stdout.indexOf(' "$@"', start);
            expect(end).toBeGreaterThan(start);
            const quoted = init.stdout.slice(start, end);
            const printed = spawnSync("sh", ["-c", `printf %s ${quoted}`]);
            expect(printed.status).toBe(0);
            expect(printed.stdout).toEqual(Buffer.from(path));
        } finally {
            cleanup(cwd);
        }
    }), propertyParameters(6));
});

test("newline in jdprop-a\\nb/jdprop- cannot enter stdout or history (shrunk regression)", async () => {
    const cwd = makeTree(["jdprop-a\nb/jdprop-"]);
    try {
        const { model, calls } = mockJev(() => { throw new Error("must bypass model"); });
        const deps = makeDeps(cwd, { model });
        expect(await run(["./jdprop-a\nb/jdprop-"], deps)).toEqual({ exitCode: 1, stdout: "" });
        expect(calls).toHaveLength(0);
        expect(existsSync(deps.historyFile)).toBe(false);
    } finally {
        cleanup(cwd);
    }
});
