// Live accuracy check: runs labeled queries through the real evaluation model and reports
// the numbers the routing thresholds should be fitted against. Needs AI_GATEWAY_API_KEY or
// TYPESAFE_AI_API_KEY. Usage: bun run eval
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherCandidates } from "../src/candidates";
import { chooseDir, resolveModel, routePrediction, THRESHOLDS } from "../src/choice";
import { analyzeHistory, type HistoryEntry } from "../src/history";

const TREE = [
    "web/src/components", "web/src/compiler", "web/public", "web/tests",
    "services/api-server/src", "services/api-client/src", "services/auth", "services/billing",
    "docs/api", "docs/guides", "infra/terraform", "infra/docker", "scripts",
];

/** `visits`: [directory, query used, days ago]. `expected: null` means nothing should match. */
const CASES: { query: string; expected: string | null; visits?: [string, string, number][] }[] = [
    { query: "terra", expected: "infra/terraform" },
    { query: "bill", expected: "services/billing" },
    { query: "guides", expected: "docs/guides" },
    { query: "dckr", expected: "infra/docker" },
    { query: "api-s", expected: "services/api-server" },
    { query: "services/auth/", expected: "services/auth" },
    { query: "comp", expected: "web/src/compiler", visits: [["web/src/compiler", "comp", 1], ["web/src/compiler", "comp", 2], ["web/src/compiler", "comp", 3]] },
    { query: "comp", expected: "web/src/components", visits: [["web/src/components", "comp", 0], ["web/src/components", "comp", 1]] },
    { query: "api", expected: "services/api-client", visits: [["services/api-client", "api", 0], ["services/api-client", "api", 1], ["docs/api", "docs", 30]] },
    { query: "be", expected: "services/api-server", visits: [["services/api-server", "be", 1], ["services/api-server", "be", 4]] },
    { query: "src", expected: "web/src", visits: [["web/src", "src", 0], ["web/src", "src", 2]] },
    { query: "xkcdq", expected: null, visits: [["scripts", "scr", 1]] },
];

const resolved = await resolveModel();
if ("reason" in resolved) {
    console.error(`Cannot run the accuracy check: ${resolved.reason}`);
    process.exit(2);
}

const root = join(realpathSync(mkdtempSync(join(tmpdir(), "jd-eval-"))), "a", "b", "c", "project");
for (const dir of TREE) mkdirSync(join(root, dir), { recursive: true });
const now = Date.now();

let correct = 0, auto = 0, autoCorrect = 0;
for (const { query, expected, visits = [] } of CASES) {
    const entries: HistoryEntry[] = visits.map(([dir, q, daysAgo]) => ({
        query: q, path: join(root, dir), cwd: root, timestamp: now - daysAgo * 86_400_000, source: "auto",
    }));
    const candidates = gatherCandidates(query, root, analyzeHistory(entries, query, now));
    let got: string | null = null;
    let route = "no-candidates";
    let metrics = "";
    if (candidates.length > 0) {
        const prediction = await chooseDir({ model: resolved.model, query, cwd: root, candidates, recentNavigation: [] });
        got = prediction.selected?.display ?? null;
        route = routePrediction(prediction);
        metrics = `p=${prediction.probability?.toFixed(2) ?? "n/a"} conf=${prediction.confidence?.toFixed(2) ?? "n/a"}`;
    }
    const ok = got === expected;
    if (ok) correct++;
    if (route === "auto") { auto++; if (ok) autoCorrect++; }
    console.log(`${ok ? "PASS" : "FAIL"}  ${query.padEnd(16)} → ${String(got).padEnd(24)} expected ${String(expected).padEnd(24)} ${route} ${metrics}`);
}

console.log(`\nmodel: ${resolved.label}   thresholds: p≥${THRESHOLDS.probability}, confidence≥${THRESHOLDS.confidence}`);
console.log(`top-1 accuracy:          ${correct}/${CASES.length}`);
console.log(`auto-navigate rate:      ${auto}/${CASES.length}`);
console.log(`auto-navigate precision: ${auto === 0 ? "n/a" : `${autoCorrect}/${auto}`}  (a wrong auto-jump is the costly error; this should be ~100%)`);
