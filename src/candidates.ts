import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DirectoryStats } from "./history";

export type MatchKind = "exact-name" | "prefix" | "substring" | "path" | "fuzzy" | "history";

export type Candidate = {
    path: string;
    /** Short, unique label: relative to cwd when below it, otherwise `~`-abbreviated. */
    display: string;
    match: MatchKind;
    /** Where the directory sits relative to cwd. */
    relation: "descendant" | "nearby" | "elsewhere";
    depth: number;
    stats?: DirectoryStats;
    /** Local ranking score; only used to order and truncate the list sent to the model. */
    score: number;
};

const IGNORED = new Set(["node_modules", "Library", "__pycache__", "target", "dist", "build", "vendor"]);
const MAX_DEPTH = 3;
const MAX_SCANNED = 3000;
// Send close to the full set (TypeSafe allows 255 options) rather than a tight shortlist.
export const MAX_CANDIDATES = 200;

export function expandHome(input: string): string {
    if (input === "~") return homedir();
    return input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** A query that resolves to a real directory from cwd needs no prediction. */
export function findExactMatch(query: string, cwd: string): string | null {
    const target = resolve(cwd, expandHome(query));
    if (!isDirectory(target)) return null;
    // On case-insensitive disks `SRC` opens `src`; record the real name so history doesn't split.
    // Only the case is corrected: symlinks keep their logical path, as `cd` does.
    try {
        const real = realpathSync.native(target);
        return real.toLowerCase() === target.toLowerCase() ? real : target;
    } catch {
        return target;
    }
}

function listSubdirectories(dir: string, includeHidden: boolean): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true })
            // Symlinks to directories are offered too; scanBelow never descends into them.
            .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(join(dir, entry.name))))
            .filter((entry) => !IGNORED.has(entry.name) && (includeHidden || !entry.name.startsWith(".")))
            .map((entry) => join(dir, entry.name));
    } catch {
        return []; // unreadable directory
    }
}

/** Breadth-first so shallow directories survive the scan cap. */
function scanBelow(root: string, includeHidden: boolean): string[] {
    const found: string[] = [];
    let level = [root];
    for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
        const next: string[] = [];
        for (const dir of level) {
            for (const child of listSubdirectories(dir, includeHidden)) {
                if (found.length >= MAX_SCANNED) return found;
                found.push(child);
                if (!lstatSync(child).isSymbolicLink()) next.push(child); // no cycles, no duplicate scans
            }
        }
        level = next;
    }
    return found;
}

function isSubsequence(needle: string, haystack: string): boolean {
    let index = 0;
    for (const char of haystack) {
        if (char === needle[index]) index++;
    }
    return index === needle.length;
}

export function matchKind(query: string, path: string, cwd?: string): Exclude<MatchKind, "history"> | null {
    // `./src/comp` and `../doc` are anchored to cwd; `src/comp` stays an unanchored fragment.
    const anchored = cwd && /^\.\.?\//.test(query) ? resolve(cwd, query) : expandHome(query);
    const needle = anchored.toLowerCase().replace(/\/+$/, "");
    if (needle === "") return null;
    const name = basename(path).toLowerCase();
    if (needle.includes("/")) return path.toLowerCase().includes(needle) ? "path" : null;
    if (name === needle) return "exact-name";
    if (name.startsWith(needle)) return "prefix";
    if (name.includes(needle)) return "substring";
    if (needle.length >= 2 && isSubsequence(needle, name)) return "fuzzy";
    return null;
}

const MATCH_WEIGHT: Record<MatchKind, number> = {
    "exact-name": 5,
    prefix: 4,
    path: 3.5,
    substring: 3,
    fuzzy: 1.5,
    history: 1,
};

export function displayPath(path: string, cwd: string): string {
    const rel = relative(cwd, path);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    const home = homedir();
    return path === home || path.startsWith(home + sep) ? "~" + path.slice(home.length) : path;
}

/**
 * Collects directories the query could mean — below cwd, next to cwd's ancestors, and from
 * jd history — and ranks them locally so the most plausible ones fit in the model's list.
 */
export function gatherCandidates(
    query: string,
    cwd: string,
    history: Map<string, DirectoryStats>,
): Candidate[] {
    const includeHidden = query.startsWith(".");
    const pool = new Map<string, Candidate["relation"]>();

    for (const dir of scanBelow(cwd, includeHidden)) pool.set(dir, "descendant");
    let ancestor = cwd;
    for (let up = 0; up < 3 && dirname(ancestor) !== ancestor; up++) {
        ancestor = dirname(ancestor);
        if (!pool.has(ancestor)) pool.set(ancestor, "nearby");
        for (const dir of listSubdirectories(ancestor, includeHidden)) {
            if (!pool.has(dir)) pool.set(dir, "nearby");
        }
    }
    for (const path of history.keys()) {
        if (!pool.has(path) && isDirectory(path)) pool.set(path, "elsewhere");
    }
    pool.delete(cwd);

    const candidates: Candidate[] = [];
    for (const [path, relation] of pool) {
        const stats = history.get(path);
        // A directory this exact query led to before is a candidate even if the name doesn't match.
        let match: MatchKind | null = matchKind(query, path, cwd);
        // Fuzzy matches are weak evidence; outside cwd they are mostly noise unless visited before.
        if (match === "fuzzy" && relation !== "descendant" && !stats) match = null;
        match ??= stats && stats.queryHits > 0 ? "history" : null;
        if (!match) continue;
        const depth = relation === "descendant" ? relative(cwd, path).split(sep).length : 0;
        const score =
            MATCH_WEIGHT[match] +
            Math.min(stats?.frecency ?? 0, 3) +
            Math.min(stats?.queryHits ?? 0, 3) * 1.5 +
            (relation === "descendant" ? 1 - 0.25 * depth : relation === "nearby" ? 0.25 : 0);
        candidates.push({ path, display: displayPath(path, cwd), match, relation, depth, stats, score });
    }

    return candidates
        .sort((a, b) => b.score - a.score || a.display.localeCompare(b.display))
        .slice(0, MAX_CANDIDATES);
}
