import { readFileSync, existsSync } from "node:fs";
import { CONFIG } from "../config.js";
import { sourcePath } from "../context-state.js";
import { listEntries } from "../storage/index.js";

const DEFAULT_POOL = ["fruits", "legumes", "animals", "tam-tams", "pirogues", "cordes", "paniers", "calebasses", "ballons", "ardoises"];

export const DOMAIN_NEIGHBORHOOD_K = Math.max(1, parseInt(process.env.TLM_DOMAIN_NEIGHBORHOOD_K ?? "3", 10) || 3);

function domainPool(): string[] {
  const p = sourcePath(CONFIG.exampleDomainsFile);
  if (existsSync(p)) { try { const raw = JSON.parse(readFileSync(p, "utf8")); if (Array.isArray(raw)) return raw.map(String); if (Array.isArray(raw?.domains)) return raw.domains.map(String); } catch {} }
  return DEFAULT_POOL;
}

export async function domainUsage() {
  const usage = new Map<string, Set<number>>();
  for (const e of await listEntries()) for (const d of e.content.exampleDomains ?? []) { const k = d.toLowerCase(); (usage.get(k) ?? usage.set(k, new Set()).get(k)!).add(e.chapter); }
  return [...usage.entries()].map(([domain, ch]) => ({ domain, chapters: [...ch].sort((a, b) => a - b) }));
}

export async function neighborhoodDomains(chapter: number, k: number = DOMAIN_NEIGHBORHOOD_K): Promise<Record<number, string[]>> {
  const result: Record<number, string[]> = {};
  for (const e of await listEntries()) {
    if (e.chapter === chapter) continue;
    const domains = e.content.exampleDomains ?? [];
    if (domains.length === 0) continue;
    if (Math.abs(e.chapter - chapter) <= k) {
      const existing = result[e.chapter];
      if (existing) {
        const set = new Set(existing);
        for (const d of domains) if (!set.has(d)) existing.push(d);
      } else {
        result[e.chapter] = [...domains];
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
