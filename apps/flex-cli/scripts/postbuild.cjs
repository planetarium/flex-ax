const fs = require("fs");

// Copy SQL schema to dist
fs.mkdirSync("dist/db", { recursive: true });
fs.copyFileSync("src/db/schema.sql", "dist/db/schema.sql");

// Prepend shebang to CLI entry point
const cli = "dist/cli.js";
const src = fs.readFileSync(cli, "utf8");
if (!src.startsWith("#!")) {
  fs.writeFileSync(cli, "#!/usr/bin/env node\n" + src);
}
