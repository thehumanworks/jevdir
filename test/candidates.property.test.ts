import { expect, test } from "bun:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { displayPath, expandHome, findExactMatch, matchKind } from "../src/candidates";
import { hostileString, propertyParameters } from "./helpers";

const component = hostileString.map((s) => s.replaceAll(/[\/\0]/g, "_") || "empty");

function subsequence(query: string, name: string): boolean {
    let rest = name;
    for (const char of query) {
        const index = rest.indexOf(char);
        if (index < 0) return false;
        rest = rest.slice(index + char.length);
    }
    return true;
}

test("matching kinds obey definitions and are case and trailing-slash insensitive", () => {
    fc.assert(fc.property(hostileString, component, (query, name) => {
        const path = join("/property", name);
        const kind = matchKind(query, path);
        const needle = expandHome(query).toLowerCase().replace(/\/+$/, "");
        const lower = basename(path).toLowerCase();
        expect(matchKind(query.toLowerCase(), path.toLowerCase())).toBe(kind);
        expect(matchKind(query + "/", path)).toBe(kind);
        expect(matchKind("", path)).toBeNull();
        if (kind === "exact-name") expect(lower).toBe(needle);
        if (kind === "prefix") expect(lower.startsWith(needle)).toBe(true);
        if (kind === "substring") expect(lower.includes(needle)).toBe(true);
        if (kind === "fuzzy") expect(subsequence(needle, lower)).toBe(true);
        if (kind === "path") expect(path.toLowerCase().includes(needle)).toBe(true);
        if (!needle) expect(kind).toBeNull();
        expect(matchKind(basename(path), path)).toBe(basename(path) === "~" ? matchKind("~", path) : "exact-name");
    }), propertyParameters(200));
});

test("constructed noncontiguous letter matches are fuzzy", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom("a", "b", "c"), { minLength: 2, maxLength: 12 }), (letters) => {
        expect(matchKind(letters.join(""), `/property/${letters.join("_")}`)).toBe("fuzzy");
    }), propertyParameters());
});

test("display paths resolve back from cwd or expand from home", () => {
    fc.assert(fc.property(fc.array(component, { minLength: 1, maxLength: 4 }), (parts) => {
        const cwd = "/jd-property-cwd";
        const path = resolve(cwd, ...parts);
        expect(resolve(cwd, displayPath(path, cwd))).toBe(path);
        const homePath = resolve(homedir(), ...parts);
        const display = displayPath(homePath, cwd);
        expect(expandHome(display)).toBe(homePath);
    }), propertyParameters());
});

test("exact matching never returns a file or missing directory", () => {
    fc.assert(fc.property(component, fc.boolean(), (generated, directory) => {
        const root = mkdtempSync(join(tmpdir(), "jd-property-exact-"));
        try {
            const name = "item-" + generated.slice(0, 40);
            const path = join(root, name);
            if (directory) mkdirSync(path); else writeFileSync(path, "data");
            const result = findExactMatch(name, root);
            if (result !== null) expect(statSync(result).isDirectory()).toBe(true);
            expect(result !== null).toBe(directory);
            expect(findExactMatch("missing", root)).toBeNull();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }), propertyParameters(20));
});

test("constructed exact, prefix, and substring matches survive mixed case", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom("a", "B", "c", "D"), { minLength: 1, maxLength: 30 }), (letters) => {
        const query = letters.join("");
        for (const [name, kind] of [[query, "exact-name"], [query + "tail", "prefix"], ["_" + query + "_", "substring"]] as const) {
            expect(matchKind(query, `/test/${name}`)).toBe(kind);
            expect(matchKind(query.toUpperCase(), `/test/${name.toLowerCase()}`)).toBe(kind);
            expect(matchKind(query + "/", `/test/${name}`)).toBe(kind);
        }
    }), propertyParameters());
});
