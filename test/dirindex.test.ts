import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { allowedIndexPath, buildIndex, indexedDirectories, indexOptions, loadIndex, saveIndex } from "../src/dirindex";
import { gatherCandidates, matchKind, MAX_CANDIDATES } from "../src/candidates";
import { run } from "../src/index";
import { makeDeps, mockJev } from "./helpers";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "jd-index-"));
    const options = { ...indexOptions(), root: join(root, "home"), file: join(root, "index.json"), budgetMs: 2000 };
    mkdirSync(options.root);
    return { root, options, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const names = fc.array(fc.constantFrom("alpha", "beta", ".config", "mise", "node_modules", ".git", ".cache", "Library", ".bun", "install", ".cargo", "registry"), { minLength: 1, maxLength: 7 });

describe("directory index", () => {
    test("bounded traversal, hidden directories, symlink cycles, round-trip, and stale refresh", () => {
        const f = fixture();
        try {
            for (const path of [".config/mise", ".bun/install/junk", ".cargo/registry/junk", "Library/anything", "node_modules/junk", "a/b/c/d/e/f"])
                mkdirSync(join(f.options.root, path), { recursive: true });
            symlinkSync(f.options.root, join(f.options.root, "cycle"));
            const index = buildIndex(f.options);
            expect(index.paths).toContain(join(f.options.root, ".config/mise"));
            expect(index.paths).toContain(join(f.options.root, "cycle"));
            expect(index.paths.every((p) => allowedIndexPath(f.options.root, p))).toBe(true);
            expect(index.paths.some((p) => p.includes("cycle/"))).toBe(false);
            expect(index.paths.every((p) => relative(f.options.root, p).split("/").length <= 5)).toBe(true);
            saveIndex(index, f.options.file);
            expect(loadIndex(f.options)).toEqual(index);
            let refreshed = 0;
            saveIndex({ ...index, createdAt: 0 }, f.options.file);
            expect(indexedDirectories(f.options, () => {}, () => { refreshed++; })).toEqual(index.paths);
            expect(refreshed).toBe(1);
            expect(buildIndex({ ...f.options, maxEntries: 2 }).paths).toHaveLength(2);
            expect(buildIndex({ ...f.options, budgetMs: 0 }).paths).toHaveLength(0);
        } finally { f.cleanup(); }
    });

    test("stale lookup starts a real detached refresh and returns the old snapshot", async () => {
        const f = fixture();
        try {
            mkdirSync(join(f.options.root, ".config/mise"), { recursive: true });
            saveIndex({ version: 1, root: f.options.root, createdAt: 0, paths: [] }, f.options.file);
            expect(indexedDirectories(f.options, () => {})).toEqual([]);
            const deadline = Date.now() + 4000;
            while (loadIndex(f.options)?.createdAt === 0 && Date.now() < deadline) await Bun.sleep(20);
            expect(loadIndex(f.options)?.paths).toContain(join(f.options.root, ".config/mise"));
        } finally { f.cleanup(); }
    });

    test("concurrent CLI refreshes publish complete snapshots without temporary files", async () => {
        const f = fixture();
        try {
            mkdirSync(join(f.options.root, ".config/mise"), { recursive: true });
            const env = { ...process.env, JD_INDEX_ROOT: f.options.root, JD_INDEX_FILE: f.options.file,
                JD_HISTORY_FILE: join(f.root, "history.json"), AI_GATEWAY_API_KEY: "", TYPESAFE_AI_API_KEY: "", VERCEL_OIDC_TOKEN: "" };
            const children = [0, 1].map(() => Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "--reindex"], {
                env, stdout: "pipe", stderr: "pipe",
            }));
            expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
            expect(loadIndex(f.options)?.paths).toContain(join(f.options.root, ".config/mise"));
            expect(readdirSync(f.root).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
            for (const child of children) expect(await new Response(child.stdout).text()).toBe("");
        } finally { f.cleanup(); }
    });

    test("first build reports once; corrupt files recover; explicit rebuild uses stderr", async () => {
        const f = fixture();
        try {
            const logs: string[] = [];
            indexedDirectories(f.options, (s) => logs.push(s));
            indexedDirectories(f.options, (s) => logs.push(s));
            expect(logs.filter((s) => s.includes("first time"))).toHaveLength(1);
            writeFileSync(f.options.file, "broken");
            expect(loadIndex(f.options)).toBeNull();
            const deps = makeDeps(f.root, { directoryIndex: f.options });
            expect(await run(["index"], deps)).toEqual({ exitCode: 0, stdout: "" });
            expect(deps.logs[0]).toContain("indexed 0 directories");
        } finally { f.cleanup(); }
    });

    test("hidden names and path fragments complete without a model; deleted entries vanish", async () => {
        const f = fixture();
        try {
            const cwd = join(f.root, "away/a/b/c/d");
            mkdirSync(cwd, { recursive: true });
            mkdirSync(join(f.options.root, ".config/mise"), { recursive: true });
            const { model, calls } = mockJev(() => { throw new Error("must not call model"); });
            const deps = makeDeps(cwd, { directoryIndex: f.options, model });
            for (const query of ["mise", "config/mise", ".config/mi", ".config"]) {
                const result = await run(["--complete", query], deps);
                expect(result.stdout).toContain(join(f.options.root, query === ".config" ? ".config" : ".config/mise"));
            }
            const exact = await run([join(f.options.root, ".config/mise")], deps);
            expect(exact.exitCode).toBe(0);
            expect(calls).toHaveLength(0);
            rmSync(join(f.options.root, ".config/mise"), { recursive: true });
            expect((await run(["--complete", "mise"], deps)).stdout).toBe("");
        } finally { f.cleanup(); }
    });

    test("large global matches stay below the model option limit and history wins ties", async () => {
        const f = fixture();
        try {
            const cwd = join(f.root, "away/a/b/c/d");
            mkdirSync(cwd, { recursive: true });
            for (let i = 0; i < 260; i++) mkdirSync(join(f.options.root, String(i), "mise"), { recursive: true });
            const index = buildIndex(f.options);
            saveIndex(index, f.options.file);
            const favorite = join(f.options.root, "259/mise");
            const ranked = gatherCandidates("mise", cwd, new Map([[favorite, {
                visits: 5, frecency: 3, queryHits: 0, lastVisited: Date.now(),
            }]]), index.paths);
            expect(ranked).toHaveLength(MAX_CANDIDATES);
            expect(ranked[0]?.path).toBe(favorite);
            const { model, calls } = mockJev((options) => {
                const question = options.questions.target_directory;
                if (question?.type !== "choice") throw new Error("expected choice");
                expect(Object.keys(question.criteria)).toHaveLength(MAX_CANDIDATES + 1);
                return { choice: "none_of_the_above" };
            });
            await run(["mise"], makeDeps(cwd, { directoryIndex: f.options, model }));
            expect(calls).toHaveLength(1);
        } finally { f.cleanup(); }
    });

    test("property: scans stay contained, exclude ignored ancestors, and round-trip", () => {
        fc.assert(fc.property(fc.array(names, { maxLength: 12 }), (paths) => {
            const f = fixture();
            try {
                for (const parts of paths) mkdirSync(join(f.options.root, ...parts), { recursive: true });
                const index = buildIndex(f.options);
                for (const path of index.paths) {
                    const rel = relative(f.options.root, path);
                    expect(rel.startsWith("..")).toBe(false);
                    expect(rel.split("/").length).toBeLessThanOrEqual(5);
                    expect(rel.split("/").some((p) => ["node_modules", ".git", ".cache", "Library"].includes(p))).toBe(false);
                    expect(rel).not.toContain(".bun/install");
                    expect(rel).not.toContain(".cargo/registry");
                }
                saveIndex(index, f.options.file);
                expect(loadIndex(f.options)).toEqual(index);
            } finally { f.cleanup(); }
        }), { numRuns: 35 });
    });

    test("property: indexed matches are stable, live, matching, capped, and behind equal local names", () => {
        fc.assert(fc.property(fc.array(fc.constantFrom("mise", "misery", "config", "api"), { minLength: 1, maxLength: 25 }), fc.constantFrom("mi", "config", "api"), (names, query) => {
            const f = fixture();
            try {
                const cwd = join(f.root, "away/a/b/c/d");
                mkdirSync(cwd, { recursive: true });
                for (const [i, name] of names.entries()) mkdirSync(join(f.options.root, String(i), name), { recursive: true });
                mkdirSync(join(cwd, "mise"));
                const index = buildIndex(f.options);
                const result = gatherCandidates(query, cwd, new Map(), index.paths);
                expect(result).toEqual(gatherCandidates(query, cwd, new Map(), [...index.paths].reverse()));
                expect(result.length).toBeLessThanOrEqual(MAX_CANDIDATES);
                for (const candidate of result) {
                    expect(matchKind(query, candidate.path, cwd)).not.toBeNull();
                    if (candidate.relation === "elsewhere") expect(index.paths).toContain(candidate.path);
                }
                if (query === "mi") expect(result[0]?.path).toBe(join(cwd, "mise"));
            } finally { f.cleanup(); }
        }), { numRuns: 35 });
    });
});
