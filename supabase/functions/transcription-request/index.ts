import { createClient } from "@supabase/supabase-js";

import {
  resolvePublishableApiKey,
  requireServerEnvironment,
} from "../_shared/supabase/server.ts";
import {
  normalizeTranscriptionRequestError,
  parseTranscriptionRequestBody,
  parseTranscriptionRequestResult,
  TranscriptionRequestError,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

const bearerToken = (request: Request): string => {
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  const token = match?.[1] ?? "";
  if (
    !token ||
    token.length > 4096 ||
    !/^[A-Za-z0-9._-]+$/.test(token)
  ) {
    throw new TranscriptionRequestError(
      "TRANSCRIPTION_AUTHENTICATION_REQUIRED",
      "Sign in again before requesting a transcript.",
      { status: 401, retryable: true },
    );
  }
  return token;
};

Deno.serve(async (request: Request): Promise<Response> => {
  const requestId = crypto.randomUUID();

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse(
      {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Use POST to request transcription.",
          retryable: false,
          requestId,
        },
      },
      405,
    );
  }

  try {
    const accessToken = bearerToken(request);
    const contentLength = request.headers.get("Content-Length");
    if (
      contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > 4096)
    ) {
      throw new TranscriptionRequestError(
        "TRANSCRIPTION_REQUEST_INVALID",
        "Provide one synchronized recording to transcribe.",
        { status: 400 },
      );
    }

    const rawBody = await request.text();
    const rawBodyBytes = new TextEncoder().encode(rawBody).byteLength;
    if (rawBodyBytes === 0 || rawBodyBytes > 4096) {
      throw new TranscriptionRequestError(
        "TRANSCRIPTION_REQUEST_INVALID",
        "Provide one synchronized recording to transcribe.",
        { status: 400 },
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody) as unknown;
    } catch {
      throw new TranscriptionRequestError(
        "TRANSCRIPTION_REQUEST_INVALID",
        "Provide one synchronized recording to transcribe.",
        { status: 400 },
      );
    }
    const body = parseTranscriptionRequestBody(parsedBody);
    const supabaseUrl = requireServerEnvironment(
      "SUPABASE_URL",
      Deno.env.get("SUPABASE_URL"),
    );
    const publishableKey = resolvePublishableApiKey({
      publishableKeysJson: Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"),
      publishableKey: Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
      legacyAnonKey: Deno.env.get("SUPABASE_ANON_KEY"),
    });
    if (!publishableKey) {
      throw new TranscriptionRequestError(
        "TRANSCRIPTION_REQUEST_FAILED",
        "The transcription request could not be created. Try again later.",
        { status: 503, retryable: true },
      );
    }

    const client = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });

    const response = await client.rpc("request_transcription_job", {
      p_recording_id: body.recordingId,
    });
    if (response.error) {
      throw normalizeTranscriptionRequestError(response.error);
    }

    const result = parseTranscriptionRequestResult(response.data);
    return jsonResponse({ ...result, requestId }, 202);
  } catch (error) {
    const normalized = normalizeTranscriptionRequestError(error);
    if (!(error instanceof TranscriptionRequestError)) {
      console.error("[transcription-request] safe failure", { requestId });
    }
    return jsonResponse(
      {
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
          requestId,
        },
      },
      normalized.status,
    );
  }
});
