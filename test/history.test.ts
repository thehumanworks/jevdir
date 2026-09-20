import { describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gatherCandidates, matchKind } from "../src/candidates";
import {
    analyzeHistory,
    loadHistory,
    parseShellNavigation,
    recordNavigation,
    summarizeUsage,
    type HistoryEntry,
} from "../src/history";
import { makeTree } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const entry = (path: string, query: string, daysAgo: number, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
    query,
    path,
    cwd: "/",
    timestamp: NOW - daysAgo * DAY,
    source: "auto",
    ...extra,
});

describe("history file", () => {
    test("missing and corrupt files read as empty history", () => {
        const root = makeTree([]);
        expect(loadHistory(join(root, "nope.json"))).toEqual([]);
        writeFileSync(join(root, "bad.json"), "{not json");
        expect(loadHistory(join(root, "bad.json"))).toEqual([]);
    });

    test("records round-trip and the file is capped at 500 entries", () => {
        const file = join(makeTree([]), "h.json");
        for (let i = 0; i < 503; i++) recordNavigation(entry(`/d${i}`, "d", 0), file);
        const entries = loadHistory(file);
        expect(entries).toHaveLength(500);
        expect(entries[0]?.path).toBe("/d3");
    });
});

describe("history analysis", () => {
    test("counts visits, query hits, and decays old visits by half per week", () => {
        const stats = analyzeHistory(
            [entry("/a", "api", 0), entry("/a", "API", 7), entry("/a", "other", 14), entry("/b", "api", 0)],
            "api",
            NOW,
        );
        expect(stats.get("/a")).toEqual({ visits: 3, queryHits: 2, lastVisited: NOW, frecency: 1 + 0.5 + 0.25 });
        expect(stats.get("/b")?.visits).toBe(1);
    });

    test("empty history yields no stats", () => {
        expect(analyzeHistory([], "x", NOW).size).toBe(0);
    });

    test("frequently visited directories rank above equal name matches", () => {
        const root = makeTree(["packages/api-server", "packages/api-client"]);
        const client = join(root, "packages/api-client");
        const history = analyzeHistory([entry(client, "api", 1), entry(client, "api", 2)], "api", NOW);

        const candidates = gatherCandidates("api", root, history);

        expect(candidates.map((c) => c.display)).toEqual(["packages/api-client", "packages/api-server"]);
        expect(candidates[0]?.stats?.visits).toBe(2);
    });

    test("a directory outside cwd becomes a candidate when this query led there before", () => {
        const elsewhere = makeTree(["work/backend"]);
        const root = makeTree(["docs"]);
        const target = join(elsewhere, "work/backend");
        const history = analyzeHistory([entry(target, "srv", 1)], "srv", NOW);

        const candidates = gatherCandidates("srv", root, history);

        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({ path: target, match: "history", relation: "elsewhere" });
    });

    test("usage summary reports how often the model's top pick was accepted", () => {
        const summary = summarizeUsage([
            entry("/a", "a", 0, { source: "exact" }),
            entry("/a", "a", 0, { source: "auto" }),
            entry("/a", "a", 0, { source: "confirmed", modelChoiceAccepted: true }),
            entry("/b", "a", 0, { source: "confirmed", modelChoiceAccepted: false }),
        ]);
        expect(summary.bySource).toEqual({ exact: 1, auto: 1, confirmed: 2, fallback: 0 });
        expect(summary.confirmedTopPickRate).toBe(0.5);
    });
});

describe("shell history", () => {
    test("keeps only navigation commands, in both zsh and plain formats", () => {
        const raw = [": 1700000000:0;cd src", "export TOKEN=secret", "jd api", ": 1700000001:0;git push", "cdk deploy"].join("\n");
        expect(parseShellNavigation(raw)).toEqual(["cd src", "jd api"]);
    });
});

describe("shell history secrets", () => {
    test("a line with any shell syntax is dropped whole, not trimmed", () => {
        const raw = [
            "cd infra && export AWS_SECRET_ACCESS_KEY=abc123",
            ": 1700000000:0;cd /tmp; curl -H 'Authorization: Bearer sk-live-xyz' https://x",
            "jd api # token=hunter2",
            "cd $(cat ~/.secret)",
            "cd logs | tee out",
            'cd docs > >(curl -H "Authorization: Bearer sk-live-xyz" https://example.invalid)',
            "cd <(echo hunter2)",
            "jd api token=hunter2",
            "cd 'my secret dir'",
            "cd ~/work/api-server",
            "cd -",
            "jd my project",
        ].join("\n");
        expect(parseShellNavigation(raw)).toEqual(["cd ~/work/api-server", "cd -", "jd my project"]);
    });
});

describe("name matching", () => {
    test.each([
        ["docs", "/r/docs", "exact-name"],
        ["comp", "/r/src/components", "prefix"],
        ["server", "/r/api-server", "substring"],
        ["src/comp", "/r/src/components", "path"],
        ["cmp", "/r/components", "fuzzy"],
        ["zzz", "/r/components", null],
        ["~/dev", `${homedir()}/development`, "path"],
    ] as const)("%p vs %p → %p", (query, path, expected) => {
        expect(matchKind(query, path)).toBe(expected);
    });

    test("./ and ../ partial paths are anchored to the current directory", () => {
        expect(matchKind("./src/comp", "/r/src/components", "/r")).toBe("path");
        expect(matchKind("../doc", "/r/docs", "/r/src")).toBe("path");
        expect(matchKind("./src/comp", "/other/src/components", "/r")).toBeNull();
    });

    test("a symlink to a directory is a candidate and is not descended into", () => {
        const root = makeTree(["actual/deep-api"]);
        symlinkSync(join(root, "actual"), join(root, "api-link"));

        const found = gatherCandidates("api", root, new Map()).map((c) => c.display).sort();

        expect(found).toEqual(["actual/deep-api", "api-link"]);
    });
});
