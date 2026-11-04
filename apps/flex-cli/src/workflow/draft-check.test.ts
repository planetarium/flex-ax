import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDraftForSubmit, sameFieldValue, type DraftDetail } from "./draft-check.js";

const payload = {
  templateKey: "tpl1",
  title: "포털 NCG 전송요청",
  inputs: [
    { inputFieldIdHash: "f-purpose", value: JSON.stringify(["데일리 리워드 충전 (150만 NCG)", "아레나 상금 (50만 NCG)"]) },
    { inputFieldIdHash: "f-etc", value: "" },
    { inputFieldIdHash: "f-total", value: "2000000" },
    { inputFieldIdHash: "f-due", value: "2026-11-07" },
  ],
};

function detail(over: Partial<NonNullable<DraftDetail["document"]>> = {}, values: Record<string, string> = {}): DraftDetail {
  const base: Record<string, string> = {
    "f-purpose": '["데일리 리워드 충전 (150만 NCG)","아레나 상금 (50만 NCG)"]',
    "f-etc": "",
    "f-total": "2000000",
    "f-due": "2026-11-07",
    ...values,
  };
  return {
    document: {
      documentKey: "doc1",
      code: "",
      templateKey: "tpl1",
      status: "DRAFT",
      title: "포털 NCG 전송요청",
      inputs: Object.entries(base).map(([id, value]) => ({ value, inputField: { idHash: id, name: `name-${id}` } })),
      ...over,
    },
  };
}

describe("checkDraftForSubmit", () => {
  it("passes an untouched draft", () => {
    assert.deepEqual(checkDraftForSubmit(detail(), payload), { ok: true });
  });

  it("refuses an already submitted document (code or status)", () => {
    const byCode = checkDraftForSubmit(detail({ code: "2026-123" }), payload);
    assert.equal(byCode.ok, false);
    assert.equal(!byCode.ok && byCode.reason, "submitted");
    for (const status of ["IN_PROGRESS", "DONE", "DECLINED", "CANCELED"]) {
      const r = checkDraftForSubmit(detail({ status }), payload);
      assert.equal(!r.ok && r.reason, "submitted", status);
    }
  });

  it("refuses a different template", () => {
    const r = checkDraftForSubmit(detail({ templateKey: "other" }), payload);
    assert.equal(!r.ok && r.reason, "template");
  });

  it("refuses when the title or a field was edited in the UI", () => {
    const t = checkDraftForSubmit(detail({ title: "고친 제목" }), payload);
    assert.equal(!t.ok && t.reason, "modified");
    assert.match(!t.ok ? t.detail : "", /제목/);
    const f = checkDraftForSubmit(detail({}, { "f-total": "1500000" }), payload);
    assert.equal(!f.ok && f.reason, "modified");
    assert.match(!f.ok ? f.detail : "", /name-f-total/);
    const order = checkDraftForSubmit(
      detail({}, { "f-purpose": '["아레나 상금 (50만 NCG)","데일리 리워드 충전 (150만 NCG)"]' }),
      payload,
    );
    assert.equal(!order.ok && order.reason, "modified");
  });

  it("refuses when an extra field outside the payload has a value", () => {
    const d = detail();
    d.document!.inputs!.push({ value: "x", inputField: { idHash: "f-new", name: "새 칸" } });
    const r = checkDraftForSubmit(d, payload);
    assert.equal(!r.ok && r.reason, "modified");
    assert.match(!r.ok ? r.detail : "", /새 칸/);
  });

  it("treats a missing field in the detail as empty", () => {
    const d = detail();
    d.document!.inputs = d.document!.inputs!.filter((i) => i.inputField?.idHash !== "f-etc");
    assert.deepEqual(checkDraftForSubmit(d, payload), { ok: true });
  });
});

describe("sameFieldValue", () => {
  it("normalizes harmless serialization differences only", () => {
    assert.equal(sameFieldValue('["a", "b"]', '["a","b"]'), true);
    assert.equal(sameFieldValue("2000000.0", "2000000"), true);
    assert.equal(sameFieldValue("2,000,000", "2000000"), true);
    assert.equal(sameFieldValue("[]", ""), true);
    assert.equal(sameFieldValue(" x ", "x"), true);
    assert.equal(sameFieldValue('["a"]', '["a","b"]'), false);
    assert.equal(sameFieldValue("1500000", "2000000"), false);
    assert.equal(sameFieldValue("", "0"), false);
    assert.equal(sameFieldValue("포탈 주소 (0xabc)", "포탈 주소 (0xabd)"), false);
  });
});
