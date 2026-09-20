import { readFile, writeFile, rename, unlink, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createGateway } from "ai";
import { loadHistory, summarizeUsage } from "./history";

export const JEV_INPUT_USD_PER_MTOK = 0.40;
export const MAX_USAGE_RECORDS = 500;
export const DAY = 86_400_000;
export type CallUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number; modelId?: string };
export type UsageRecord = CallUsage & { timestamp: number; label: string; candidates: number; route: string };
type Counts = { calls: number; inputTokens: number; outputTokens: number; totalTokens: number; unknownTokens: number };
export type DailyUsage = Counts & { timestamp: number };
export type Ledger = { records: UsageRecord[]; daily: DailyUsage[] };
export type Prices = { input: number; output: number };
const empty = (): Ledger => ({ records: [], daily: [] });
const zero = (): Counts => ({ calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownTokens: 0 });
const validNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const dayStart = (timestamp: number) => Math.floor(timestamp / DAY) * DAY;
export const defaultUsageFile = () => process.env.JD_USAGE_FILE ?? join(homedir(), ".jd_usage.json");

export function prices(env: NodeJS.ProcessEnv = process.env): Prices {
    const rate = (value: string | undefined, fallback: number) => value?.trim() && validNumber(Number(value)) ? Number(value) : fallback;
    return { input: rate(env.JD_PRICE_INPUT_PER_MTOK, JEV_INPUT_USD_PER_MTOK), output: rate(env.JD_PRICE_OUTPUT_PER_MTOK, 0) };
}

function counts(record: UsageRecord): Counts {
    return { calls: 1, inputTokens: record.inputTokens ?? 0, outputTokens: record.outputTokens ?? 0,
        totalTokens: record.totalTokens ?? (record.inputTokens ?? 0) + (record.outputTokens ?? 0),
        unknownTokens: Number(record.inputTokens == null || record.outputTokens == null) };
}
function add(target: Counts, source: Counts) {
    for (const key of Object.keys(target) as (keyof Counts)[]) target[key] += source[key];
}

export function compact(ledger: Ledger, limit = MAX_USAGE_RECORDS): Ledger {
    const records = [...ledger.records].sort((a, b) => a.timestamp - b.timestamp);
    const daily = new Map<number, Counts>();
    for (const entry of ledger.daily) {
        const sum = daily.get(entry.timestamp) ?? zero();
        add(sum, { calls: entry.calls, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens,
            totalTokens: entry.totalTokens, unknownTokens: entry.unknownTokens });
        daily.set(entry.timestamp, sum);
    }
    for (const record of records.splice(0, Math.max(0, records.length - limit))) {
        const day = dayStart(record.timestamp);
        const sum = daily.get(day) ?? zero();
        add(sum, counts(record));
        daily.set(day, sum);
    }
    return { records, daily: [...daily].sort(([a], [b]) => a - b).map(([timestamp, sum]) => ({ timestamp, ...sum })) };
}

export function totals(ledger: Ledger, start: number, end: number, rates: Prices) {
    const sum = zero();
    for (const record of ledger.records) if (record.timestamp >= start && record.timestamp < end) add(sum, counts(record));
    for (const entry of ledger.daily) if (entry.timestamp >= start && entry.timestamp < end) {
        add(sum, { calls: entry.calls, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens,
            totalTokens: entry.totalTokens, unknownTokens: entry.unknownTokens });
    }
    const estimatedCost = (sum.inputTokens * rates.input + sum.outputTokens * rates.output) / 1_000_000;
    return { ...sum, estimatedCost, averageTokens: sum.calls ? sum.totalTokens / sum.calls : 0,
        averageCost: sum.calls ? estimatedCost / sum.calls : 0 };
}

export async function loadUsage(file: string): Promise<Ledger> {
    try {
        const data = JSON.parse(await readFile(file, "utf8"));
        const tokens = ["inputTokens", "outputTokens", "totalTokens"];
        if (!Array.isArray(data.records) || !Array.isArray(data.daily)) return empty();
        if (!data.records.every((r: UsageRecord) => r && validNumber(r.timestamp) && typeof r.label === "string"
            && typeof r.route === "string" && validNumber(r.candidates)
            && tokens.every(k => r[k as keyof UsageRecord] === undefined || validNumber(r[k as keyof UsageRecord])))) return empty();
        if (!data.daily.every((r: DailyUsage) => r && validNumber(r.timestamp) && r.timestamp === dayStart(r.timestamp)
            && Object.keys(zero()).every(k => validNumber(r[k as keyof Counts])))) return empty();
        return data;
    } catch { return empty(); }
}

export async function appendUsage(file: string, record: UsageRecord): Promise<void> {
    // Fail fast on concurrent writers rather than delaying a jump or losing another process's update.
    const lock = await open(`${file}.lock`, "wx");
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        const ledger = await loadUsage(file);
        ledger.records.push(record);
        await writeFile(temporary, JSON.stringify(compact(ledger)), { mode: 0o600 });
        await rename(temporary, file);
    } finally {
        await lock.close();
        await unlink(temporary).catch(() => {});
        await unlink(`${file}.lock`).catch(() => {});
    }
}

export async function recordUsage(file: string, record: UsageRecord, log: (line: string) => void) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([appendUsage(file, record), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("write timed out")), 150);
        })]);
    } catch (error) {
        log(`jd: could not save usage (${String((error as Error).message).replace(/[\r\n]+/g, " ")})`);
    } finally { clearTimeout(timer); }
}

export type SpendFetcher = (startDate: string, endDate: string) => Promise<{
    results: { totalCost: number; inputTokens?: number; outputTokens?: number; requestCount?: number }[];
    credits: { balance: string; totalUsed: string };
}>;
export const fetchSpend: SpendFetcher = async (startDate, endDate) => {
    const timedFetch: typeof fetch = Object.assign((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(url, {
        ...init, signal: AbortSignal.any([AbortSignal.timeout(2000), ...(init?.signal ? [init.signal] : [])]),
    }), { preconnect: fetch.preconnect });
    const gateway = createGateway({ fetch: timedFetch });
    const [report, credits] = await Promise.all([
        gateway.getSpendReport({ startDate, endDate, model: "typesafe-ai/jev", groupBy: "model" }),
        gateway.getCredits(),
    ]);
    return { results: report.results, credits };
};
const date = (time: number) => new Date(time).toISOString().slice(0, 10);

export async function usageReport(options: {
    file: string; historyFile: string; now: number; fetcher?: SpendFetcher; env?: NodeJS.ProcessEnv; timeoutMs?: number;
}) {
    const env = options.env ?? process.env;
    const ledger = await loadUsage(options.file);
    const history = loadHistory(options.historyFile);
    const rates = prices(env);
    const today = dayStart(options.now);
    const windows = [ ["today", today], ["last7Days", today - 6 * DAY], ["last30Days", today - 29 * DAY], ["allTime", 0] ] as const;
    const reports = windows.map(([window, start]) => ({ window, startDate: date(start), endDate: date(today),
        local: totals(ledger, start, today + DAY, rates),
        noModelNavigations: summarizeUsage(history.filter(r => r.timestamp >= start && r.timestamp < today + DAY)).bySource.exact,
        billed: null as null | { cost: number; calls: number; inputTokens: number; outputTokens: number },
    }));
    let credits: Awaited<ReturnType<SpendFetcher>>["credits"] | null = null;
    let note = "Gateway billing unavailable: AI_GATEWAY_API_KEY is absent; using local estimates.";
    if (options.fetcher || env.AI_GATEWAY_API_KEY) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const billed = await Promise.race([
                Promise.all(reports.map(r => (options.fetcher ?? fetchSpend)(r.startDate, r.endDate))),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), options.timeoutMs ?? 2000); }),
            ]);
            billed.forEach((result, i) => {
                reports[i]!.billed = result.results.reduce((sum, row) => ({ cost: sum.cost + row.totalCost,
                    calls: sum.calls + (row.requestCount ?? 0), inputTokens: sum.inputTokens + (row.inputTokens ?? 0),
                    outputTokens: sum.outputTokens + (row.outputTokens ?? 0) }), { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 });
            });
            credits = billed[0]!.credits;
            note = "Gateway billed figures cover all typesafe-ai/jev activity in this account, not only jd.";
        } catch { note = "Gateway billing unavailable: request failed or timed out; using local estimates."; }
        finally { clearTimeout(timer); }
    }
    return { currency: "USD", timezone: "UTC", ratesPerMillionTokens: rates, reports, credits, note,
        historyNote: "No-model counts are exact matches in retained history (latest 500); fallback sources cannot distinguish failed calls from no key." };
}

export function formatUsage(report: Awaited<ReturnType<typeof usageReport>>): string {
    const rates = report.ratesPerMillionTokens;
    const row = (values: (string | number)[]) => values.map((value, i) =>
        i === 0 ? String(value).padEnd(12) : String(value).padStart([0, 7, 10, 10, 12, 11, 13, 9, 9][i]!)).join(" ");
    const lines = [`jd usage — local estimate (USD); UTC calendar days; rates per million tokens: input $${rates.input}, output $${rates.output}`,
        row(["Window", "Calls", "Input", "Output", "Est. USD", "Avg tokens", "Avg USD/call", "Unknown", "No-model"])];
    for (const r of report.reports) {
        const s = r.local;
        lines.push(row([r.window, s.calls, s.inputTokens, s.outputTokens, `$${s.estimatedCost.toFixed(6)}`,
            s.averageTokens.toFixed(1), `$${s.averageCost.toFixed(6)}`, s.unknownTokens, r.noModelNavigations]));
        if (r.billed) lines.push(`  Gateway billed: $${r.billed.cost.toFixed(6)}; ${r.billed.calls} requests; ${r.billed.inputTokens} input / ${r.billed.outputTokens} output tokens`);
    }
    if (report.credits) lines.push(`Gateway credits: $${report.credits.balance} remaining; $${report.credits.totalUsed} used (account-wide)`);
    lines.push(report.note, report.historyNote);
    return lines.join("\n");
}
