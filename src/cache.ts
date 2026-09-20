import type { HistoryEntry } from "./history";

const DAY_MS = 24 * 60 * 60 * 1000;

export type CacheOptions = {
    ttlDays: number;
    halfLifeDays: number;
    minScore: number;
    dominance: number;
};

export const DEFAULT_CACHE_OPTIONS: CacheOptions = {
    ttlDays: 14,
    halfLifeDays: 7,
    minScore: 2.5,
    dominance: 0.8,
};

export type CacheHit = { path: string; score: number; hits: number };

export function cacheOptionsFromEnv(env: Record<string, string | undefined>): CacheOptions {
    const positive = (key: string, fallback: number) => {
        const value = Number(env[key]);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return {
        ttlDays: positive("JD_CACHE_TTL_DAYS", DEFAULT_CACHE_OPTIONS.ttlDays),
        halfLifeDays: positive("JD_CACHE_HALF_LIFE_DAYS", DEFAULT_CACHE_OPTIONS.halfLifeDays),
        minScore: positive("JD_CACHE_MIN_SCORE", DEFAULT_CACHE_OPTIONS.minScore),
        dominance: DEFAULT_CACHE_OPTIONS.dominance,
    };
}

export function normalizeCacheQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\/+$/, "");
}

export function lookupCached(
    entries: HistoryEntry[],
    query: string,
    now: number,
    options: Partial<CacheOptions> = {},
): CacheHit | null {
    const { ttlDays, halfLifeDays, minScore, dominance } = { ...DEFAULT_CACHE_OPTIONS, ...options };
    if (![ttlDays, halfLifeDays, minScore, dominance].every((value) => Number.isFinite(value) && value > 0) ||
        dominance <= 0.5 || dominance > 1 || !Number.isFinite(now)) return null;
    const normalized = normalizeCacheQuery(query);
    if (!normalized) return null;
    const targets = new Map<string, CacheHit>();
    let total = 0;
    for (const entry of entries) {
        if (entry.source !== "auto" && entry.source !== "confirmed" && entry.source !== "fallback") continue;
        if (normalizeCacheQuery(entry.query) !== normalized || !Number.isFinite(entry.timestamp)) continue;
        // Clamp clock skew so a future timestamp cannot carry more than a fresh vote.
        const age = Math.max(0, now - entry.timestamp);
        if (age > ttlDays * DAY_MS) continue;
        const correction = entry.source === "confirmed" && entry.modelChoiceAccepted === false;
        const weight = (correction ? 2 : 1) * Math.pow(0.5, age / (halfLifeDays * DAY_MS));
        const target = targets.get(entry.path) ?? { path: entry.path, score: 0, hits: 0 };
        target.score += weight;
        target.hits += 1;
        targets.set(entry.path, target);
        total += weight;
    }
    for (const target of targets.values()) {
        if (target.score >= minScore && target.score / total >= dominance) return target;
    }
    return null;
}
