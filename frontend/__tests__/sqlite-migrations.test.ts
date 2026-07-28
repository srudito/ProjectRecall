import {
  LATEST_LOCAL_SCHEMA_VERSION,
  MIGRATIONS,
  runMigrations,
  type Migration,
  type MinimalDb,
} from "@/src/services/sqlite/migrations";

interface FakeState {
  userVersion: number;
  diagnostics: Record<string, string>;
  executed: string[];
}

const createFakeDb = (initialVersion = 0) => {
  const state: FakeState = {
    userVersion: initialVersion,
    diagnostics: {},
    executed: [],
  };

  const db = {
    execAsync: jest.fn(async (sql: string) => {
      state.executed.push(sql);
      const match = sql.match(/PRAGMA user_version\s*=\s*(\d+)/i);
      if (match) state.userVersion = Number(match[1]);
    }),
    runAsync: jest.fn(async (_sql: string, params?: unknown[]) => {
      if (params?.[0] === "schema_version") {
        state.diagnostics.schema_version = String(params[1]);
      }
      return { changes: 1 };
    }),
    getFirstAsync: jest.fn(async (sql: string) => {
      if (/PRAGMA user_version/i.test(sql)) {
        return { user_version: state.userVersion };
      }
      return null;
    }),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => {
      const snapshot = {
        userVersion: state.userVersion,
        diagnostics: { ...state.diagnostics },
        executed: [...state.executed],
      };
      try {
        await fn();
      } catch (error) {
        state.userVersion = snapshot.userVersion;
        state.diagnostics = snapshot.diagnostics;
        state.executed = snapshot.executed;
        throw error;
      }
    }),
  } as unknown as MinimalDb;

  return { db, state };
};

const migration = (
  version: number,
  up: Migration["up"] = async ({ db }) => {
    await db.execAsync(`migration-${version}`);
  },
): Migration => ({ version, description: `v${version}`, up });

describe("local SQLite migration runner", () => {
  it("applies every version after the installed user_version", async () => {
    const { db, state } = createFakeDb(0);

    const result = await runMigrations(db, [migration(1), migration(2)]);

    expect(result).toEqual({ appliedVersions: [1, 2], finalVersion: 2 });
    expect(state.userVersion).toBe(2);
    expect(state.diagnostics.schema_version).toBe("2");
  });

  it("does not apply an already installed migration twice", async () => {
    const { db, state } = createFakeDb(1);

    const result = await runMigrations(db, [migration(1), migration(2)]);

    expect(result.appliedVersions).toEqual([2]);
    expect(state.executed).not.toContain("migration-1");
    expect(state.executed).toContain("migration-2");
  });

  it("does not advance user_version when a migration fails", async () => {
    const { db, state } = createFakeDb(1);
    const failing = migration(2, async () => {
      throw new Error("migration failed");
    });

    await expect(runMigrations(db, [migration(1), failing])).rejects.toThrow(
      "migration failed",
    );
    expect(state.userVersion).toBe(1);
  });

  it("backfills project synchronization when upgrading from version 2", async () => {
    const { db, state } = createFakeDb(2);

    const result = await runMigrations(db, MIGRATIONS);

    expect(LATEST_LOCAL_SCHEMA_VERSION).toBe(3);
    expect(result).toEqual({ appliedVersions: [3], finalVersion: 3 });
    expect(
      state.executed.some((sql) => sql.includes("local_metadata_sync_queue")),
    ).toBe(true);
    expect(
      state.executed.some((sql) => sql.includes("upsert:project:")),
    ).toBe(true);
  });

  it("rejects duplicate migration versions", async () => {
    const { db } = createFakeDb(0);

    await expect(runMigrations(db, [migration(1), migration(1)])).rejects.toThrow(
      "Duplicate migration version: 1",
    );
  });
});
