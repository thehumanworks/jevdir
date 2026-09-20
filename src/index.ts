#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { statSync } from "node:fs";
import { cacheOptionsFromEnv, lookupCached, type CacheOptions } from "./cache";
import { indexedDirectories, indexOptions, rebuildIndex, type IndexOptions } from "./dirindex";
import type { Experimental_EvaluationModel } from "ai";
import { findExactMatch, gatherCandidates, displayPath, type Candidate } from "./candidates";
import { chooseDir, resolveModel, routePrediction, type Prediction, type RankedCandidate } from "./choice";
import {
    analyzeHistory,
    defaultHistoryFile,
    loadHistory,
    readShellNavigation,
    recordNavigation,
    summarizeUsage,
    type NavigationSource,
} from "./history";

// A child process cannot change its parent shell's directory. `jd init` prints a shell
// function that runs this program and `cd`s to the single path it writes to stdout.
// Everything meant for the user's eyes goes to stderr.

export type Deps = {
    cwd: string;
    historyFile: string;
    directoryIndex?: IndexOptions;
    /** Injected in tests; resolved from the environment when omitted. */
    model?: Experimental_EvaluationModel;
    recentNavigation: () => string[];
    interactive: boolean;
    /** Asks the user a question; resolves to the raw answer. */
    prompt: (question: string) => Promise<string>;
    log: (line: string) => void;
    now: () => number;
    cacheOptions?: Partial<CacheOptions>;
    noCache?: string;
    isDirectory?: (path: string) => boolean;
};

export type RunResult = { exitCode: number; stdout: string };

const MAX_OPTIONS_SHOWN = 5;

const USAGE = `usage: jd <partial-dir>     jump to the directory you most likely mean
       jd init [zsh|bash]  print the shell function + tab completion (eval it in your rc file)
       jd index            rebuild the home directory index
       jd --stats          show how past navigations were decided
       jd --complete <p>   list completion candidates (used by the shell completion)`;

const color = (code: number, text: string) =>
    process.stderr.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
const percent = (value: number | undefined) => (value == null ? "n/a" : `${Math.round(value * 100)}%`);

function shellInit(shell: string): string {
    // Single-quoted so `$`, backticks, and quotes in the install path stay inert.
    const quote = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`;
    // A compiled binary (`bun build --compile`) has a virtual module path like /$bunfs/root/jd
    // that no `bun` on disk can load; the executable itself is the program.
    // (existsSync is no test: Bun's virtual filesystem answers true for it.)
    const compiled = import.meta.path.startsWith("/$bunfs/") || import.meta.path.includes("~BUN");
    const run = compiled ? `command ${quote(process.execPath)}` : `command bun ${quote(import.meta.path)}`;
    const fn = `jd() {
  case "$1" in
    ""|init|index|--reindex|-h|--help|--stats|--complete) ${run} "$@"; return ;;
  esac
  local dest
  dest="$(${run} "$@")" || return $?
  [ -n "$dest" ] && builtin cd -- "$dest"
}`;
    if (shell === "bash") {
        return `${fn}
_jd() {
  COMPREPLY=()
  local line
  while IFS= read -r line; do COMPREPLY+=("$line"); done < <(${run} --complete "\${COMP_WORDS[COMP_CWORD]}" 2>/dev/null)
}
complete -o filenames -F _jd jd`;
    }
    return `${fn}
_jd() {
  local -a dirs
  dirs=(\${(f)"$(${run} --complete "\${words[CURRENT]}" 2>/dev/null)"})
  (( \${#dirs} )) && compadd -U -f -- "\${dirs[@]}"
}
(( $+functions[compdef] )) && compdef _jd jd`;
}

function formatOptions(ranked: RankedCandidate[], cwd: string): string[] {
    return ranked.map(({ candidate, probability }, index) => {
        const visits = candidate.stats ? color(2, `  visited ${candidate.stats.visits}×`) : "";
        const share = probability == null ? "" : color(2, `  ${percent(probability)}`);
        return `  ${index + 1}) ${displayPath(candidate.path, cwd)}${share}${visits}`;
    });
}

/** `enterPicksFirst` is off when the model abstained: a bare Enter must not pick a 1% option. */
async function pickFromList(ranked: RankedCandidate[], deps: Deps, enterPicksFirst = true): Promise<Candidate | null> {
    const shown = ranked.slice(0, MAX_OPTIONS_SHOWN);
    for (const line of formatOptions(shown, deps.cwd)) deps.log(line);
    if (!deps.interactive) {
        deps.log("Not a terminal, so not asking. Re-run with one of the paths above.");
        return null;
    }
    const enter = enterPicksFirst ? "Enter = 1" : "Enter = cancel";
    const answer = (await deps.prompt(`Go to [1-${shown.length}, ${enter}, q = cancel]: `)).trim();
    if (answer === "") return enterPicksFirst ? (shown[0]?.candidate ?? null) : null;
    const index = Number(answer);
    return Number.isInteger(index) ? (shown[index - 1]?.candidate ?? null) : null;
}

function navigate(path: string, query: string, source: NavigationSource, deps: Deps, accepted?: boolean): RunResult {
    try {
        recordNavigation(
            { query, path, cwd: deps.cwd, timestamp: deps.now(), source, modelChoiceAccepted: accepted },
            deps.historyFile,
        );
    } catch (error) {
        deps.log(color(33, `jd: could not save history (${(error as Error).message})`));
    }
    return { exitCode: 0, stdout: path };
}

async function predict(query: string, candidates: Candidate[], deps: Deps): Promise<Prediction | null> {
    let model = deps.model;
    if (!model) {
        const resolved = await resolveModel();
        if ("reason" in resolved) {
            deps.log(color(33, `jd: prediction unavailable — ${resolved.reason}`));
            return null;
        }
        model = resolved.model;
    }
    try {
        return await chooseDir({
            model,
            query,
            cwd: deps.cwd,
            candidates,
            recentNavigation: deps.recentNavigation(),
            now: deps.now(),
            abortSignal: AbortSignal.timeout(10_000),
        });
    } catch (error) {
        deps.log(color(33, `jd: model unavailable — ${(error as Error).message}`));
        return null;
    }
}

async function jump(query: string, deps: Deps): Promise<RunResult> {
    const exact = findExactMatch(query, deps.cwd);
    if (exact) {
        deps.log(`${color(36, "jd →")} ${displayPath(exact, deps.cwd)} ${color(2, "(exact match)")}`);
        return navigate(exact, query, "exact", deps);
    }

    const entries = loadHistory(deps.historyFile);
    const cached = deps.noCache && deps.noCache !== "0" ? null : lookupCached(entries, query, deps.now(),
        deps.cacheOptions);
    if (cached) {
        let exists = false;
        try {
            exists = deps.isDirectory ? deps.isDirectory(cached.path) : statSync(cached.path).isDirectory();
        } catch {
            // Renamed or deleted directories invalidate a cached prediction.
        }
        if (exists) {
            deps.log(`${color(36, "jd →")} ${displayPath(cached.path, deps.cwd)} ${color(2, `(cached · ${cached.hits} recent uses)`)}`);
            return navigate(cached.path, query, "cached", deps);
        }
    }
    const history = analyzeHistory(entries, query, deps.now());
    const candidates = gatherCandidates(query, deps.cwd, history,
        indexedDirectories(deps.directoryIndex ?? indexOptions(), deps.log));
    if (candidates.length === 0) {
        deps.log(`jd: no directory matching "${query}" near ${deps.cwd}, in the directory index, or in jd history`);
        return { exitCode: 1, stdout: "" };
    }

    const prediction = await predict(query, candidates, deps);
    if (!prediction) {
        deps.log("Best local matches (by name and visit frequency):");
        const ranked = candidates.map((candidate) => ({ candidate, probability: undefined }));
        const picked = await pickFromList(ranked, deps);
        return picked ? navigate(picked.path, query, "fallback", deps) : { exitCode: 1, stdout: "" };
    }

    const metrics = `probability ${percent(prediction.probability)} · confidence ${percent(prediction.confidence)}`;
    const route = routePrediction(prediction);
    if (route === "auto" && prediction.selected) {
        deps.log(`${color(36, "jd →")} ${displayPath(prediction.selected.path, deps.cwd)} ${color(2, `(${metrics})`)}`);
        return navigate(prediction.selected.path, query, "auto", deps);
    }

    deps.log(
        route === "options"
            ? `jd: the model found no convincing match for "${query}". Closest candidates:`
            : `jd: not sure enough to jump (${metrics}). Did you mean:`,
    );
    const picked = await pickFromList(prediction.ranked, deps, route !== "options");
    if (!picked) return { exitCode: 1, stdout: "" };
    // An abstention is not a wrong pick, so it is left out of the top-pick accuracy stat.
    const accepted = prediction.selected ? picked === prediction.selected : undefined;
    return navigate(picked.path, query, "confirmed", deps, accepted);
}

export async function run(args: string[], deps: Deps): Promise<RunResult> {
    const [first, ...rest] = args;
    if (first === undefined || first === "-h" || first === "--help") {
        deps.log(USAGE);
        return { exitCode: first === undefined ? 2 : 0, stdout: "" };
    }
    if (first === "init") {
        const shell = rest[0] ?? "zsh";
        if (shell !== "zsh" && shell !== "bash") {
            deps.log(`jd: unsupported shell "${shell}" (supported: zsh, bash)`);
            return { exitCode: 2, stdout: "" };
        }
        return { exitCode: 0, stdout: shellInit(shell) };
    }
    if (first === "index" || first === "--reindex") {
        try {
            const options = deps.directoryIndex ?? indexOptions();
            rebuildIndex({ ...options, budgetMs: options.fullBudgetMs }, deps.log);
            return { exitCode: 0, stdout: "" };
        } catch (error) {
            deps.log(`jd: could not rebuild directory index (${(error as Error).message})`);
            return { exitCode: 1, stdout: "" };
        }
    }
    if (first === "--complete") {
        // Local only: completion must be instant, so it never calls the model.
        const query = rest[0] ?? "";
        const history = analyzeHistory(loadHistory(deps.historyFile), query, deps.now());
        const names = gatherCandidates(query, deps.cwd, history,
            indexedDirectories(deps.directoryIndex ?? indexOptions(), deps.log)).map((candidate) => candidate.display);
        return { exitCode: 0, stdout: names.join("\n") };
    }
    if (first === "--stats") {
        const usage = summarizeUsage(loadHistory(deps.historyFile));
        const { exact, cached, auto, confirmed, fallback } = usage.bySource;
        deps.log(`${usage.total} navigations in ${deps.historyFile}`);
        deps.log(`  exact match (no model call): ${exact}`);
        deps.log(`  cached (no model call):     ${cached}`);
        deps.log(`  auto-navigated by model:     ${auto}`);
        deps.log(`  confirmed by you:            ${confirmed}`);
        deps.log(`  model unavailable:           ${fallback}`);
        deps.log(`  model's top pick was right when it asked: ${percent(usage.confirmedTopPickRate ?? undefined)}`);
        return { exitCode: 0, stdout: "" };
    }
    return jump(args.join(" "), deps);
}

/** Reads one line. EOF or Ctrl-C without an answer resolves to "q" (cancel). */
export function promptOn(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, question: string): Promise<string> {
    const rl = createInterface({ input, output });
    return new Promise((resolve) => {
        // Registered first and resolved before close(): closing emits "close", which would
        // otherwise win the race and turn every answer into a cancel.
        rl.on("close", () => resolve("q"));
        rl.question(question, (answer) => {
            resolve(answer);
            rl.close();
        });
    });
}

if (import.meta.main) {
    const result = await run(process.argv.slice(2), {
        cwd: process.cwd(),
        historyFile: defaultHistoryFile(),
        recentNavigation: readShellNavigation,
        interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
        prompt: (question) => promptOn(process.stdin, process.stderr, question),
        log: (line) => process.stderr.write(line + "\n"),
        now: Date.now,
        cacheOptions: cacheOptionsFromEnv(process.env),
        noCache: process.env.JD_NO_CACHE,
    });
    if (result.stdout) process.stdout.write(result.stdout + "\n");
    process.exit(result.exitCode);
}
