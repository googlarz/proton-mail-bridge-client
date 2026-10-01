// Keeps the checked-in copies of the package version in step with package.json.
// Wired to the npm "version" lifecycle, so `npm version X` updates them too. (The .mcpb build
// also stamps the version itself, but server.json is published as-is to the MCP registry.)
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

// Textual replace, not parse-and-rewrite, so the files keep their hand-written formatting and the
// diff is only the version lines.
const VERSION = /("version"\s*:\s*")[^"]*(")/g;
function stamp(path, { all }) {
  const file = new URL(path, root);
  const before = readFileSync(file, "utf8");
  let seen = 0;
  const after = before.replace(VERSION, (match, open, close) => (all || seen++ === 0 ? `${open}${version}${close}` : match));
  if (after !== before) writeFileSync(file, after);
  return (after.match(VERSION) ?? []).length;
}

stamp("mcpb/manifest.json", { all: false }); // only the top-level version
stamp("server.json", { all: true }); // the server entry and each package entry
console.log(`mcpb/manifest.json and server.json set to ${version}`);
