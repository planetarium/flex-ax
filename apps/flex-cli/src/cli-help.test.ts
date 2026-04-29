import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCommandHelp, getTopLevelHelp, isHelpFlag } from "./cli-help.js";

describe("isHelpFlag", () => {
  it("recognizes supported help flags", () => {
    assert.equal(isHelpFlag("--help"), true);
    assert.equal(isHelpFlag("-h"), true);
    assert.equal(isHelpFlag("--version"), false);
  });
});

describe("getTopLevelHelp", () => {
  it("mentions the local-dump flow and OUTPUT_DIR guidance", () => {
    const help = getTopLevelHelp();
    assert.match(help, /login -> status -> crawl -> import -> query/);
    assert.match(help, /OUTPUT_DIR=<export-dir> flex-ax query/);
    assert.doesNotMatch(help, /Unknown command/);
  });
});

describe("getCommandHelp", () => {
  it("returns login help without command execution", () => {
    const help = getCommandHelp("login");
    assert.ok(help);
    assert.match(help, /Usage: flex-ax login/);
    assert.match(help, /password-stdin/);
  });

  it("returns query help with OUTPUT_DIR guidance", () => {
    const help = getCommandHelp("query");
    assert.ok(help);
    assert.match(help, /Usage: flex-ax query/);
    assert.match(help, /OUTPUT_DIR=<export-dir>/);
  });

  it("returns null for unknown commands", () => {
    assert.equal(getCommandHelp("missing"), null);
  });
});
