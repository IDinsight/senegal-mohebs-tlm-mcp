/*
 * Store-backed context discovery: refreshAvailableContexts() reads the store's
 * namespaces and installs the parsed teaching contexts, so listAvailableContexts()
 * reports what the STORE holds rather than what the on-disk sources/ tree holds.
 * Catalog partitions are filtered out; the list is sorted.
 *
 * Cleanup matters: the installed list is a module-global snapshot, so we clear
 * it (and the injected store) after each test to avoid leaking into others.
 */
import { describe, it, expect, afterEach } from "vitest";
import { refreshAvailableContexts } from "../activate.js";
import { listAvailableContexts, setAvailableContexts } from "../context/index.js";
import { createMemoryKgStore, __setKgStoreForTest, kgNamespace } from "../kg-store/index.js";
import { catalogNamespace, SHARED_CATALOG_NAMESPACE } from "../kg-recipes/index.js";

afterEach(() => {
  setAvailableContexts(null);   // back to the disk-scan fallback
  __setKgStoreForTest(null);
});

describe("refreshAvailableContexts", () => {
  it("installs the store's curriculum namespaces as contexts, sorted, catalog excluded", async () => {
    const store = createMemoryKgStore();
    // Two curriculum namespaces (out of order) + both catalog partitions.
    await store.ensurePointer(kgNamespace("senegal", "ci", "maths"), "a");
    await store.ensurePointer(kgNamespace("nigeria", "primary-1-3", "maths"), "a");
    await store.ensurePointer(catalogNamespace("senegal"), "a");
    await store.ensurePointer(SHARED_CATALOG_NAMESPACE, "a");
    __setKgStoreForTest(store);

    await refreshAvailableContexts();

    expect(listAvailableContexts()).toEqual([
      { workspace: "nigeria", grade: "primary-1-3", subject: "maths" },
      { workspace: "senegal", grade: "ci", subject: "maths" },
    ]);
  });

  it("installs an empty list when the store has no namespaces (not the disk scan)", async () => {
    __setKgStoreForTest(createMemoryKgStore());
    await refreshAvailableContexts();
    expect(listAvailableContexts()).toEqual([]);
  });
});
