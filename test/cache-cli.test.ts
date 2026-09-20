import { expect, test } from "bun:test";
import fc from "fast-check";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { loadHistory, recordNavigation, summarizeUsage } from "../src/history";
import { run } from "../src/index";
import { makeDeps, makeTree, mockJev } from "./helpers";

function setup() {
    const root = makeTree(["components", "elsewhere"]);
    const { model, calls } = mockJev(() => ({ choice: "none_of_the_above" }));
    const deps = makeDeps(root, { model });
    const path = join(root, "components");
    for (let i = 0; i < 3; i++) recordNavigation({ query: "comp", path, cwd: "/different/project", timestamp: deps.now(), source: "auto" }, deps.historyFile);
    return { root, path, deps, calls };
}

test("cache bypasses candidate gathering, shell history and model; records and reports cached usage", async () => {
    const { root, path, deps, calls } = setup();
    // A missing cwd would make directory discovery unhelpful; cache is independent of cwd.
    deps.cwd = join(root, "missing");
    deps.recentNavigation = () => { throw new Error("must not read shell history"); };
    expect(await run(["comp"], deps)).toEqual({ exitCode: 0, stdout: path });
    expect(calls).toHaveLength(0);
    expect(deps.logs.some((line) => line.includes("(cached · 3 recent uses)"))).toBe(true);
    expect(loadHistory(deps.historyFile).at(-1)?.source).toBe("cached");
    expect(summarizeUsage(loadHistory(deps.historyFile)).bySource.cached).toBe(1);
    await run(["--stats"], deps);
    expect(deps.logs.some((line) => line.includes("cached (no model call):     1"))).toBe(true);
});

test.each([undefined, "", "0", "1", "false"])("injected JD_NO_CACHE=%p", async (noCache) => {
    const { deps, calls } = setup();
    deps.noCache = noCache;
    await run(["comp"], deps);
    expect(calls.length).toBe(noCache && noCache !== "0" ? 1 : 0);
});

test("exact match still wins and cached navigations do not refresh evidence", async () => {
    const { path, deps, calls } = setup();
    await run([path], deps);
    expect(loadHistory(deps.historyFile).at(-1)?.source).toBe("exact");
    await run(["comp"], deps);
    const now = deps.now();
    deps.now = () => now + 8 * 86_400_000;
    await run(["comp"], deps);
    expect(calls).toHaveLength(1);
});

test.each(["deleted", "file"])("%s cached target is a miss", async (kind) => {
    const { path, deps, calls } = setup();
    rmSync(path, { recursive: true });
    if (kind === "file") writeFileSync(path, "not a directory");
    expect((await run(["comp"], deps)).stdout).toBe("");
    expect(loadHistory(deps.historyFile)).toHaveLength(3);
    expect(calls).toHaveLength(0);
});

test("property: false existence predicate never serves a cached navigation", async () => {
    const { deps } = setup();
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 86_400_000 }), async (elapsed) => {
        const result = await run(["comp"], { ...deps, now: () => 1_800_000_000_000 + elapsed, isDirectory: () => false });
        expect(result.stdout).toBe("");
        expect(loadHistory(deps.historyFile).some((entry) => entry.source === "cached")).toBe(false);
    }), { numRuns: 20 });
});
