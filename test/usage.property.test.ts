import { expect, test } from "bun:test";
import fc from "fast-check";
import { appendUsage, compact, DAY, loadUsage, totals, type UsageRecord } from "../src/usage";
import { makeTree } from "./helpers";
import { join } from "node:path";

const token = fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined });
const record = fc.record({ timestamp: fc.integer({ min: 1, max: 90 * DAY }), inputTokens: token, outputTokens: token,
    totalTokens: token, label: fc.constant("mock"), candidates: fc.integer({ min: 1, max: 200 }), route: fc.constant("auto") });
const records = fc.array(record, { maxLength: 100 });
const rates = { input: 0.4, output: 0.2 };

test("window totals equal independent record sums; missing tokens stay finite", () => {
    fc.assert(fc.property(records, fc.integer({ min: 0, max: 89 }), (entries, day) => {
        const end = 91 * DAY;
        const selected = entries.filter(r => r.timestamp >= day * DAY && r.timestamp < end);
        const sum = totals({ records: entries, daily: [] }, day * DAY, end, rates);
        expect(sum.calls).toBe(selected.length);
        expect(sum.inputTokens).toBe(selected.reduce((n, r) => n + (r.inputTokens ?? 0), 0));
        expect(sum.outputTokens).toBe(selected.reduce((n, r) => n + (r.outputTokens ?? 0), 0));
        expect(Object.values(sum).every(Number.isFinite)).toBe(true);
    }));
});

test("all-time >= thirty days >= seven days >= today for every counter", () => {
    fc.assert(fc.property(records, entries => {
        const results = [0, 61, 84, 90].map(day => totals({ records: entries, daily: [] }, day * DAY, 91 * DAY, rates));
        for (let i = 1; i < results.length; i++) {
            for (const key of ["calls", "inputTokens", "outputTokens", "totalTokens", "unknownTokens", "estimatedCost"] as const) {
                expect(results[i - 1]![key]).toBeGreaterThanOrEqual(results[i]![key]);
            }
        }
    }));
});

test("daily compaction preserves all UTC reporting totals and is idempotent", () => {
    fc.assert(fc.property(records, fc.integer({ min: 0, max: 89 }), fc.integer({ min: 0, max: 100 }), (entries, day, limit) => {
        const ledger = { records: entries, daily: [] };
        const compressed = compact(ledger, limit);
        expect(compressed.records.length).toBeLessThanOrEqual(limit);
        expect(totals(compressed, day * DAY, 91 * DAY, rates)).toEqual(totals(ledger, day * DAY, 91 * DAY, rates));
        expect(totals(compressed, 0, 91 * DAY, rates)).toEqual(totals(ledger, 0, 91 * DAY, rates));
        expect(compact(compressed, limit)).toEqual(compressed);
    }));
});

test("cost is additive, scales with price, and is zero for zero price", () => {
    fc.assert(fc.property(records, records, fc.integer({ min: 0, max: 100 }), (a, b, factor) => {
        const cost = (entries: UsageRecord[], multiplier = 1) => totals({ records: entries, daily: [] }, 0, 91 * DAY,
            { input: rates.input * multiplier, output: rates.output * multiplier }).estimatedCost;
        expect(cost([...a, ...b])).toBeCloseTo(cost(a) + cost(b), 10);
        expect(cost(a, factor)).toBeCloseTo(cost(a) * factor, 10);
        expect(cost(a, 0)).toBe(0);
    }));
});

test("append and load round-trip arbitrary optional usage values", async () => {
    const root = makeTree([]);
    let index = 0;
    await fc.assert(fc.asyncProperty(record, async entry => {
        const file = join(root, `${index++}.json`);
        await appendUsage(file, entry);
        expect(await loadUsage(file)).toEqual(JSON.parse(JSON.stringify({ records: [entry], daily: [] })));
    }), { numRuns: 30 });
});
