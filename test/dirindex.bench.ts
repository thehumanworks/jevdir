// Run with `bun test/dirindex.bench.ts`; excludes process startup and initial discovery.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherCandidates } from "../src/candidates";
import { indexOptions, loadIndex, saveIndex } from "../src/dirindex";

const root = mkdtempSync(join(tmpdir(), "jd-index-bench-"));
try {
    const home = join(root, "home");
    const cwd = join(root, "away/a/b/c/d");
    mkdirSync(cwd, { recursive: true });
    const paths = Array.from({ length: 50_000 }, (_, i) => join(home, `project-${i}`, "src"));
    for (const path of paths) mkdirSync(path, { recursive: true });
    mkdirSync(join(home, ".config/mise"), { recursive: true });
    paths[0] = join(home, ".config/mise");
    const options = { ...indexOptions(), root: home, file: join(root, "index.json") };
    saveIndex({ version: 1, root: home, createdAt: Date.now(), paths }, options.file);
    for (const query of ["mise", "src"]) {
        const samples: number[] = [];
        for (let i = 0; i < 25; i++) {
            const start = performance.now();
            const candidates = gatherCandidates(query, cwd, new Map(), loadIndex(options)!.paths);
            if (!candidates.length) throw new Error("benchmark must return live results");
            if (i >= 5) samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        console.log(`${query}: load + gather, 50,000 live indexed directories, median ${samples[10]!.toFixed(2)} ms, p95 ${samples[18]!.toFixed(2)} ms`);
    }
} finally {
    rmSync(root, { recursive: true, force: true });
}
