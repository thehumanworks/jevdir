import { describe, expect, test } from "bun:test";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { appendUsage, compact, DAY, formatUsage, loadUsage, prices, recordUsage, totals, usageReport, type UsageRecord, type SpendFetcher } from "../src/usage";
import { run } from "../src/index";
import { recordNavigation } from "../src/history";
import { makeDeps, makeTree, mockJev, distribution } from "./helpers";

const now = 1_800_000_000_000;
const record: UsageRecord = { timestamp: now, label: "mock jev", modelId: "jev", candidates: 2, route: "auto", inputTokens: 100, outputTokens: 20 };
const fetcher: SpendFetcher = async () => ({ results: [{ totalCost: 2, requestCount: 3, inputTokens: 1000, outputTokens: 200 }], credits: { balance: "8", totalUsed: "2" } });

describe("usage ledger", () => {
    test("missing, corrupt, and invalid files are empty; appends round-trip", async () => {
        const file = join(makeTree([]), "usage.json");
        expect(await loadUsage(file)).toEqual({ records: [], daily: [] });
        for (const content of ["oops", "null", '{"records":[{}],"daily":[]}', '{"records":[],"daily":[{}]}']) {
            writeFileSync(file, content);
            expect(await loadUsage(file)).toEqual({ records: [], daily: [] });
        }
        await appendUsage(file, record);
        expect((await loadUsage(file)).records).toEqual([record]);
        expect(existsSync(`${file}.lock`)).toBe(false);
    });
    test("write errors warn once without throwing", async () => {
        const lines: string[] = [];
        await recordUsage(join(makeTree([]), "missing", "usage"), record, line => lines.push(line));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toStartWith("jd: could not save usage");
    });
    test("bounded raw records retain older daily totals", () => {
        const records = Array.from({ length: 700 }, (_, i) => ({ ...record, timestamp: now - i * DAY }));
        const ledger = compact({ records, daily: [] });
        expect(ledger.records).toHaveLength(500);
        expect(ledger.daily).toHaveLength(200);
        expect(totals(ledger, 0, now + DAY, prices({})).calls).toBe(700);
    });
    test("rates validate env overrides and preserve zero", () => {
        expect(prices({})).toEqual({ input: 0.4, output: 0 });
        expect(prices({ JD_PRICE_INPUT_PER_MTOK: "0", JD_PRICE_OUTPUT_PER_MTOK: "2" })).toEqual({ input: 0, output: 2 });
        expect(prices({ JD_PRICE_INPUT_PER_MTOK: "NaN", JD_PRICE_OUTPUT_PER_MTOK: "-1" })).toEqual(prices({}));
    });
});

describe("usage report", () => {
    test("uses injected billing by window and counts exact bypasses from retained history", async () => {
        const deps = makeDeps(makeTree([]));
        await appendUsage(deps.usageFile!, record);
        recordNavigation({ query: "x", path: deps.cwd, cwd: deps.cwd, timestamp: now, source: "exact" }, deps.historyFile);
        const requests: string[][] = [];
        const report = await usageReport({ file: deps.usageFile!, historyFile: deps.historyFile, now, env: {}, fetcher: async (start, end) => {
            requests.push([start, end]);
            return fetcher(start, end);
        } });
        expect(requests).toHaveLength(4);
        expect(requests[0]).toEqual([new Date(now).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)]);
        expect(requests[3]![0]).toBe("1970-01-01");
        expect(report.reports[0]).toMatchObject({ local: { calls: 1, inputTokens: 100, estimatedCost: 0.00004 }, noModelNavigations: 1, billed: { cost: 2, calls: 3 } });
        expect(report.credits?.balance).toBe("8");
        expect(formatUsage(report)).toContain("Gateway billed");
    });
    test("absent key, failure, and short timeout fall back to local data", async () => {
        const deps = makeDeps(makeTree([]));
        for (const source of [undefined, async () => { throw new Error("no network"); }, () => new Promise<never>(() => {})]) {
            const report = await usageReport({ file: deps.usageFile!, historyFile: deps.historyFile, now, env: {}, fetcher: source, timeoutMs: 5 });
            expect(report.credits).toBeNull();
            expect(report.note).toContain("using local estimates");
            expect(report.reports.every(r => r.billed === null)).toBe(true);
        }
    });
    test("human report is stderr; JSON is a single stdout object; shell bypass includes usage", async () => {
        const deps = makeDeps(makeTree([]), { spendFetcher: fetcher });
        expect((await run(["--usage"], deps)).stdout).toBe("");
        expect(deps.logs.join("\n")).toContain("local estimate");
        deps.logs.length = 0;
        const result = await run(["--usage", "--json"], deps);
        expect(JSON.parse(result.stdout).reports).toHaveLength(4);
        expect(deps.logs).toHaveLength(0);
        expect((await run(["init", "bash"], deps)).stdout).toContain("|--usage|");
    });
});

describe("navigation recording", () => {
    test("success records model tokens and route, exact match records no call", async () => {
        const cwd = makeTree(["components", "compiler"]);
        const { model } = mockJev(options => ({ choice: "components", confidence: 0.99,
            probabilities: distribution(options, "components", 0.99), usage: { inputTokens: 400, outputTokens: 10, totalTokens: 410 } }));
        const deps = makeDeps(cwd, { model });
        await run(["comp"], deps);
        expect((await loadUsage(deps.usageFile!)).records[0]).toMatchObject({ inputTokens: 400, outputTokens: 10, totalTokens: 410, route: "auto", candidates: 2 });
        await run(["components"], deps);
        expect((await loadUsage(deps.usageFile!)).records).toHaveLength(1);
    });
    test("failed or aborted model calls record unknown tokens once", async () => {
        for (const error of [new Error("failure"), new DOMException("timeout", "TimeoutError")]) {
            let calls = 0;
            const model = new Experimental_EvaluationMockModelV4({ doEvaluate: async () => { calls++; throw error; } });
            const deps = makeDeps(makeTree(["components"]), { model });
            await run(["comp"], deps);
            const ledger = await loadUsage(deps.usageFile!);
            expect(calls).toBe(1);
            expect(ledger.records[0]?.route).toBe("error");
            expect(totals(ledger, 0, now + DAY, prices({}))).toMatchObject({ calls: 1, unknownTokens: 1, estimatedCost: 0 });
        }
    });
    test("uncertain and abstaining results are recorded even when navigation is cancelled", async () => {
        for (const [choice, route] of [["components", "confirm"], ["none_of_the_above", "options"]]) {
            const { model } = mockJev(() => ({ choice: choice! }));
            const deps = makeDeps(makeTree(["components"]), { model });
            expect((await run(["comp"], deps)).exitCode).toBe(1);
            const ledger = await loadUsage(deps.usageFile!);
            expect(ledger.records[0]?.route).toBe(route);
            expect(totals(ledger, 0, now + DAY, prices({})).unknownTokens).toBe(1);
        }
    });
    test("ledger failure does not prevent navigation", async () => {
        const cwd = makeTree(["components"]);
        const { model } = mockJev(options => ({ choice: "components", confidence: 1, probabilities: distribution(options, "components", 1) }));
        const deps = makeDeps(cwd, { model, usageFile: join(cwd, "missing", "usage.json") });
        expect((await run(["comp"], deps)).exitCode).toBe(0);
        expect(deps.logs.filter(line => line.includes("could not save usage"))).toHaveLength(1);
    });
});
