// ── ping tool + advertised-schema integration tests ─────────────────────────
// Drives the REAL assembled MCP server (buildServer) through an in-memory
// client/server transport pair, so these assert the wire-visible contract:
//   • ping is registered, returns ok, and touches NO datastore (proven by
//     wiring a storage adapter that throws on every method — ping must still
//     answer, distinguishing "transport up, store down" from "server down");
//   • list_documents ADVERTISES its inputSchema (limit/cursor/unit/type) —
//     the schema/validator divergence from live testing cannot recur.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./index.js";
import { __setStorageForTest } from "../storage/index.js";
import type { StorageAdapter } from "../types.js";

// A storage adapter whose every method rejects — if ping touched the store,
// this would surface. It never should.
const explode = (m: string) => async (): Promise<never> => { throw new Error(`store method ${m} must not be called by ping`); };
const throwingStorage: StorageAdapter = {
  listDocuments: explode("listDocuments"),
  getObjectMd5: explode("getObjectMd5"),
  downloadDocx: explode("downloadDocx"),
  createUploadUrl: explode("createUploadUrl"),
  createDownloadUrl: explode("createDownloadUrl"),
  readHistory: explode("readHistory"),
  writeHistory: explode("writeHistory"),
};

async function connectedClient(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const server = buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return client;
}

const parse = (res: { content: { type: string; text: string }[] }) => JSON.parse(res.content[0].text);

let client: Client;
beforeAll(async () => {
  __setStorageForTest(throwingStorage);
  client = await connectedClient();
});
afterAll(async () => { await client.close(); });

describe("ping (health) tool", () => {
  it("is advertised and responds ok WITHOUT touching the store", async () => {
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === "ping")).toBe(true);

    // The store adapter throws on every method; a green ping proves ping never
    // called it — exactly the diagnostic that isolates a store outage.
    const res = await client.callTool({ name: "ping", arguments: {} });
    expect(res.isError).toBeFalsy();
    const body = parse(res as { content: { type: string; text: string }[] });
    expect(body).toMatchObject({ ok: true, status: "ok", transport: "up" });
    expect(typeof body.uptimeSec).toBe("number");
    expect(typeof body.serverTime).toBe("string");
  });

  it("answers with no active context (requires none)", async () => {
    const res = await client.callTool({ name: "ping", arguments: {} });
    const body = parse(res as { content: { type: string; text: string }[] });
    // No set_context has run in this suite → activeContext is null, still ok.
    expect(body.ok).toBe(true);
    expect(body.activeContext).toBeNull();
  });
});

describe("list_documents — advertised inputSchema (single source of truth)", () => {
  it("exposes limit, cursor, unit and type as declared params", async () => {
    const tools = await client.listTools();
    const listDocs = tools.tools.find((t) => t.name === "list_documents");
    expect(listDocs).toBeDefined();
    const props = (listDocs!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    // The exact divergence from live testing: schema advertised NO properties
    // while the handler enforced a typed limit. All four must be visible now.
    // (The scope filter is `unit`, consistent with the other document tools.)
    expect(Object.keys(props).sort()).toEqual(["cursor", "limit", "type", "unit"]);
  });

  it("rejects a wrongly-typed limit at the schema boundary (validator == advertised schema)", async () => {
    // A string limit must fail validation — proving the advertised schema IS
    // the runtime validator, not a separate looser check.
    const res = await client.callTool({ name: "list_documents", arguments: { limit: "25" } as unknown as Record<string, unknown> });
    expect(res.isError).toBeTruthy();
    expect(JSON.stringify(res.content)).toMatch(/validation|expected number/i);
  });
});
