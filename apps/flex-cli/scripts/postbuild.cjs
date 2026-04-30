const fs = require("fs");

// Copy SQL schema to dist
fs.mkdirSync("dist/db", { recursive: true });
fs.copyFileSync("src/db/schema.sql", "dist/db/schema.sql");

// Prepend shebang to CLI entry point
const cli = "dist/cli.js";
const src = fs.readFileSync(cli, "utf8");
// Use bun shebang because the CLI imports `bun:sqlite`, which is unavailable on Node.
if (!src.startsWith("#!")) {
  fs.writeFileSync(cli, "#!/usr/bin/env bun\n" + src);
}
