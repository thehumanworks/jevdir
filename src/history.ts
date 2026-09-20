import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** How a navigation was decided. */
export type NavigationSource =
    | "exact" // query resolved to a real directory; no model call
    | "auto" // model answer passed the probability + confidence gate
    | "confirmed" // user picked from the list after a low-certainty model answer
    | "fallback"; // model unavailable; user picked from the local ranking

export type HistoryEntry = {
    query: string;
    path: string;
    cwd: string;
    timestamp: number;
    source: NavigationSource;
    /** For "confirmed": did the user pick the model's top choice? */
    modelChoiceAccepted?: boolean;
};

export type DirectoryStats = {
    visits: number;
    lastVisited: number;
    /** Recency-weighted visit count: each visit is worth 0.5^(age / half-life). */
    frecency: number;
    /** Number of past visits that started from this same query. */
    queryHits: number;
};

const MAX_ENTRIES = 500;
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

export function defaultHistoryFile(): string {
    return process.env.JD_HISTORY_FILE ?? join(homedir(), ".jd_history.json");
}

function isEntry(value: unknown): value is HistoryEntry {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Record<string, unknown>;
    return (
        typeof entry.query === "string" &&
        typeof entry.path === "string" &&
        typeof entry.cwd === "string" &&
        typeof entry.timestamp === "number"
    );
}

/** Missing, unreadable, or corrupt history is treated as empty history. */
export function loadHistory(file = defaultHistoryFile()): HistoryEntry[] {
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        const entries = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown })?.entries;
        return Array.isArray(entries) ? entries.filter(isEntry) : [];
    } catch {
        return [];
    }
}

export function recordNavigation(entry: HistoryEntry, file = defaultHistoryFile()): void {
    const entries = [...loadHistory(file), entry].slice(-MAX_ENTRIES);
    mkdirSync(dirname(file), { recursive: true });
    // Write-then-rename so a crash never leaves a half-written history file.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2));
    renameSync(tmp, file);
}

export function analyzeHistory(
    entries: HistoryEntry[],
    query: string,
    now = Date.now(),
): Map<string, DirectoryStats> {
    const stats = new Map<string, DirectoryStats>();
    const normalizedQuery = query.toLowerCase();
    for (const entry of entries) {
        const current = stats.get(entry.path) ?? { visits: 0, lastVisited: 0, frecency: 0, queryHits: 0 };
        const age = Math.max(0, now - entry.timestamp);
        current.visits += 1;
        current.lastVisited = Math.max(current.lastVisited, entry.timestamp);
        current.frecency += Math.pow(0.5, age / HALF_LIFE_MS);
        if (entry.query.toLowerCase() === normalizedQuery) current.queryHits += 1;
        stats.set(entry.path, current);
    }
    return stats;
}

export type UsageSummary = {
    total: number;
    bySource: Record<NavigationSource, number>;
    /** Of the low-certainty answers shown to the user, how often the model's top pick was right. */
    confirmedTopPickRate: number | null;
};

export function summarizeUsage(entries: HistoryEntry[]): UsageSummary {
    const bySource: Record<NavigationSource, number> = { exact: 0, auto: 0, confirmed: 0, fallback: 0 };
    let accepted = 0;
    let judged = 0;
    for (const entry of entries) {
        if (entry.source in bySource) bySource[entry.source] += 1;
        if (entry.source === "confirmed" && entry.modelChoiceAccepted != null) {
            judged += 1;
            if (entry.modelChoiceAccepted) accepted += 1;
        }
    }
    return { total: entries.length, bySource, confirmedTopPickRate: judged === 0 ? null : accepted / judged };
}

// Fail closed: a line is kept only if it is nothing but the command and plain path-like words.
// Any shell syntax (chaining, redirection, substitution, quotes, assignments) drops the whole line.
const NAVIGATION_COMMAND = /^(cd|pushd|jd)(\s+[\w.\/~@+:,-]+)*$/;

/** Pulls navigation commands out of raw shell history (zsh extended or plain format). */
export function parseShellNavigation(raw: string, limit = 15): string[] {
    if (limit <= 0) return [];
    const commands: string[] = [];
    for (const line of raw.split("\n")) {
        // zsh EXTENDED_HISTORY: ": 1700000000:0;cd src"
        const command = line.replace(/^: \d+:\d+;/, "").trim();
        if (NAVIGATION_COMMAND.test(command)) commands.push(command);
    }
    return commands.slice(-limit);
}

/**
 * Recent `cd` / `pushd` / `jd` commands from the shell's history file. Lines containing any
 * shell syntax beyond the command and plain paths are dropped whole, so secrets never reach the model.
 */
export function readShellNavigation(limit = 15): string[] {
    const files = [process.env.HISTFILE, join(homedir(), ".zsh_history"), join(homedir(), ".bash_history")];
    for (const file of files) {
        if (!file || !existsSync(file)) continue;
        try {
            // latin1: zsh metafies non-ASCII bytes, which is not valid UTF-8.
            const raw = readFileSync(file, "latin1");
            // Drop the first line of the tail: the slice may have cut it in half.
            const tail = raw.length > 64_000 ? raw.slice(-64_000).replace(/^[^\n]*\n/, "") : raw;
            return parseShellNavigation(tail, limit);
        } catch {
            continue;
        }
    }
    return [];
}
