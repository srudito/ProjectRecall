// Local SQLite schema entrypoint.
//
// The schema itself lives in `migrations.ts`. This file is only responsible
// for opening the database, enabling WAL, and running the migration engine.
//
// Rules (from spec):
//   * Use expo-sqlite for DURABLE metadata only.
//   * Never store audio/image/video/document binaries here.
//   * Never store secrets or provider keys here.

import * as SQLite from "expo-sqlite";
import { Platform } from "react-native";

import { LATEST_LOCAL_SCHEMA_VERSION, runMigrations } from "./migrations";

const DB_NAME = "project_recall.db";

// Kept for backwards-compat with any earlier reference.
export const LOCAL_SCHEMA_VERSION = LATEST_LOCAL_SCHEMA_VERSION;

let dbPromise: Promise<SQLite.SQLiteDatabase | null> | null = null;

export const openLocalDb = async (): Promise<SQLite.SQLiteDatabase | null> => {
  if (Platform.OS === "web") {
    // expo-sqlite works on web via WASM but is unreliable in this preview
    // environment. Callers must branch to remote-only behaviour on web.
    return null;
  }
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync("PRAGMA journal_mode = WAL;");
    // Overwrite deleted cell content instead of leaving it in reusable pages.
    // Account cleanup also truncates the WAL after its scoped transaction so
    // deleted private metadata is not retained in the journal.
    await db.execAsync("PRAGMA secure_delete = ON;");
    await runMigrations(db);
    return db;
  })();
  return dbPromise;
};

/**
 * Owned snapshot handle to the SAME initialized database file. The snapshot
 * manager owns setup/transaction/close, including setup failure and late open.
 * Never run migrations again or change settings on the shared writer handle.
 */
export const openLocalReadDb = async (): Promise<SQLite.SQLiteDatabase | null> => {
  const main = await openLocalDb();
  if (!main) return null;
  const read = await SQLite.openDatabaseAsync(DB_NAME, { useNewConnection: true });
  if (read === main) {
    // Do not close the application's writer if a broken adapter aliases it.
    throw new Error("A separate local read connection is required.");
  }
  return read;
};

// Test-only helper — allows unit tests to reset the memoized promise between
// runs. Not exported from the barrel.
export const __resetOpenLocalDbForTests = () => {
  dbPromise = null;
};
