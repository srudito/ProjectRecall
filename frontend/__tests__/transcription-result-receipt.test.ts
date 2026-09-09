import { deepStrictEqual as equal, strictEqual as same, throws, ok } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  RESULT_RECEIPT_NAMESPACE, MAX_RESULT_RECEIPT_BYTES, MAX_RESULT_RECEIPT_REQUEST_BYTES,
  ResultReceiptError, resultReceiptKey, parseResultReceiptKey,
  encodeTranscriptionResultReceipt, decodeTranscriptionResultReceipt, planTranscriptionResultReceipt,
  type ResultReceiptErrorCode, type ResultReceiptIdentity, type TranscriptionResultReceipt,
} from "@/src/services/transcription/result-receipt";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RECORDING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const JOB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const VERSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const OTHER = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-09-09T12:00:00.123456Z";
const LATER = "2026-09-09T12:00:00.123457Z";
const identity = (patch: Partial<ResultReceiptIdentity> = {}): ResultReceiptIdentity => ({
  userId: USER, workspaceId: WORKSPACE, sessionId: SESSION, recordingId: RECORDING, jobId: JOB, requestId: REQUEST, ...patch,
});
const receipt = (patch: Partial<TranscriptionResultReceipt> = {}): TranscriptionResultReceipt => ({
  schemaVersion: 1, kind: "result_reconciled", ...identity(), resultVersionId: VERSION,
  resultVersion: 7, contentChecksum: "a".repeat(64), expectedSegments: 2, reconciledAt: NOW, ...patch,
});
const rejected = (task: () => unknown, code: ResultReceiptErrorCode = "RESULT_RECEIPT_INVALID") =>
  throws(task, (error: unknown) => error instanceof ResultReceiptError && error.code === code);
const decodeText = (value: string) => decodeTranscriptionResultReceipt({
  key: resultReceiptKey(identity()), value, updated_at: NOW,
}, identity());

describe("C2A result receipt identity and key contract", () => {
  it("uses the approved namespace and retains all six identity dimensions", () => {
    const key = resultReceiptKey(identity());
    same(key, `${RESULT_RECEIPT_NAMESPACE}${USER}/${WORKSPACE}/${SESSION}/${RECORDING}/${JOB}/${REQUEST}`);
    equal(parseResultReceiptKey(key), identity()); ok(Object.isFrozen(parseResultReceiptKey(key)));
  });
  it("normalizes remote UUID case but preserves the opaque request ID", () => {
    const input = identity({ userId: USER.toUpperCase(), workspaceId: WORKSPACE.toUpperCase(), requestId: "Queue-Aa" });
    equal(parseResultReceiptKey(resultReceiptKey(input)), identity({ requestId: "Queue-Aa" }));
    ok(resultReceiptKey(identity({ requestId: "Queue-Aa" })) !== resultReceiptKey(identity({ requestId: "queue-aa" })));
  });
  it.each(["queue:1", "queue/1", "queue%2F1", 'queue"1', "request?key=value#1", "\u6f22\u5b57-\ud83d\ude00", "__proto__", "constructor"])(
    "round-trips delimiter-safe opaque identity %s", (requestId) => {
      const input = identity({ requestId }); const key = resultReceiptKey(input);
      same(key.slice(RESULT_RECEIPT_NAMESPACE.length).split("/").length, 6);
      same(parseResultReceiptKey(key).requestId, requestId);
      same(resultReceiptKey(parseResultReceiptKey(key)), key);
    });
  it.each(["userId", "workspaceId", "sessionId", "recordingId", "jobId", "requestId"] as const)(
    "does not collide when %s differs", (key) => ok(resultReceiptKey(identity({ [key]: OTHER })) !== resultReceiptKey(identity())));
  it.each(["", " leading", "trailing ", "with\0nul", "line\nbreak", "tab\tvalue", "del\u007fvalue", "\ud800"])(
    "rejects unsafe request ID %j without trimming or replacement", (requestId) => rejected(() => resultReceiptKey(identity({ requestId }))));
  it("enforces UTF-8 rather than just UTF-16 request length", () => {
    const fit = "\u00e9".repeat(MAX_RESULT_RECEIPT_REQUEST_BYTES / 2);
    same(parseResultReceiptKey(resultReceiptKey(identity({ requestId: fit }))).requestId, fit);
    rejected(() => resultReceiptKey(identity({ requestId: fit + "a" })), "RESULT_RECEIPT_LIMIT_EXCEEDED");
  });
  it("rejects noncanonical/malformed key spellings and unrelated namespaces", () => {
    const valid = resultReceiptKey(identity({ requestId: "a/b" }));
    for (const key of [valid.replace("%2F", "%2f"), valid + "/extra", valid + "\n", valid.replace(USER, USER.toUpperCase()),
      valid.replace("v1/", "v2/"), valid.replace("result-reconciled", "preferences"), valid.replace("a%2Fb", "%zz"),
      valid.replace("a%2Fb", "a/b"), valid.replace("a%2Fb", "%61%2Fb"), ""]) rejected(() => parseResultReceiptKey(key));
  });
  it("identifies cleanup scope from a key even when the stored JSON is damaged", () => {
    const damaged = { key: resultReceiptKey(identity()), value: "{BROKEN", updated_at: "not a timestamp" };
    equal(parseResultReceiptKey(damaged.key), identity());
    rejected(() => decodeTranscriptionResultReceipt(damaged, identity()));
    same(parseResultReceiptKey(resultReceiptKey(identity({ userId: OTHER }))).userId, OTHER);
  });
});

describe("C2A strict flat result receipt codec", () => {
  it("encodes deterministic metadata only, returns immutable values and round-trips", () => {
    const input = receipt(); const before = JSON.stringify(input); const row = encodeTranscriptionResultReceipt(input);
    same(row.updated_at, NOW); equal(decodeTranscriptionResultReceipt(row, identity()), input);
    same(JSON.stringify(input), before); ok(Object.isFrozen(row)); ok(Object.isFrozen(decodeTranscriptionResultReceipt(row, identity())));
    equal(Object.keys(JSON.parse(row.value)).sort(), ["schemaVersion", "kind", "userId", "workspaceId", "sessionId", "recordingId", "jobId",
      "requestId", "resultVersionId", "resultVersion", "contentChecksum", "expectedSegments", "reconciledAt"].sort());
    for (const field of ["plain_text", "segments", "transcription_run_id", "created_by", "is_current", "access_token", "provider_metadata"])
      same(row.value.includes(`"${field}"`), false);
  });
  it("accepts only data properties, not getters or prototypes with hidden behavior", () => {
    let called = false; const input = receipt();
    Object.defineProperty(input, "kind", { enumerable: true, get: () => { called = true; return "result_reconciled"; } });
    rejected(() => encodeTranscriptionResultReceipt(input)); same(called, false);
    rejected(() => encodeTranscriptionResultReceipt(Object.assign(Object.create({ extra: true }), receipt())));
    const hidden = Object.defineProperty(receipt(), "private", { value: "PRIVATE" });
    rejected(() => encodeTranscriptionResultReceipt(hidden));
    const symbol = { ...receipt(), [Symbol("hidden")]: "PRIVATE" }; rejected(() => encodeTranscriptionResultReceipt(symbol));
  });
  it("normalizes checksum/UUID casing and timestamp offsets with microsecond precision", () => {
    const row = encodeTranscriptionResultReceipt(receipt({ contentChecksum: "A".repeat(64),
      resultVersionId: VERSION.toUpperCase(), reconciledAt: "2026-09-09T19:00:00.123456+07:00" }));
    equal(decodeTranscriptionResultReceipt(row, identity()), receipt());
    rejected(() => decodeTranscriptionResultReceipt({ ...row, updated_at: LATER }, identity()));
  });
  it("supports complete counts beyond history admission without changing the 100,000 read cap", () => {
    for (const count of [1, 5001, 100_000]) {
      same(decodeTranscriptionResultReceipt(encodeTranscriptionResultReceipt(receipt({ expectedSegments: count })), identity()).expectedSegments, count);
    }
    rejected(() => encodeTranscriptionResultReceipt(receipt({ expectedSegments: 100_001 })));
  });
  it.each(["userId", "workspaceId", "sessionId", "recordingId", "jobId", "requestId"] as const)(
    "rejects wrong expected %s in either key or value", (field) => {
      const row = encodeTranscriptionResultReceipt(receipt()); const other = identity({ [field]: OTHER });
      rejected(() => decodeTranscriptionResultReceipt(row, other), "RESULT_RECEIPT_SCOPE_MISMATCH");
      rejected(() => decodeTranscriptionResultReceipt({ ...row, value: JSON.stringify(receipt({ [field]: OTHER })) }, identity()), "RESULT_RECEIPT_SCOPE_MISMATCH");
      rejected(() => decodeTranscriptionResultReceipt({ ...row, key: resultReceiptKey(other) }, identity()), "RESULT_RECEIPT_SCOPE_MISMATCH");
    });
  it.each<[string, unknown]>([
    ["schemaVersion", 2], ["schemaVersion", "1"], ["kind", "legacy_cache_observation"], ["resultVersionId", "not uuid"],
    ["resultVersion", 0], ["resultVersion", "7"], ["resultVersion", 1.5], ["resultVersion", 2_147_483_648],
    ["expectedSegments", 0], ["expectedSegments", "2"], ["expectedSegments", -1], ["expectedSegments", null],
    ["expectedSegments", Infinity], ["contentChecksum", null], ["contentChecksum", "z".repeat(64)],
    ["contentChecksum", "a".repeat(63)], ["reconciledAt", "2026-02-29T00:00:00Z"], ["reconciledAt", "2026-09-09"],
  ])("rejects invalid receipt field %s=%j", (field, value) => {
    const data = { ...receipt(), [field as string]: value };
    rejected(() => encodeTranscriptionResultReceipt(data as never));
    rejected(() => decodeText(JSON.stringify(data)));
  });
  it.each(["schemaVersion", "kind", "userId", "workspaceId", "sessionId", "recordingId", "jobId", "requestId",
    "resultVersionId", "resultVersion", "contentChecksum", "expectedSegments", "reconciledAt"])(
    "requires exactly one %s field", (field) => {
      const data: Record<string, unknown> = { ...receipt() }; delete data[field];
      rejected(() => decodeText(JSON.stringify(data)));
      const original = receipt() as unknown as Record<string, unknown>;
      const prefix = `{"${field}":${JSON.stringify(original[field])},`;
      rejected(() => decodeText(prefix + JSON.stringify(receipt()).slice(1)));
    });
  it("rejects escaped duplicate names before JSON parsing can overwrite them", () => {
    const text = JSON.stringify(receipt());
    rejected(() => decodeText('{"\\u0075serId":' + JSON.stringify(USER) + "," + text.slice(1)));
    rejected(() => decodeText('{"userId":' + JSON.stringify(OTHER) + "," + text.slice(1)));
    // A key appearing inside a string is NOT a duplicate property.
    const data = receipt({ requestId: 'queue:"userId":"x"' });
    equal(decodeTranscriptionResultReceipt(encodeTranscriptionResultReceipt(data), identity({ requestId: data.requestId })), data);
  });
  it("allows JSON whitespace, key order and escaped string values without allowing extra fields", () => {
    const data = receipt();
    const reordered = Object.fromEntries(Object.entries(data).reverse());
    equal(decodeText("\n\t " + JSON.stringify(reordered, null, 2) + "\r\n"), data);
    equal(decodeText(JSON.stringify(data).replace('"kind"', '"k\\u0069nd"')), data);
    rejected(() => decodeText(JSON.stringify({ ...data, extra: "PRIVATE" })));
  });
  it.each(["", "null", "false", "123", '"receipt"', "[]", "{}", "{", "{]", "{,}", "{\"kind\":null}",
    "{\"kind\":true}", "{\"kind\":{}}", "{\"kind\":[]}", "{\"kind\":\"unfinished}"])(
    "rejects malformed or non-flat JSON %s", (value) => rejected(() => decodeText(value)));
  it("rejects trailing tokens, trailing comma, BOM and unsupported numeric spellings", () => {
    const text = JSON.stringify(receipt());
    for (const value of [text + "{}", text.slice(0, -1) + ",}", "\ufeff" + text,
      text.replace('"expectedSegments":2', '"expectedSegments":2.0'),
      text.replace('"expectedSegments":2', '"expectedSegments":2e0'),
      text.replace('"expectedSegments":2', '"expectedSegments":02'),
      text.replace('"expectedSegments":2', '"expectedSegments":+2'),
      text.replace('"expectedSegments":2', '"expectedSegments":-0')]) rejected(() => decodeText(value));
  });
  it("rejects oversized metadata before parsing, including multibyte payloads", () => {
    rejected(() => decodeText(" ".repeat(MAX_RESULT_RECEIPT_BYTES + 1)), "RESULT_RECEIPT_LIMIT_EXCEEDED");
    rejected(() => decodeText("\u6f22".repeat(1500)), "RESULT_RECEIPT_LIMIT_EXCEEDED");
    rejected(() => decodeTranscriptionResultReceipt({ ...encodeTranscriptionResultReceipt(receipt()), private: "PRIVATE" }, identity()));
  });
  it("rejects escaped unpaired surrogates, controls and prototype payloads", () => {
    const text = JSON.stringify(receipt());
    for (const request of ['"\\ud800"', '"queue\\u0000id"', '"queue\\u000aid"']) {
      rejected(() => decodeText(text.replace(JSON.stringify(REQUEST), request)));
    }
    rejected(() => decodeText(text.slice(0, -1) + ',"__proto__":{"polluted":true}}'));
    same(({} as Record<string, unknown>).polluted, undefined);
  });
});

describe("C2A receipt replay planning and inactive boundary", () => {
  it("plans insert but does not claim that any transaction committed", () => {
    const result = planTranscriptionResultReceipt(null, receipt());
    same(result.kind, "insert"); equal(result.row, encodeTranscriptionResultReceipt(receipt()));
    ok(Object.isFrozen(result)); same("committed" in result, false);
  });
  it("keeps the first durable timestamp and exact row on identical retry", () => {
    const row = encodeTranscriptionResultReceipt(receipt());
    const result = planTranscriptionResultReceipt(row, receipt({ reconciledAt: LATER }));
    same(result.kind, "unchanged"); equal(result.row, row); same(result.row.updated_at, NOW);
  });
  it.each<[string, unknown]>([["resultVersionId", OTHER], ["resultVersion", 8], ["contentChecksum", "b".repeat(64)], ["expectedSegments", 3]])(
    "refuses to overwrite a receipt whose %s differs", (field, value) => {
      rejected(() => planTranscriptionResultReceipt(encodeTranscriptionResultReceipt(receipt()),
        { ...receipt(), [field as string]: value } as never), "RESULT_RECEIPT_CONFLICT");
    });
  it("does not silently replace a malformed receipt or infer success from legacy cache metadata", () => {
    rejected(() => planTranscriptionResultReceipt({ key: resultReceiptKey(identity()), value: "broken", updated_at: NOW }, receipt()));
    rejected(() => planTranscriptionResultReceipt(undefined, receipt()));
    rejected(() => encodeTranscriptionResultReceipt({ ...receipt(), runStatus: "succeeded" } as never));
  });
  it("does not infer evidence availability, currentness, auth or cleanup from a valid receipt", () => {
    const result = decodeTranscriptionResultReceipt(encodeTranscriptionResultReceipt(receipt()), identity());
    for (const key of ["available", "is_current", "cleanupVerified", "authorized", "runId", "created_by"]) same(key in result, false);
  });
  it("has no persistence/runtime API, clock, hashing or native imports", () => {
    const source = readFileSync(resolve(process.cwd(), "src/services/transcription/result-receipt.ts"), "utf8");
    equal(source.match(/^import[^;]+;/gm), ['import { normalizeTranscriptCacheInstant, normalizeTranscriptCacheUuid } from "./cache-merge";']);
    for (const forbidden of ["Date.now(", "Math.random(", "openLocalDb(", "getSupabase(", ".rpc(", "console.", "digestStringAsync("])
      same(source.includes(forbidden), false);
  });
});
