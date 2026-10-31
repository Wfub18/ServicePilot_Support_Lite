const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const files = ["server.js"];
function collect(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(relative);
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(relative);
  }
}
for (const directory of ["api", "public", "scripts", "test"]) collect(directory);
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], {
    stdio: "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax OK: ${files.length} JavaScript files`);
