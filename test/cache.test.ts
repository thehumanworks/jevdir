import { expect, test } from "bun:test";
import fc from "fast-check";
import { cacheOptionsFromEnv, DEFAULT_CACHE_OPTIONS, lookupCached } from "../src/cache";
import type { HistoryEntry } from "../src/history";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const entry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
    query: "comp", path: "/components", cwd: "/project", timestamp: NOW, source: "auto", ...overrides,
});
const votes = (count: number, overrides: Partial<HistoryEntry> = {}) => Array.from({ length: count }, () => entry(overrides));

test("three fresh uses hit; normalization ignores case, whitespace and trailing slashes", () => {
    expect(lookupCached(votes(3), " COMP/ ", NOW)).toEqual({ path: "/components", score: 3, hits: 3 });
    expect(lookupCached(votes(2), "comp", NOW)).toBeNull();
    expect(lookupCached(votes(3), "comp", NOW + 7 * DAY)).toBeNull();
});

test("TTL boundary, overrides and invalid options", () => {
    const options = { minScore: 0.1 };
    expect(lookupCached(votes(1), "comp", NOW + 14 * DAY, options)?.score).toBe(0.25);
    expect(lookupCached(votes(1), "comp", NOW + 14 * DAY + 1, options)).toBeNull();
    expect(lookupCached(votes(3), "comp", NOW, { halfLifeDays: 0 })).toBeNull();
    expect(cacheOptionsFromEnv({})).toEqual(DEFAULT_CACHE_OPTIONS);
    expect(cacheOptionsFromEnv({ JD_CACHE_TTL_DAYS: "0", JD_CACHE_HALF_LIFE_DAYS: "NaN", JD_CACHE_MIN_SCORE: "-1" })).toEqual(DEFAULT_CACHE_OPTIONS);
    expect(cacheOptionsFromEnv({ JD_CACHE_TTL_DAYS: "4", JD_CACHE_HALF_LIFE_DAYS: "2", JD_CACHE_MIN_SCORE: "5" })).toMatchObject({ ttlDays: 4, halfLifeDays: 2, minScore: 5 });
});

test("corrections vote twice for the user's path and weaken a wrong target", () => {
    const wrong = votes(6);
    expect(lookupCached(wrong, "comp", NOW)).not.toBeNull();
    const correction = entry({ path: "/compiler", source: "confirmed", modelChoiceAccepted: false });
    expect(lookupCached([...wrong, correction], "comp", NOW)).toBeNull();
    expect(lookupCached([correction, correction], "comp", NOW)).toEqual({ path: "/compiler", score: 4, hits: 2 });
});

test("expiring conflicting evidence can resolve ambiguity, without increasing the winning score", () => {
    const entries = [...votes(3), ...votes(4, { path: "/compiler", timestamp: NOW - 14 * DAY })];
    expect(lookupCached(entries, "comp", NOW)).toBeNull();
    const hit = lookupCached(entries, "comp", NOW + 1);
    expect(hit?.path).toBe("/components");
    expect(hit!.score).toBeLessThan(3);
});

const evidence = fc.array(fc.record({
    query: fc.constantFrom("comp", "COMP/", "other"),
    path: fc.constantFrom("/components", "/compiler"),
    cwd: fc.constant("/project"),
    timestamp: fc.integer({ min: NOW - 20 * DAY, max: NOW }),
    source: fc.constantFrom("auto", "confirmed", "fallback", "cached", "exact"),
    modelChoiceAccepted: fc.boolean(),
}) as fc.Arbitrary<HistoryEntry>, { maxLength: 80 });

test("property: hits always have matching input evidence", () => {
    fc.assert(fc.property(evidence, (entries) => {
        const hit = lookupCached(entries, "comp", NOW);
        if (hit) expect(entries.some((e) => e.path === hit.path && ["comp", "COMP/"].includes(e.query))).toBe(true);
    }));
});

test("property: expired, exact and cached entries cannot change a result", () => {
    fc.assert(fc.property(evidence, evidence, (entries, extra) => {
        const before = lookupCached(entries, "comp", NOW);
        for (const ignored of [extra.map((e) => ({ ...e, timestamp: NOW - 15 * DAY })),
            extra.map((e) => ({ ...e, source: "exact" as const })),
            extra.map((e) => ({ ...e, source: "cached" as const }))]) {
            expect(lookupCached([...entries, ...ignored], "comp", NOW)).toEqual(before);
        }
    }));
});

test("property: evenly split evidence is always ambiguous", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
        expect(lookupCached([...votes(n), ...votes(n, { path: "/compiler" })], "comp", NOW)).toBeNull();
    }));
});

test("property: a target's score cannot rise and a score-based miss cannot become a hit", () => {
    fc.assert(fc.property(evidence, fc.integer({ min: 0, max: 30 * DAY }), (entries, elapsed) => {
        const single = entries.map((e) => ({ ...e, path: "/components" }));
        const before = lookupCached(single, "comp", NOW);
        const after = lookupCached(single, "comp", NOW + elapsed);
        if (!before) expect(after).toBeNull();
        if (before && after) expect(after.score).toBeLessThanOrEqual(before.score);
    }));
});
