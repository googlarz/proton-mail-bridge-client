import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fetchTarballSha256, renderFormula, tarballUrl } from "../scripts/homebrew-formula.mjs";

const fakeFetch = (body, status = 200) => async (url) => {
  fakeFetch.lastUrl = url;
  return { ok: status === 200, status, arrayBuffer: async () => Buffer.from(body) };
};

test("the sha256 is computed from the downloaded tarball bytes", async () => {
  const sha = await fetchTarballSha256("2.3.2", fakeFetch("tarball-bytes"));
  assert.equal(sha, createHash("sha256").update("tarball-bytes").digest("hex"));
  assert.equal(fakeFetch.lastUrl, tarballUrl("2.3.2"));
  assert.match(sha, /^[0-9a-f]{64}$/);
});

test("an unpublished version or a malformed version is an error", async () => {
  await assert.rejects(fetchTarballSha256("9.9.9", fakeFetch("", 404)), /HTTP 404/);
  await assert.rejects(fetchTarballSha256("latest", fakeFetch("")), /Expected a version/);
});

test("renderFormula fills url, sha256 and the test version, and refuses a 40-char sha", () => {
  const sha256 = "a".repeat(64);
  const formula = renderFormula({ version: "2.3.2", sha256 });
  assert.ok(formula.includes(`url "${tarballUrl("2.3.2")}"`));
  assert.ok(formula.includes(`sha256 "${sha256}"`));
  assert.ok(formula.includes('assert_match "2.3.2", output'));
  assert.ok(formula.includes('depends_on "node"'));
  assert.match(formula, /Node >= 24/);
  assert.throws(() => renderFormula({ version: "2.3.2", sha256: "a".repeat(40) }), /64 hex/);
});

test("the in-repo formula copy is internally consistent with a valid sha256", () => {
  // Not pinned to package.json: the copy is regenerated per release (see RELEASING.md), and a
  // version bump must not turn this suite red before the tarball is even published.
  const copy = readFileSync(new URL("../homebrew/proton-mail-bridge-client.rb", import.meta.url), "utf8");
  assert.match(copy, /sha256 "[0-9a-f]{64}"/);
  const urlVersion = copy.match(/proton-mail-bridge-client-(\d+\.\d+\.\d+)\.tgz/)?.[1];
  assert.ok(urlVersion, "url names a version");
  assert.ok(copy.includes(`assert_match "${urlVersion}", output`), "test block asserts the url's version");
});
