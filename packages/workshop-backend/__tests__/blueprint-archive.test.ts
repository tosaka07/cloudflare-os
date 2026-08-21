import { describe, expect, it } from "vitest";
import {
  ADMIN_CONFIG_KEY,
  BlueprintKvEnv,
  FEATURED_BLUEPRINTS_KEY,
  readBlueprintKvRecord,
} from "../src/blueprint-archive.js";

// A KV namespace that records what it was asked for, and rejects an empty key the way the real
// one does ("Key name cannot be empty."). That rejection is the point: it arrives as a runtime
// error, not as the missing-blueprint case callers handle.
function fakeKv(entries: Record<string, string> = {}) {
  const asked: string[] = [];
  const env: BlueprintKvEnv = {
    BLUEPRINTS: {
      get: async (key: string) => {
        asked.push(key);
        if (key === "") throw new Error("Key name cannot be empty.");
        return entries[key] ?? null;
      },
    },
  } as unknown as BlueprintKvEnv;
  return { env, asked };
}

const RECORD = JSON.stringify({
  metadata: { title: "Notes", created: "2026-01-01T00:00:00.000Z",
              lastUpdated: "2026-01-01T00:00:00.000Z", version: 1 },
});

describe("readBlueprintKvRecord", () => {
  it("reads a blueprint by id", async () => {
    const { env } = fakeKv({ "abc123": RECORD });
    const record = await readBlueprintKvRecord(env, "abc123");
    expect(record?.metadata.title).toBe("Notes");
    // Dates are revived rather than left as the strings JSON carries.
    expect(record?.metadata.created).toBeInstanceOf(Date);
  });

  it("treats an empty id as naming nothing, without reaching KV", async () => {
    // The agent's createGadget tool can pass one through when it has no blueprint in mind. Left
    // to reach KV it fails with "Key name cannot be empty", which tells the agent nothing it can
    // act on -- callers turn a null into "No such blueprint: ... Use listBlueprints".
    const { env, asked } = fakeKv({ "abc123": RECORD });
    expect(await readBlueprintKvRecord(env, "")).toBeNull();
    expect(asked).toEqual([]);
  });

  it("keeps the reserved keys unreadable as blueprints", async () => {
    const { env } = fakeKv({
      [FEATURED_BLUEPRINTS_KEY]: RECORD,
      [ADMIN_CONFIG_KEY]: RECORD,
    });
    expect(await readBlueprintKvRecord(env, FEATURED_BLUEPRINTS_KEY)).toBeNull();
    expect(await readBlueprintKvRecord(env, ADMIN_CONFIG_KEY)).toBeNull();
  });

  it("returns null for an id nothing was stored under", async () => {
    const { env } = fakeKv();
    expect(await readBlueprintKvRecord(env, "missing")).toBeNull();
  });
});
