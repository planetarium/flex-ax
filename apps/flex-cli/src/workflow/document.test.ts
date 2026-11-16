import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AuthContext } from "../auth/index.js";
import { createDraft, registerAttachments, type DocumentPayload } from "./document.js";

const ORIGINAL_FETCH = globalThis.fetch;
const AUTH: AuthContext = {
  baseUrl: "https://flex.test",
  deviceId: "d",
  workspaceToken: "w",
  refreshToken: "r",
  customerToken: "c",
};

function payload(): DocumentPayload {
  return {
    templateKey: "tpl",
    title: "t",
    content: "",
    inputs: [],
    // submit 흐름은 업로드 직후 임시 키를 payload 에 넣은 채로 createDraft 를 부른다
    attachments: [{ fileKey: "temp-1", name: "receipt.pdf", size: 10, mimeType: "application/pdf" }],
    approvalLines: [],
    referrers: [],
    matchingData: { matchedAt: "x", matchHistoryId: "y" } as DocumentPayload["matchingData"],
    options: {},
  };
}

function capture(response: unknown): Array<{ url: string; body: any }> {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(response), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("draft attachments", () => {
  it("creates the draft without attachments (temp keys as uploaded:true are rejected with WORKFLOW_400_024)", async () => {
    const calls = capture({ draft: { document: { documentKey: "DOC1" } } });
    const { documentKey } = await createDraft(AUTH, AUTH.baseUrl, payload());
    assert.equal(documentKey, "DOC1");
    assert.deepEqual(calls[0].body.document.attachments, []);
  });

  it("registers temp keys as uploaded:false and returns the permanent keys", async () => {
    const calls = capture({
      draft: { document: { documentKey: "DOC1", attachments: [{ file: { fileKey: "perm-1", fileName: "receipt.pdf" } }] } },
    });
    const atts = await registerAttachments(AUTH, AUTH.baseUrl, "DOC1", payload());
    assert.deepEqual(calls[0].body.document.attachments, [{ name: "receipt.pdf", fileKey: "temp-1", uploaded: false }]);
    assert.equal(atts[0].permFileKey, "perm-1");
  });
});
