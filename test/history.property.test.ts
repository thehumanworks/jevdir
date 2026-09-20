import { expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeHistory, loadHistory, parseShellNavigation, recordNavigation, summarizeUsage } from "../src/history";
import { hostileString, propertyParameters } from "./helpers";

const entry = fc.record({
    query: hostileString,
    path: fc.oneof(hostileString, fc.constant("shared")),
    cwd: hostileString,
    timestamp: fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }),
    source: fc.constantFrom("exact" as const, "auto" as const, "confirmed" as const, "fallback" as const),
    modelChoiceAccepted: fc.boolean(),
});

test("shell history is an ordered, bounded privacy allowlist", () => {
    fc.assert(fc.property(fc.array(fc.oneof(hostileString, fc.constantFrom("cd src", "jd ~", ": 123:0;pushd ../a"))), fc.integer({ min: 0, max: 30 }), (lines, limit) => {
        const raw = lines.join("\n");
        const result = parseShellNavigation(raw, limit);
        expect(result.length).toBeLessThanOrEqual(limit);
        let cursor = -1;
        const input = raw.split("\n").map((line) => line.replace(/^: \d+:\d+;/, "").trim());
        for (const command of result) {
            expect(command).toMatch(/^(cd|pushd|jd)(\s+[\w.\/~@+:,-]+)*$/);
            expect(command).not.toMatch(/[&|;<>$`()#'"=\\]/);
            cursor = input.indexOf(command, cursor + 1);
            expect(cursor).toBeGreaterThanOrEqual(0);
        }
    }), propertyParameters());
});

test("operator suffixes never leak even a navigation prefix", () => {
    fc.assert(fc.property(hostileString, fc.constantFrom("&", "|", ";", "<", ">", "$", "`", "(", ")", "#", "'", '"', "=", "\\"), (secret, operator) => {
        expect(parseShellNavigation(`jd before\ncd private ${operator} SECRET_${secret.replaceAll("\n", "_")}\ncd after`)).toEqual(["jd before", "cd after"]);
    }), propertyParameters());
});

test("history statistics conserve visits and decay independently of order", () => {
    fc.assert(fc.property(fc.array(entry, { maxLength: 40 }), hostileString, fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer(), (entries, query, delta, seed) => {
        const now = 1_800_000_000_000;
        const stats = analyzeHistory(entries, query, now);
        const later = analyzeHistory(entries, query, now + delta);
        const shuffled = fc.sample(fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }), { seed, numRuns: 1 })[0]!;
        const permuted = analyzeHistory(shuffled, query, now);
        expect([...stats.values()].reduce((sum, s) => sum + s.visits, 0)).toBe(entries.length);
        for (const [path, s] of stats) {
            expect(s.frecency).toBeGreaterThan(0);
            expect(s.frecency).toBeLessThanOrEqual(s.visits);
            expect(later.get(path)!.frecency).toBeLessThanOrEqual(s.frecency);
            expect(s.queryHits).toBeLessThanOrEqual(s.visits);
            expect(s.queryHits).toBe(entries.filter((e) => e.path === path && e.query.toLowerCase() === query.toLowerCase()).length);
            expect(permuted.get(path)).toEqual({ ...s, frecency: permuted.get(path)!.frecency });
            expect(permuted.get(path)!.frecency).toBeCloseTo(s.frecency, 10);
        }
        const summary = summarizeUsage(entries);
        expect(summary.total).toBe(entries.length);
        expect(Object.values(summary.bySource).reduce((a, b) => a + b, 0)).toBe(entries.length);
        expect(summarizeUsage(shuffled)).toEqual(summary);
        for (const [source, count] of Object.entries(summary.bySource)) {
            expect(count).toBe(entries.filter((e) => e.source === source).length);
        }
        const judged = entries.filter((e) => e.source === "confirmed");
        expect(summary.confirmedTopPickRate).toBe(judged.length ? judged.filter((e) => e.modelChoiceAccepted).length / judged.length : null);
    }), propertyParameters());
});

test("record/load round-trips hostile entries and caps the persisted tail", () => {
    fc.assert(fc.property(fc.array(entry, { minLength: 1, maxLength: 8 }), fc.integer({ min: 495, max: 505 }), (entries, count) => {
        const root = mkdtempSync(join(tmpdir(), "jd-property-history-"));
        try {
            const file = join(root, "history.json");
            const initial = Array.from({ length: count }, (_, i) => entries[i % entries.length]!);
            writeFileSync(file, JSON.stringify({ entries: initial }));
            const expected = [...initial];
            for (const e of entries) {
                recordNavigation(e, file);
                expected.push(e);
                expect(loadHistory(file)).toEqual(expected.slice(-500));
            }
            const fresh = join(root, "fresh.json");
            for (const e of entries) recordNavigation(e, fresh);
            expect(loadHistory(fresh)).toEqual(entries);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }), propertyParameters(12));
});

test("arbitrary bytes and JSON never make loadHistory throw", () => {
    fc.assert(fc.property(fc.oneof(fc.uint8Array({ maxLength: 2000 }), fc.jsonValue().map((v) => Buffer.from(JSON.stringify(v)))), (bytes) => {
        const root = mkdtempSync(join(tmpdir(), "jd-property-garbage-"));
        try {
            const file = join(root, "history");
            writeFileSync(file, bytes);
            expect(Array.isArray(loadHistory(file))).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }), propertyParameters(25));
});

test("zero limit drops cd src (shrunk regression)", () => {
    expect(parseShellNavigation("cd src", 0)).toEqual([]);
});

test("valid history commands retain the exact ordered tail, including duplicates", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom("cd", "pushd", "jd"), fc.nat({ max: 100 })), { maxLength: 40 }), fc.integer({ min: 0, max: 30 }), (commands, limit) => {
        const expected = commands.map(([command, suffix]) => `${command} path-${suffix}`);
        const raw = expected.map((command, i) => `${i % 2 ? ": 123:0;" : ""}${command}\necho ignored`).join("\n");
        expect(parseShellNavigation(raw, limit)).toEqual(limit === 0 ? [] : expected.slice(-limit));
    }), propertyParameters());
});
