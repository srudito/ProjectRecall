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

    expect(LATEST_LOCAL_SCHEMA_VERSION).toBe(9);
    expect(result).toEqual({ appliedVersions: [3, 4, 5, 6, 7, 8, 9], finalVersion: 9 });
    expect(
      state.executed.some((sql) => sql.includes("upsert:project:")),
    ).toBe(true);
  });

  it("adds session diagnostics and backfills session sync at version 4", async () => {
    const { db, state } = createFakeDb(3);

    const result = await runMigrations(db, MIGRATIONS);

    expect(result).toEqual({ appliedVersions: [4, 5, 6, 7, 8, 9], finalVersion: 9 });
    expect(
      state.executed.some((sql) =>
        sql.includes("ALTER TABLE local_sessions ADD COLUMN last_synced_at"),
      ),
    ).toBe(true);
    expect(
      state.executed.some((sql) => sql.includes("upsert:session:")),
    ).toBe(true);
    expect(
      state.executed.some((sql) => sql.includes("parent_entity_type")),
    ).toBe(true);
  });

  it("adds note, bookmark, and timeline synchronization at version 5", async () => {
    const { db, state } = createFakeDb(4);

    const result = await runMigrations(db, MIGRATIONS);

    expect(result).toEqual({ appliedVersions: [5, 6, 7, 8, 9], finalVersion: 9 });
    expect(
      state.executed.some((sql) =>
        sql.includes("ALTER TABLE local_notes ADD COLUMN last_synced_at"),
      ),
    ).toBe(true);
    expect(
      state.executed.some((sql) => sql.includes("upsert:note:")),
    ).toBe(true);
    expect(
      state.executed.some((sql) => sql.includes("upsert:bookmark:")),
    ).toBe(true);
    expect(
      state.executed.some((sql) => sql.includes("upsert:timeline_event:")),
    ).toBe(true);
    expect(
      state.executed.some((sql) => sql.includes("recording_started")),
    ).toBe(true);
  });

  it("adds durable recording upload support at version 6", async () => {
    const { db, state } = createFakeDb(5);

    const result = await runMigrations(db, MIGRATIONS);

    expect(result).toEqual({ appliedVersions: [6, 7, 8, 9], finalVersion: 9 });
    expect(
      state.executed.some((sql) =>
        sql.includes("idx_recordings_session_unique"),
      ),
    ).toBe(true);
    expect(
      state.executed.some((sql) => sql.includes("upload:recording:")),
    ).toBe(true);
    expect(
      state.executed.some((sql) => sql.includes("local_upload_queue")),
    ).toBe(true);
  });


  it("adds media evidence upload and timeline synchronization at version 7", async () => {
    const { db, state } = createFakeDb(6);

    const result = await runMigrations(db, MIGRATIONS);

    expect(result).toEqual({ appliedVersions: [7, 8, 9], finalVersion: 9 });
    expect(
      state.executed.some((sql) => sql.includes("upload:media_asset:")),
    ).toBe(true);
    expect(
      state.executed.some((sql) => sql.includes("SOURCE_MEDIA") || sql.includes("media_asset")),
    ).toBe(true);
    expect(
      state.executed.some((sql) => sql.includes("image_added")),
    ).toBe(true);
  });


  it("adds durable cloud-aware session deletion at version 8", async () => {
    const { db, state } = createFakeDb(7);

    const result = await runMigrations(db, MIGRATIONS);

    expect(result).toEqual({ appliedVersions: [8, 9], finalVersion: 9 });
    expect(
      state.executed.some((sql) =>
        sql.includes("CREATE TABLE IF NOT EXISTS local_session_deletion_queue"),
      ),
    ).toBe(true);
    expect(
      state.executed.some(
        (sql) =>
          sql.includes("UPDATE local_upload_queue") &&
          sql.includes("queue_status = 'cancelled'"),
      ),
    ).toBe(true);
    expect(
      state.executed.some((sql) =>
        sql.includes("session-delete:"),
      ),
    ).toBe(true);
  });

  it("adds per-user starred-session preferences at version 9", async () => {
    const { db, state } = createFakeDb(8);

    const result = await runMigrations(db, MIGRATIONS);

    expect(result).toEqual({ appliedVersions: [9], finalVersion: 9 });
    expect(
      state.executed.some((sql) =>
        sql.includes(
          "CREATE TABLE IF NOT EXISTS local_session_user_preferences",
        ),
      ),
    ).toBe(true);
    expect(
      state.executed.some((sql) =>
        sql.includes("idx_session_preferences_user_starred"),
      ),
    ).toBe(true);
  });

  it("rejects duplicate migration versions", async () => {
    const { db } = createFakeDb(0);

    await expect(runMigrations(db, [migration(1), migration(1)])).rejects.toThrow(
      "Duplicate migration version: 1",
    );
  });
});
