import type { SupabaseClient } from "@supabase/supabase-js";

import {
  invokeRemoteTranscriptEdit,
  normalizeTranscriptEditClientError,
} from "@/src/services/transcription/edit-client";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const BASE_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const LATER_CURRENT_VERSION_ID = "55555555-5555-4555-8555-555555555555";

const authenticatedClient = (rpc: jest.Mock) =>
  ({
    auth: {
      getSession: jest.fn(async () => ({
        data: {
          session: {
            access_token: "test-access-token",
            user: { id: USER_ID },
          },
        },
        error: null,
      })),
    },
    rpc,
  }) as unknown as SupabaseClient;

describe("transcript edit RPC client", () => {
  it("invokes the authenticated immutable edit RPC with the stable client UUID", async () => {
    const rpc = jest.fn(async () => ({
      data: [
        {
          transcript_version_id: CLIENT_VERSION_ID,
          version_number: 2,
          current_version_id: CLIENT_VERSION_ID,
          was_created: true,
        },
      ],
      error: null,
    }));

    const result = await invokeRemoteTranscriptEdit(
      {
        sessionId: SESSION_ID,
        expectedCurrentVersionId: BASE_VERSION_ID,
        clientVersionId: CLIENT_VERSION_ID,
        plainText: "corrected transcript",
        expectedUserId: USER_ID,
      },
      authenticatedClient(rpc),
    );

    expect(result).toEqual({
      transcriptVersionId: CLIENT_VERSION_ID,
      versionNumber: 2,
      currentVersionId: CLIENT_VERSION_ID,
      wasCreated: true,
    });
    expect(rpc).toHaveBeenCalledWith("create_transcript_user_edit_version_v1", {
      p_session_id: SESSION_ID,
      p_expected_current_version_id: BASE_VERSION_ID,
      p_client_version_id: CLIENT_VERSION_ID,
      p_plain_text: "corrected transcript",
    });
  });

  it("accepts a late idempotent replay whose current version has moved on", async () => {
    const rpc = jest.fn(async () => ({
      data: [
        {
          transcript_version_id: CLIENT_VERSION_ID,
          version_number: 2,
          current_version_id: LATER_CURRENT_VERSION_ID,
          was_created: false,
        },
      ],
      error: null,
    }));

    await expect(
      invokeRemoteTranscriptEdit(
        {
          sessionId: SESSION_ID,
          expectedCurrentVersionId: BASE_VERSION_ID,
          clientVersionId: CLIENT_VERSION_ID,
          plainText: "corrected transcript",
          expectedUserId: USER_ID,
        },
        authenticatedClient(rpc),
      ),
    ).resolves.toMatchObject({
      transcriptVersionId: CLIENT_VERSION_ID,
      currentVersionId: LATER_CURRENT_VERSION_ID,
      wasCreated: false,
    });
  });

  it("requires the expected authenticated user before calling the RPC", async () => {
    const rpc = jest.fn();
    const client = {
      auth: {
        getSession: jest.fn(async () => ({
          data: {
            session: {
              access_token: "test-access-token",
              user: { id: LATER_CURRENT_VERSION_ID },
            },
          },
          error: null,
        })),
      },
      rpc,
    } as unknown as SupabaseClient;

    await expect(
      invokeRemoteTranscriptEdit(
        {
          sessionId: SESSION_ID,
          expectedCurrentVersionId: BASE_VERSION_ID,
          clientVersionId: CLIENT_VERSION_ID,
          plainText: "corrected transcript",
          expectedUserId: USER_ID,
        },
        client,
      ),
    ).rejects.toMatchObject({
      code: "TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED",
      retryable: true,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps the server stale-base marker to an explicit non-retryable conflict", async () => {
    const rpc = jest.fn(async () => ({
      data: null,
      error: {
        code: "P0001",
        message: "TRANSCRIPT_EDIT_BASE_CONFLICT",
        details: null,
        hint: null,
      },
    }));

    await expect(
      invokeRemoteTranscriptEdit(
        {
          sessionId: SESSION_ID,
          expectedCurrentVersionId: BASE_VERSION_ID,
          clientVersionId: CLIENT_VERSION_ID,
          plainText: "corrected transcript",
          expectedUserId: USER_ID,
        },
        authenticatedClient(rpc),
      ),
    ).rejects.toMatchObject({
      code: "TRANSCRIPT_EDIT_BASE_CONFLICT",
      retryable: false,
    });
  });

  it("does not expose unknown RPC details and treats them as retryable", () => {
    const error = normalizeTranscriptEditClientError({
      code: "XX000",
      message: "database detail that must not reach presentation",
    });
    expect(error).toMatchObject({
      code: "TRANSCRIPT_EDIT_REQUEST_FAILED",
      message: "The transcript edit could not be synchronized yet.",
      retryable: true,
    });
  });

  it("classifies network failures without leaking the raw transport message", () => {
    const error = normalizeTranscriptEditClientError(
      new TypeError("Network request failed: secret transport detail"),
    );
    expect(error).toMatchObject({
      code: "NETWORK_UNAVAILABLE",
      retryable: true,
    });
    expect(error.message).not.toContain("secret transport detail");
  });

  it("rejects malformed or mismatched RPC results", async () => {
    const malformedRpc = jest.fn(async () => ({
      data: [],
      error: null,
    }));
    await expect(
      invokeRemoteTranscriptEdit(
        {
          sessionId: SESSION_ID,
          expectedCurrentVersionId: BASE_VERSION_ID,
          clientVersionId: CLIENT_VERSION_ID,
          plainText: "corrected transcript",
          expectedUserId: USER_ID,
        },
        authenticatedClient(malformedRpc),
      ),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_EDIT_RESPONSE_INVALID" });

    const mismatchedRpc = jest.fn(async () => ({
      data: [
        {
          transcript_version_id: LATER_CURRENT_VERSION_ID,
          version_number: 2,
          current_version_id: LATER_CURRENT_VERSION_ID,
          was_created: true,
        },
      ],
      error: null,
    }));
    await expect(
      invokeRemoteTranscriptEdit(
        {
          sessionId: SESSION_ID,
          expectedCurrentVersionId: BASE_VERSION_ID,
          clientVersionId: CLIENT_VERSION_ID,
          plainText: "corrected transcript",
          expectedUserId: USER_ID,
        },
        authenticatedClient(mismatchedRpc),
      ),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_EDIT_RESPONSE_INVALID" });
  });
});
