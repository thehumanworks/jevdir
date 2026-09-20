import { mkdirSync, opendirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export type IndexOptions = {
    root: string;
    file: string;
    maxDepth: number;
    maxEntries: number;
    budgetMs: number;
    maxAgeMs: number;
};
export type DirectoryIndex = { version: 1; root: string; createdAt: number; paths: string[] };
const IGNORED = new Set([
    "node_modules", ".git", ".cache", ".Trash", ".npm", "Library", "__pycache__",
    "target", "dist", "build", "vendor", ".next", ".nuxt", ".venv", "venv",
]);

function positive(value: string | undefined, fallback: number, cap: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), cap) : fallback;
}

export function indexOptions(env = process.env): IndexOptions {
    return {
        root: resolve(env.JD_INDEX_ROOT || homedir()),
        file: resolve(env.JD_INDEX_FILE || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "jd", "directories.json")),
        maxDepth: positive(env.JD_INDEX_DEPTH, 5, 20),
        maxEntries: positive(env.JD_INDEX_MAX_ENTRIES, 50_000, 200_000),
        budgetMs: positive(env.JD_INDEX_BUDGET_MS, 150, 2000),
        maxAgeMs: positive(env.JD_INDEX_MAX_AGE_MS, 86_400_000, 2_592_000_000),
    };
}

/** Lexical containment preserves directory symlinks without traversing their targets. */
export function allowedIndexPath(root: string, path: string): boolean {
    const rel = relative(root, path);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) return false;
    const parts = rel.split(sep);
    return !parts.some((part, i) => IGNORED.has(part) ||
        (part === "install" && parts[i - 1] === ".bun") ||
        (part === "registry" && parts[i - 1] === ".cargo"));
}

export function buildIndex(options: IndexOptions): DirectoryIndex {
    const started = performance.now();
    const paths: string[] = [];
    const queue = [{ path: options.root, depth: 0 }];
    // Stream entries rather than reading huge directories before checking the budget.
    for (let i = 0; i < queue.length && paths.length < options.maxEntries; i++) {
        if (performance.now() - started >= options.budgetMs) break;
        const current = queue[i]!;
        if (current.depth >= options.maxDepth) continue;
        let dir;
        try {
            dir = opendirSync(current.path);
            while (paths.length < options.maxEntries && performance.now() - started < options.budgetMs) {
                const entry = dir.readSync();
                if (!entry) break;
                const path = join(current.path, entry.name);
                if (!allowedIndexPath(options.root, path)) continue;
                try {
                    if (!entry.isDirectory() && !(entry.isSymbolicLink() && statSync(path).isDirectory())) continue;
                    paths.push(path);
                    if (entry.isDirectory()) queue.push({ path, depth: current.depth + 1 });
                } catch { /* Broken links and disappearing entries are not candidates. */ }
            }
        } catch { /* Unreadable directories do not stop discovery. */ }
        finally { dir?.closeSync(); }
    }
    return { version: 1, root: options.root, createdAt: Date.now(), paths };
}

export function saveIndex(index: DirectoryIndex, file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temp, JSON.stringify(index), { mode: 0o600, flag: "wx" });
        renameSync(temp, file);
    } finally {
        rmSync(temp, { force: true });
    }
}

export function loadIndex(options: IndexOptions): DirectoryIndex | null {
    try {
        const index = JSON.parse(readFileSync(options.file, "utf8")) as DirectoryIndex;
        if (index.version !== 1 || index.root !== options.root || !Number.isFinite(index.createdAt) ||
            !Array.isArray(index.paths) || index.paths.length > 200_000 ||
            !index.paths.every((path) => typeof path === "string" && isAbsolute(path))) return null;
        return index;
    } catch { return null; }
}

export function rebuildIndex(options: IndexOptions, log: (line: string) => void): DirectoryIndex {
    const start = performance.now();
    const index = buildIndex(options);
    saveIndex(index, options.file);
    log(`jd: indexed ${index.paths.length} directories in ${Math.round(performance.now() - start)} ms`);
    return index;
}

export function refreshIndex(options: IndexOptions): void {
    const compiled = import.meta.path.startsWith("/$bunfs/") || import.meta.path.includes("~BUN");
    const args = compiled ? ["--reindex"] : [join(import.meta.dir, "index.ts"), "--reindex"];
    const child = spawn(process.execPath, args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, JD_INDEX_ROOT: options.root, JD_INDEX_FILE: options.file,
            JD_INDEX_DEPTH: String(options.maxDepth), JD_INDEX_MAX_ENTRIES: String(options.maxEntries),
            JD_INDEX_BUDGET_MS: String(options.budgetMs), JD_INDEX_MAX_AGE_MS: String(options.maxAgeMs) },
    });
    child.on("error", () => {});
    child.unref();
}

export function indexedDirectories(
    options: IndexOptions,
    log: (line: string) => void,
    refresh: (options: IndexOptions) => void = refreshIndex,
): string[] {
    const index = loadIndex(options);
    if (index) {
        if (Date.now() - index.createdAt > options.maxAgeMs) refresh(options);
        return index.paths;
    }
    log("jd: building the directory index for the first time (time-limited scan)");
    try { return rebuildIndex(options, log).paths; }
    catch (error) {
        log(`jd: could not save directory index (${(error as Error).message})`);
        return [];
    }
}
