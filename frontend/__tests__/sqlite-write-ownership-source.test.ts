import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const repository = read("src/services/sqlite/repository.ts");
const owners = new Set(["runSerializedLocalMutation", "runSerializedLocalTransaction", "withLocalTransactionTurn"]);
const writes = new Set(["runAsync", "runSync", "execAsync", "execSync", "prepareAsync", "prepareSync", "executeAsync", "executeSync"]);
const methods = new Set([...writes, "withTransactionAsync", "withTransactionSync", "withExclusiveTransactionAsync",
  "openDatabaseAsync", "openDatabaseSync", "deleteDatabaseAsync", "deleteDatabaseSync", "backupDatabaseAsync"]);

// Locked operation boundaries, not individual SQL statements. OnDb helpers are
// deliberately absent: their caller already owns the turn.
const standalone = [
  "upsertSession", "updateSessionSyncStatus", "softDeleteSession", "upsertSessionUserPreference",
  "updateSessionUserPreferenceSyncStatus", "upsertProject", "updateProjectSyncStatus", "upsertNote",
  "upsertBookmark", "upsertTimelineEvent", "updateContentSyncStatus", "upsertRecording",
  "updateRecordingUploadStatus", "upsertMediaAsset", "updateMediaAssetUploadStatus", "enqueueUpload",
  "claimUploadOperation", "rescheduleUploadOperation", "markUploadOperationFailed", "deleteCompletedUploadOperation",
  "deleteUploadOperationsForEntity", "resetInProgressUploadOperations", "requeueUploadOperationForEntity",
  "saveTranscriptEditDraft", "deleteTranscriptEditDraft", "upsertTranscriptionRequestIntent", "claimTranscriptionRequest",
  "deferTranscriptionRequest", "rescheduleTranscriptionRequest", "markTranscriptionRequestSubmitted",
  "markTranscriptionRequestFailed", "markTranscriptionRequestCancelled", "resetSubmittingTranscriptionRequests",
  "rescheduleTranscriptionResultAfterFailure", "setPreference", "enqueueMetadataSync", "markMetadataOperationSucceeded",
  "markMetadataOperationFailed", "rescheduleMetadataOperation", "deferMetadataOperationForDependency",
  "deleteCompletedMetadataOperation", "resetInProgressMetadataOperations", "deleteMetadataOperationsForEntity",
  "requeueMetadataOperationForEntity", "resetInProgressSessionDeletions", "updateSessionDeletionProgress",
  "deleteCompletedSessionDeletion",
];

type Fn = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;
type Bindings = Map<string, Fn>;
const functionNode = (node: ts.Node | undefined): node is Fn => !!node &&
  (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node));

/** Conservative call graph over the repository, including higher-order OnDb callbacks. */
const audit = (source: string) => {
  const file = ts.createSourceFile("repository.ts", source, ts.ScriptTarget.Latest, true);
  const functions = new Map<string, Fn>();
  const exports: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !functionNode(declaration.initializer)) continue;
      functions.set(declaration.name.text, declaration.initializer);
      if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) exports.push(declaration.name.text);
    }
  }
  const errors: string[] = [];
  const covered = new Set<number>();
  const seen = new Set<string>();
  const resolveFn = (node: ts.Node | undefined, bindings: Bindings): Fn | undefined => {
    if (functionNode(node)) return node;
    if (node && ts.isIdentifier(node)) return bindings.get(node.text) ?? functions.get(node.text);
    return undefined;
  };
  const mutation = (node: ts.CallExpression): boolean => {
    if (ts.isPropertyAccessExpression(node.expression) && writes.has(node.expression.name.text)) return true;
    if (ts.isElementAccessExpression(node.expression) && ts.isStringLiteral(node.expression.argumentExpression) &&
        writes.has(node.expression.argumentExpression.text)) return true;
    if (ts.isPropertyAccessExpression(node.expression) && /^get(First|All|Each)Async$/.test(node.expression.name.text)) {
      const sql = node.arguments[0];
      if (!sql || (!ts.isStringLiteral(sql) && !ts.isNoSubstitutionTemplateLiteral(sql) && !ts.isTemplateExpression(sql))) return true;
      return /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|REINDEX|ATTACH|DETACH|PRAGMA)\b/i.test(sql.getText(file));
    }
    return false;
  };
  const visitFunction = (fn: Fn, owned: boolean, bindings: Bindings): void => {
    const key = `${fn.pos}:${owned}:${[...bindings].map(([k, v]) => `${k}:${v.pos}`).sort().join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (fn.body) walk(fn.body, owned, bindings);
  };
  const walk = (node: ts.Node, owned: boolean, bindings: Bindings): void => {
    // Function bodies execute only when called, not at their definition site.
    if (functionNode(node)) return;
    if (ts.isPropertyAccessExpression(node) && writes.has(node.name.text) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
      errors.push(`SQL_METHOD_ALIAS_REQUIRES_REVIEW:${node.name.text}`);
    }
    if (ts.isBindingElement(node) && writes.has((node.propertyName ?? node.name).getText(file))) {
      errors.push("SQL_METHOD_DESTRUCTURE_REQUIRES_REVIEW");
    }
    if (!ts.isCallExpression(node)) { ts.forEachChild(node, (child) => walk(child, owned, bindings)); return; }
    const name = node.expression.getText(file);
    if (mutation(node)) {
      covered.add(node.pos);
      if (!owned) errors.push(`UNOWNED:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}:${name}`);
    }
    if (owners.has(name)) {
      if (owned) errors.push(`NESTED_OWNER:${name}`);
      const callback = resolveFn(node.arguments[node.arguments.length - 1], bindings);
      if (!callback) errors.push(`UNKNOWN_OWNER_CALLBACK:${name}`);
      else visitFunction(callback, true, bindings);
      return;
    }
    const target = resolveFn(node.expression, bindings);
    if (target) {
      const next = new Map(bindings);
      for (let index = 0; index < target.parameters.length; index += 1) {
        const parameter = target.parameters[index];
        const callback = resolveFn(node.arguments[index], bindings);
        if (callback && ts.isIdentifier(parameter.name)) next.set(parameter.name.text, callback);
      }
      visitFunction(target, owned, next);
    } else {
      // Unknown library callbacks cannot create write ownership. Inspect them
      // under the current ownership, so a future hidden mutation fails closed.
      for (const argument of node.arguments) {
        const callback = resolveFn(argument, bindings);
        if (callback) visitFunction(callback, owned, bindings);
        else walk(argument, owned, bindings);
      }
    }
  };
  for (const name of exports) visitFunction(functions.get(name)!, false, new Map());
  const allWrites: number[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && mutation(node)) allWrites.push(node.pos);
    ts.forEachChild(node, collect);
  };
  collect(file);
  for (const position of allWrites) if (!covered.has(position)) errors.push(`UNREACHABLE_WRITE_REQUIRES_REVIEW:${position}`);
  return { errors, writes: allWrites.length, functions, file };
};

const runtimeFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? runtimeFiles(path) : /\.[jt]sx?$/.test(entry.name) ? [path] : [];
});

describe("3E.2B2C1 complete shared-write ownership census", () => {
  it("owns every reachable mutation once, including internal helpers and the WAL checkpoint", () => {
    const result = audit(repository);
    expect(result.errors).toEqual([]);
    expect(result.writes).toBeGreaterThan(100);
    expect(repository).toContain('runSerializedLocalMutation(db, () => db.getFirstAsync<');
  });
  it("keeps all 47 standalone mutation roots behind one operation-level turn", () => {
    const { functions, file } = audit(repository);
    expect(standalone).toHaveLength(47);
    for (const name of standalone) {
      const source = functions.get(name)!.getText(file);
      expect(source.match(/runSerializedLocalMutation\(db,/g)).toHaveLength(1);
      expect(source).not.toContain("runSerializedLocalTransaction(");
      expect(source.indexOf("openLocalDb()")).toBeLessThan(source.indexOf("runSerializedLocalMutation(db,"));
    }
  });
  it.each(["runAsync", "execAsync", "prepareAsync"])("detects a future direct %s bypass rather than trusting function names", (method) => {
    expect(audit(`${repository}\nexport const bypass = async () => { await db.${method}("UPDATE local_preferences SET value = 1"); };`)
      .errors.some((error) => error.startsWith("UNOWNED:"))).toBe(true);
  });
  it("detects mutations hidden behind a query API, computed call, or aliased method", () => {
    for (const source of [
      'export const x = async () => db.getFirstAsync("UPDATE local_sessions SET status = 1 RETURNING id");',
      'export const x = async () => db["runAsync"]("UPDATE x");',
      'export const x = async () => { const write = db.runAsync; return write("UPDATE x"); };',
      'export const x = async () => { const {runAsync} = db; return runAsync("UPDATE x"); };',
    ]) expect(audit(source).errors.length).toBeGreaterThan(0);
  });
  it("detects nested ownership and an unguarded helper callback", () => {
    expect(audit('export const x = async () => runSerializedLocalMutation(db, async () => withLocalTransactionTurn(async () => db.runAsync("UPDATE x")));')
      .errors).toContain("NESTED_OWNER:withLocalTransactionTurn");
    const source = 'const helper = async (operation) => operation(db); export const x = async () => helper(async (db) => db.runAsync("UPDATE x"));';
    expect(audit(source).errors.some((error) => error.startsWith("UNOWNED:"))).toBe(true);
  });
  it("does not permit runtime SQLite access outside the six reviewed modules", () => {
    const allowed = new Set(["schema.ts", "migrations.ts", "repository.ts", "history-cache.ts", "read-snapshot.ts", "transaction.ts"]
      .map((name) => `src/services/sqlite/${name}`));
    const found = new Set<string>(); const violations: string[] = [];
    for (const path of [...runtimeFiles(resolve(root, "app")), ...runtimeFiles(resolve(root, "src"))]) {
      const name = relative(root, path).split("\\").join("/");
      const text = readFileSync(path, "utf8"); const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        const sdkImport = ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("expo-sqlite");
        const nativeCall = (ts.isPropertyAccessExpression(node) && methods.has(node.name.text)) ||
          (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && methods.has(node.argumentExpression.text)) ||
          (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && methods.has(node.expression.text)) ||
          (ts.isBindingElement(node) && methods.has((node.propertyName ?? node.name).getText(file)));
        const rawLoad = ts.isCallExpression(node) && node.arguments.some((arg) => ts.isStringLiteral(arg) && arg.text.startsWith("expo-sqlite"));
        if (sdkImport || nativeCall || rawLoad) {
          found.add(name); if (!allowed.has(name)) violations.push(name);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(violations).toEqual([]);
    expect([...found].sort()).toEqual([...allowed].sort());
  });
  it("keeps initialization and query-only readers outside the write lane", () => {
    const schema = read("src/services/sqlite/schema.ts"); const snapshots = read("src/services/sqlite/read-snapshot.ts");
    expect(schema).toContain("if (dbPromise) return dbPromise;");
    expect(schema).toContain("await runMigrations(db);");
    expect(schema).not.toContain("withLocalTransactionTurn");
    expect(snapshots).toContain("PRAGMA query_only = ON");
    expect(snapshots).not.toContain("runSerializedLocalMutation");
    expect(snapshots).not.toContain("retainLocalWriteRecovery");
  });
});
