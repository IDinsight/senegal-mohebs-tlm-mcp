import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import type { CatalogExport, DisplayGraph, KgConfig, NamespaceEntry } from "../types";

// API base. Empty = same-origin (Firebase Hosting rewrites /kg → Cloud Run).
// Override with ?api=http://localhost:8791 for local/direct testing (CORS).
const API = (new URLSearchParams(location.search).get("api") || "").replace(
  /\/+$/,
  "",
);

// The Supabase client is created lazily once /kg/config says auth is required,
// then reused for every authenticated request. Module-level so token refresh and
// session lookup stay shared across the app.
let supa: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  return supa;
}

export async function fetchConfig(): Promise<KgConfig> {
  const res = await fetch(`${API}/kg/config`);
  return res.json();
}

// Build (once) the Supabase client from the server-provided config.
export function initSupabase(cfg: KgConfig): SupabaseClient {
  if (!supa && cfg.supabaseUrl && cfg.supabaseAnonKey) {
    supa = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  }
  if (!supa) throw new Error("Supabase config missing");
  return supa;
}

export async function hasSession(): Promise<boolean> {
  if (!supa) return false;
  const {
    data: { session },
  } = await supa.auth.getSession();
  return !!session;
}

// Sign in with email/password; resolves the Supabase error message on failure so
// the caller can surface it in the login form.
export async function signIn(
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!supa) return { ok: false, message: "not configured" };
  const { error } = await supa.auth.signInWithPassword({ email, password });
  return error ? { ok: false, message: error.message } : { ok: true };
}

// Bearer header from the live session (empty when auth is not in play).
async function authHeaders(): Promise<Record<string, string>> {
  if (!supa) return {};
  const {
    data: { session },
  } = await supa.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export function fetchNamespaces(): Promise<{ namespaces: NamespaceEntry[] }> {
  return apiGet("/kg/namespaces");
}

export function fetchGraph(ns: string): Promise<DisplayGraph> {
  return apiGet(`/kg?ns=${encodeURIComponent(ns)}`);
}

// The catalog libraries (shared + this namespace's workspace) for the Catalog tab.
export function fetchCatalog(ns: string): Promise<CatalogExport> {
  return apiGet(`/kg/catalog?ns=${encodeURIComponent(ns)}`);
}

// One catalog entry's full authored spec, as markdown (the tab's click-through).
export function fetchCatalogEntry(
  ns: string,
  id: string,
): Promise<{ id: string; markdown: string }> {
  return apiGet(`/kg/catalog/entry?ns=${encodeURIComponent(ns)}&id=${encodeURIComponent(id)}`);
}

// The origin we tried to reach, for error messages.
export const apiOrigin = API || location.origin;
