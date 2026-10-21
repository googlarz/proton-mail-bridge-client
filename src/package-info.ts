import { createRequire } from "node:module";

// The version this server reports (to MCP clients, in status and in reports), read from package.json.
const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
export const PACKAGE_VERSION = packageJson.version ?? process.env.npm_package_version ?? "0.0.0";
