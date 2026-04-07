import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseQueryArgs, applyVars, QueryArgError } from "./query.js";

describe("parseQueryArgs", () => {
  // argv[0] = node, argv[1] = script, argv[2] = "query", argv[3..] = args
  const base = ["node", "flex-ax", "query"];

  it("parses inline SQL", () => {
    const result = parseQueryArgs([...base, "SELECT * FROM users"]);
    assert.equal(result.sql, "SELECT * FROM users");
    assert.equal(result.filePath, null);
    assert.equal(result.vars.size, 0);
  });

  it("parses multi-word inline SQL", () => {
    const result = parseQueryArgs([...base, "SELECT", "*", "FROM", "users", "LIMIT", "10"]);
    assert.equal(result.sql, "SELECT * FROM users LIMIT 10");
  });

  it("parses --file option", () => {
    const result = parseQueryArgs([...base, "--file", "queries/search.sql"]);
    assert.equal(result.sql, null);
    assert.equal(result.filePath, "queries/search.sql");
  });

  it("parses --var options", () => {
    const result = parseQueryArgs([...base, "--file", "q.sql", "--var", "name=홍길동", "--var", "limit=10"]);
    assert.equal(result.filePath, "q.sql");
    assert.equal(result.vars.get("name"), "홍길동");
    assert.equal(result.vars.get("limit"), "10");
    assert.equal(result.vars.size, 2);
  });

  it("handles --var with = in value", () => {
    const result = parseQueryArgs([...base, "--file", "q.sql", "--var", "expr=a=b"]);
    assert.equal(result.vars.get("expr"), "a=b");
  });

  it("returns null sql when no args", () => {
    const result = parseQueryArgs([...base]);
    assert.equal(result.sql, null);
    assert.equal(result.filePath, null);
  });

  it("handles mixed positional and flags", () => {
    const result = parseQueryArgs([...base, "--var", "x=1", "SELECT", "1"]);
    assert.equal(result.sql, "SELECT 1");
    assert.equal(result.vars.get("x"), "1");
  });

  it("throws on --file without value", () => {
    assert.throws(
      () => parseQueryArgs([...base, "--file"]),
      (err: unknown) => err instanceof QueryArgError && /--file/.test(err.message),
    );
  });

  it("throws on --file followed by another flag", () => {
    assert.throws(
      () => parseQueryArgs([...base, "--file", "--var", "x=1"]),
      (err: unknown) => err instanceof QueryArgError && /--file/.test(err.message),
    );
  });

  it("throws on --var without value", () => {
    assert.throws(
      () => parseQueryArgs([...base, "--var"]),
      (err: unknown) => err instanceof QueryArgError && /--var/.test(err.message),
    );
  });

  it("throws on --var with invalid format", () => {
    assert.throws(
      () => parseQueryArgs([...base, "--var", "badformat"]),
      (err: unknown) => err instanceof QueryArgError && /key=value/.test(err.message),
    );
  });

  it("throws on --var with empty key", () => {
    assert.throws(
      () => parseQueryArgs([...base, "--var", "=value"]),
      (err: unknown) => err instanceof QueryArgError && /non-empty/.test(err.message),
    );
  });
});

describe("applyVars", () => {
  it("replaces single placeholder", () => {
    const result = applyVars("SELECT * FROM users WHERE name = '{{name}}'", new Map([["name", "홍길동"]]));
    assert.equal(result, "SELECT * FROM users WHERE name = '홍길동'");
  });

  it("replaces multiple placeholders", () => {
    const vars = new Map([["name", "홍길동"], ["limit", "5"]]);
    const result = applyVars("SELECT * FROM users WHERE name LIKE '%{{name}}%' LIMIT {{limit}}", vars);
    assert.equal(result, "SELECT * FROM users WHERE name LIKE '%홍길동%' LIMIT 5");
  });

  it("replaces duplicate placeholders", () => {
    const result = applyVars("{{x}} and {{x}}", new Map([["x", "1"]]));
    assert.equal(result, "1 and 1");
  });

  it("leaves unmatched placeholders as-is", () => {
    const result = applyVars("{{a}} {{b}}", new Map([["a", "1"]]));
    assert.equal(result, "1 {{b}}");
  });

  it("handles empty vars", () => {
    const result = applyVars("SELECT 1", new Map());
    assert.equal(result, "SELECT 1");
  });

  it("preserves dollar signs in values literally", () => {
    const result = applyVars("{{v}}", new Map([["v", "$& $$ $1"]]));
    assert.equal(result, "$& $$ $1");
  });
});
