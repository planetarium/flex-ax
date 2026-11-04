import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../auth/index.js";
import { DRAFT_REFUSAL_EXIT, isMissingDocumentError, parseOpts } from "./workflow.js";

describe("workflow parseOpts", () => {
  it("reads --document-key alongside the other flags", () => {
    const opts = parseOpts(["./f.yaml", "--document-key", "doc1", "--dry-run"]);
    assert.equal(opts.documentKey, "doc1");
    assert.equal(opts.dryRun, true);
    assert.equal(opts.draft, false);
    assert.deepEqual(opts.positional, ["./f.yaml"]);
  });

  it("rejects --document-key without a value", () => {
    assert.throws(() => parseOpts(["./f.yaml", "--document-key"]), /documentKey/);
    assert.throws(() => parseOpts(["./f.yaml", "--document-key", "--dry-run"]), /documentKey/);
  });
});

describe("existing draft submit", () => {
  it("maps refusal reasons to fixed exit codes", () => {
    assert.deepEqual(DRAFT_REFUSAL_EXIT, { missing: 4, submitted: 5, template: 6, modified: 6 });
  });

  it("treats flex's 400 WORKFLOW_400_023 as a missing document", () => {
    const body = JSON.stringify({ status: 400, code: "WORKFLOW_400_023", message: "문서를 찾을 수 없습니다." });
    assert.equal(isMissingDocumentError(new HttpError(400, "GET x", body)), true);
    assert.equal(isMissingDocumentError(new HttpError(400, "GET x", JSON.stringify({ code: "WORKFLOW_400_001" }))), false);
    assert.equal(isMissingDocumentError(new HttpError(400, "GET x", "not json")), false);
  });

  it("treats 404/410 as missing and other statuses as errors", () => {
    assert.equal(isMissingDocumentError(new HttpError(404, "GET x", "")), true);
    assert.equal(isMissingDocumentError(new HttpError(410, "GET x", "")), true);
    assert.equal(isMissingDocumentError(new HttpError(500, "GET x", "")), false);
    assert.equal(isMissingDocumentError(new HttpError(401, "GET x", "")), false);
    assert.equal(isMissingDocumentError(new Error("network")), false);
  });
});
