import { expect, test } from "bun:test";
import fc from "fast-check";
import type { Candidate } from "../src/candidates";
import { buildOptions, chooseDir, NONE_OF_THE_ABOVE, routePrediction } from "../src/choice";
import { hostileString, mockJev, propertyParameters } from "./helpers";

const displays = fc.array(fc.oneof(hostileString, fc.constantFrom("x", "./x", "~", "./~", "__proto__", "./__proto__", "none_of_the_above", "./none_of_the_above")), { maxLength: 15 });
const candidatesFor = (names: string[]): Candidate[] => names.map((display, i) => ({ path: `/test/${i}`, display, match: "prefix", relation: "descendant", depth: 1, score: 1 }));
const boundary = fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.constantFrom(undefined, NaN, 0.6, 0.7, 0.6 - Number.EPSILON, 0.6 + Number.EPSILON, 0.7 - Number.EPSILON, 0.7 + Number.EPSILON));

function checkOptions(names: string[]) {
    const candidates = candidatesFor(names);
    const { criteria, byKey } = buildOptions(candidates, 0);
    expect(Object.keys(criteria).length).toBe(candidates.length + 1);
    expect(byKey.size).toBe(candidates.length);
    expect(Object.hasOwn(criteria, NONE_OF_THE_ABOVE)).toBe(true);
    expect(byKey.has(NONE_OF_THE_ABOVE)).toBe(false);
    expect(new Set(byKey.values()).size).toBe(candidates.length);
    for (const candidate of candidates) expect([...byKey.values()].filter((c) => c === candidate)).toHaveLength(1);
    for (const key of byKey.keys()) expect(Object.hasOwn(criteria, key)).toBe(true);
}

test("option keys remain bijective despite hostile and colliding displays", () => {
    fc.assert(fc.property(displays, checkOptions), propertyParameters(200));
});

test("automatic navigation is exactly the inclusive gate; NaN fails closed", () => {
    fc.assert(fc.property(fc.boolean(), boundary, boundary, (selected, probability, confidence) => {
        expect(routePrediction({ selected: selected ? candidatesFor(["x"])[0]! : null, probability, confidence, ranked: [] }) === "auto")
            .toBe(selected && probability !== undefined && confidence !== undefined && probability >= 0.7 && confidence >= 0.6);
    }), propertyParameters(300));
});

test("real evaluate preserves selection and ranks every candidate for valid distributions", async () => {
    await fc.assert(fc.asyncProperty(displays, fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 16, maxLength: 16 }), fc.nat(), async (names, weights, selectedIndex) => {
        const candidates = candidatesFor(names);
        const { criteria, byKey } = buildOptions(candidates, 0);
        const keys = Object.keys(criteria);
        const total = keys.reduce((sum, _, i) => sum + weights[i]!, 0);
        const probabilities = Object.fromEntries(keys.map((key, i) => [key, total ? weights[i]! / total : 1 / keys.length]));
        const highest = Math.max(...Object.values(probabilities));
        const winners = keys.filter((key) => probabilities[key] === highest);
        const choice = winners[selectedIndex % winners.length]!;
        const { model, calls } = mockJev(() => ({ choice, probabilities, confidence: 0.8 }));
        const result = await chooseDir({ model, candidates, query: "x", cwd: "/test", recentNavigation: [], now: 0 });
        expect(calls).toHaveLength(1);
        expect(result.selected).toBe(byKey.get(choice) ?? null);
        expect(result.probability).toBe(probabilities[choice]);
        expect(result.ranked).toHaveLength(candidates.length);
        expect(new Set(result.ranked.map((r) => r.candidate))).toEqual(new Set(candidates));
        for (const [key, candidate] of byKey) {
            expect(result.ranked.find((r) => r.candidate === candidate)!.probability).toBe(probabilities[key]);
        }
        for (let i = 1; i < result.ranked.length; i++) expect(result.ranked[i - 1]!.probability!).toBeGreaterThanOrEqual(result.ranked[i]!.probability!);
    }), propertyParameters(40));
});

test("escaped tilde cannot overwrite an existing ./~ option (shrunk regression)", () => {
    checkOptions(["./~", "~"]);
});

test("threshold boundaries are inclusive and each NaN or missing metric prevents auto", () => {
    const selected = candidatesFor(["x"])[0]!;
    expect(routePrediction({ selected, probability: 0.7, confidence: 0.6, ranked: [] })).toBe("auto");
    for (const [probability, confidence] of [[NaN, 1], [1, NaN], [undefined, 1], [1, undefined], [0.7 - Number.EPSILON, 1], [1, 0.6 - Number.EPSILON]]) {
        expect(routePrediction({ selected, probability, confidence, ranked: [] })).toBe("confirm");
    }
});
