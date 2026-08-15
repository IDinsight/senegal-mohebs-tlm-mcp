/*
 * Module: generation · internal
 *
 * Example-domain rotation, a CI maths capability: track which object families
 * (fruits, pirogues, …) each unit used, and suggest a fresh one so chapters
 * don't repeat — while also avoiding domains used by nearby chapters. Composed
 * into the CI maths generation context; adapters without the capability ignore it.
 */
import { readFileSync, existsSync } from "node:fs";
import { CONFIG } from "../config.js";
import { assetPath } from "../context/index.js";
import { listEntries } from "../storage/index.js";

const DEFAULT_POOL = ["fruits", "legumes", "animals", "tam-tams", "pirogues", "cordes", "paniers", "calebasses", "ballons", "ardoises"];

export const DOMAIN_NEIGHBORHOOD_K = Math.max(1, parseInt(process.env.TLM_DOMAIN_NEIGHBORHOOD_K ?? "3", 10) || 3);

function domainPool(): string[] {
  const p = assetPath(CONFIG.exampleDomainsFile);
  if (existsSync(p)) { try { const raw = JSON.parse(readFileSync(p, "utf8")); if (Array.isArray(raw)) return raw.map(String); if (Array.isArray(raw?.domains)) return raw.domains.map(String); } catch {} }
  return DEFAULT_POOL;
}

export async function domainUsage() {
  const usage = new Map<string, Set<number>>();
  // `unit` is the transitional scope-node ordinal (see HistoryEntry); an entry
  // without one can't place a chapter, so it is skipped for rotation purposes.
  for (const e of await listEntries()) { if (e.unit == null) continue; for (const d of e.content.exampleDomains ?? []) { const k = d.toLowerCase(); (usage.get(k) ?? usage.set(k, new Set()).get(k)!).add(e.unit); } }
  return [...usage.entries()].map(([domain, ch]) => ({ domain, chapters: [...ch].sort((a, b) => a - b) }));
}

export async function neighborhoodDomains(unit: number, k: number = DOMAIN_NEIGHBORHOOD_K): Promise<Record<number, string[]>> {
  const result: Record<number, string[]> = {};
  for (const e of await listEntries()) {
    if (e.unit == null || e.unit === unit) continue;   // no ordinal → can't place; skip
    const domains = e.content.exampleDomains ?? [];
    if (domains.length === 0) continue;
    if (Math.abs(e.unit - unit) <= k) {
      const existing = result[e.unit];
      if (existing) {
        const set = new Set(existing);
        for (const d of domains) if (!set.has(d)) existing.push(d);
      } else {
        result[e.unit] = [...domains];
      }
    }
  }
  return result;
}

export async function suggestFreshDomain(avoidNearby?: Record<number, string[]>) {
  const candidates = domainPool();
  const usage = new Map<string, number[]>();
  for (const u of await domainUsage()) usage.set(u.domain, u.chapters);
  if (candidates.length === 0) return null;

  const nearbySet = new Set<string>();
  if (avoidNearby) {
    for (const domains of Object.values(avoidNearby)) {
      for (const d of domains) nearbySet.add(d.toLowerCase());
    }
  }

  const unused = candidates.filter((c) => !usage.has(c.toLowerCase()) && !nearbySet.has(c.toLowerCase()));
  const used = candidates
    .filter((c) => usage.has(c.toLowerCase()) && !nearbySet.has(c.toLowerCase()))
    .map((c) => ({ domain: c, lastChapter: Math.max(...usage.get(c.toLowerCase())!) }))
    .sort((a, b) => a.lastChapter - b.lastChapter);

  if (unused.length > 0) return unused[0];
  if (used.length > 0) return used[0].domain;
  return null;
}
