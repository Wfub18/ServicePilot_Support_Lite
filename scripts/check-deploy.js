// No compilation is needed: public/ is the existing Vercel output directory.
// Validate the actual files and references, without writing or deploying them.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(config.framework, null);
assert.equal(config.buildCommand, "", "Static app must not need a compilation step");
assert.equal(config.installCommand, "");
assert.equal(config.outputDirectory, "public");
assert.equal(pkg.engines.node, "24.x");
for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
  assert.equal(Object.keys(pkg[group] || {}).length, 0,
    "Dependencies require reviewing installation and Vercel configuration");
}
assert.ok(config.functions["api/chat.js"], "Vercel API function must be configured");

const publicRoot = path.join(root, "public");
const assets = ["app.js", "favicon.svg", "index.html", "styles.css"];
assert.deepEqual(fs.readdirSync(publicRoot).sort(), assets,
  "Review the public asset allowlist before publishing additional files");
for (const asset of assets) {
  const stat = fs.lstatSync(path.join(publicRoot, asset));
  assert.ok(stat.isFile() && stat.size > 0, `Missing, empty or non-regular asset: ${asset}`);
}

let references = 0;
function checkReference(reference) {
  if (reference.startsWith("#")) return;
  const url = new URL(reference, "https://static.invalid/");
  assert.equal(url.origin, "https://static.invalid", "Frontend assets must be self-hosted");
  const relative = decodeURIComponent(url.pathname).slice(1);
  assert.ok(assets.includes(relative), `Reference outside published assets: ${reference}`);
  references++;
}
const html = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
  checkReference(match[1]);
}
assert.match(html, /<script\b[^>]*\bsrc=["']\/app\.js["']/i);
assert.match(html, /<link\b[^>]*\bhref=["']\/styles\.css["']/i);
assert.match(html, /<link\b[^>]*\bhref=["']\/favicon\.svg["']/i);
const css = fs.readFileSync(path.join(publicRoot, "styles.css"), "utf8");
for (const match of css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) {
  checkReference(match[1]);
}

// Importing the handler must work without opening a server or calling a provider.
global.fetch = async () => { throw new Error("External network disabled in deploy check"); };
assert.equal(typeof require(path.join(root, "api/chat.js")), "function");
console.log(`Deploy readiness OK: ${assets.length} static assets, ${references} local references, API handler loads`);
