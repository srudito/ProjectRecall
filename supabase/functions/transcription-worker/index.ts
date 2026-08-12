import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  AssemblyAITranscriptionProvider,
  type AssemblyAIRegion,
} from "../_shared/transcription/assemblyai.ts";
import type { FetchLike, TranscriptionProvider } from "../_shared/transcription/provider.ts";
import {
  constantTimeTokenMatches,
  resolvePrivilegedApiKey,
  requireServerEnvironment,
} from "../_shared/supabase/server.ts";
import { createTranscriptionWorker } from "./core.ts";
import { createTranscriptionWorkerDatabase } from "./database.ts";

const SESSION_ASSETS_BUCKET = "session-assets";
const PROVIDER_TIMEOUT_MS = 12_000;
const WORKER_TOKEN_HEADER = "x-project-recall-worker-token";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

const timeoutFetch = (timeoutMs: number): FetchLike =>
  async (input, init = {}) => {
    const controller = new AbortController();
    const existingSignal = init.signal;
    const abortFromExisting = () => controller.abort(existingSignal?.reason);
    if (existingSignal?.aborted) abortFromExisting();
    else existingSignal?.addEventListener("abort", abortFromExisting, { once: true });

    const timer = setTimeout(() => controller.abort("provider_timeout"), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      existingSignal?.removeEventListener("abort", abortFromExisting);
    }
  };

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

const adminKey = (): string | null =>
  resolvePrivilegedApiKey({
    secretKeysJson: Deno.env.get("SUPABASE_SECRET_KEYS"),
    legacyServiceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  });

const createAdminClient = (): SupabaseClient => {
  const key = adminKey();
  if (!key) throw new Error("TRANSCRIPTION_ADMIN_KEY_INVALID");
  return createClient(
    requireServerEnvironment("SUPABASE_URL", Deno.env.get("SUPABASE_URL")),
    key,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
};

const createSignedAudioUrl = (
  client: SupabaseClient,
  path: string,
  expiresInSeconds: number,
): Promise<string> =>
  client.storage
    .from(SESSION_ASSETS_BUCKET)
    .createSignedUrl(path, expiresInSeconds)
    .then(({ data, error }) => {
      if (error || !data?.signedUrl) {
        throw new Error("TRANSCRIPTION_STORAGE_SIGNING_FAILED");
      }
      return data.signedUrl;
    });

const providerFactory = (): ((input: {
  providerKey: "assemblyai";
  providerRegion: "EU" | "US";
}) => TranscriptionProvider) => {
  const instances = new Map<AssemblyAIRegion, TranscriptionProvider>();
  return ({ providerKey, providerRegion }) => {
    if (providerKey !== "assemblyai") {
      throw new Error("TRANSCRIPTION_PROVIDER_UNSUPPORTED");
    }
    const existing = instances.get(providerRegion);
    if (existing) return existing;
    const provider = new AssemblyAITranscriptionProvider({
      apiKey: Deno.env.get("ASSEMBLYAI_API_KEY") ?? "",
      region: providerRegion,
      fetchImplementation: timeoutFetch(PROVIDER_TIMEOUT_MS),
    });
    instances.set(providerRegion, provider);
    return provider;
  };
};

const verifyWorkerToken = async (request: Request): Promise<boolean> => {
  const expected = Deno.env.get("PROJECT_RECALL_TRANSCRIPTION_WORKER_TOKEN") ?? "";
  const supplied = request.headers.get(WORKER_TOKEN_HEADER) ?? "";
  if (
    expected.length < 32 ||
    expected.length > 4096 ||
    supplied.length < 32 ||
    supplied.length > 4096 ||
    /[\u0000-\u0020\u007f]/.test(expected) ||
    /[\u0000-\u0020\u007f]/.test(supplied)
  ) {
    return false;
  }
  return constantTimeTokenMatches(expected, supplied);
};

Deno.serve(async (request: Request): Promise<Response> => {
  const requestId = crypto.randomUUID();
  if (request.method !== "POST") {
    return jsonResponse({
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "Use POST to run the transcription worker.",
        retryable: false,
        requestId,
      },
    }, 405);
  }

  if (!(await verifyWorkerToken(request))) {
    return jsonResponse({
      error: {
        code: "TRANSCRIPTION_WORKER_UNAUTHORIZED",
        message: "The worker request is not authorized.",
        retryable: false,
        requestId,
      },
    }, 401);
  }

  const contentLength = request.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > 1024)
  ) {
    return jsonResponse({
      error: {
        code: "TRANSCRIPTION_WORKER_REQUEST_INVALID",
        message: "The worker request body is invalid.",
        retryable: false,
        requestId,
      },
    }, 400);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 1024) {
    return jsonResponse({
      error: {
        code: "TRANSCRIPTION_WORKER_REQUEST_INVALID",
        message: "The worker request body is invalid.",
        retryable: false,
        requestId,
      },
    }, 400);
  }
  if (rawBody.trim()) {
    try {
      const body = JSON.parse(rawBody) as unknown;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      ) {
        throw new Error("invalid");
      }
    } catch {
      return jsonResponse({
        error: {
          code: "TRANSCRIPTION_WORKER_REQUEST_INVALID",
          message: "The worker request body is invalid.",
          retryable: false,
          requestId,
        },
      }, 400);
    }
  }

  try {
    const adminClient = createAdminClient();
    const worker = createTranscriptionWorker({
      database: createTranscriptionWorkerDatabase(adminClient),
      createSignedAudioUrl: (path, expiresInSeconds) =>
        createSignedAudioUrl(adminClient, path, expiresInSeconds),
      getProvider: providerFactory(),
      checksumSha256: sha256,
      workerId: `transcription-worker:${crypto.randomUUID()}`,
    });
    const result = await worker.run();
    return jsonResponse({ ...result, requestId });
  } catch {
    console.error("[transcription-worker] safe failure", { requestId });
    return jsonResponse({
      error: {
        code: "TRANSCRIPTION_WORKER_FAILED",
        message: "The transcription worker could not finish this run.",
        retryable: true,
        requestId,
      },
    }, 500);
  }
});
