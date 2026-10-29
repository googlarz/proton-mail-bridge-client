import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runOcr, splitCommand } from "../dist/utils/ocr.js";

const posix = process.platform === "win32" ? { skip: "needs a POSIX shell for the stub programs" } : {};

function script(body, name = "fake-ocr.sh") {
  const dir = mkdtempSync(join(tmpdir(), "ocr-test-"));
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

test("splitCommand: words, quotes, no shell syntax", () => {
  assert.deepEqual(splitCommand("tesseract --psm 6"), ["tesseract", "--psm", "6"]);
  assert.deepEqual(splitCommand("  tesseract   -l  'pol eng' "), ["tesseract", "-l", "pol eng"]);
  assert.deepEqual(splitCommand('"/opt/my ocr/bin/tess" -l "eng"'), ["/opt/my ocr/bin/tess", "-l", "eng"]);
  assert.deepEqual(splitCommand("a\"b c\"d 'e\"f'"), ["ab cd", 'e"f']);
  assert.deepEqual(splitCommand('x "" y'), ["x", "", "y"]);
  assert.deepEqual(splitCommand("C:\\Tools\\tess.exe --psm 6"), ["C:\\Tools\\tess.exe", "--psm", "6"]);
  assert.deepEqual(splitCommand("echo $HOME ~ *.png `id` $(id) ; | &"), ["echo", "$HOME", "~", "*.png", "`id`", "$(id)", ";", "|", "&"]);
  assert.throws(() => splitCommand("tesseract 'oops"), /unclosed quote/);
  assert.throws(() => splitCommand("   "), /empty/);
});

test("arguments reach the program before the image file, which is followed by stdout", posix, async () => {
  const file = script('echo "n=$# first=$1 second=$2 last=$4 stdout=$5"');
  const out = await runOcr(`${file} --psm 6`, Buffer.from("x"), ".png");
  assert.match(out.text, /^n=4 first=--psm second=6 last=stdout stdout=$/);
});

test("a quoted program path with spaces and quoted arguments with spaces stay single arguments", posix, async () => {
  const file = script('echo "$1|$2|$#"', "my ocr.sh");
  const out = await runOcr(`"${file}" 'two words'`, Buffer.from("x"), ".png");
  assert.equal(out.text, "two words|" + out.text.split("|")[1] + "|3");
  assert.match(out.text.split("|")[1], /image\.png$/);
});

test("an unquoted program path that is a file and has spaces still works", posix, async () => {
  const file = script('echo "got:$#:$2"', "fake ocr's \"cmd\".sh");
  const out = await runOcr(file, Buffer.from("x"), ".png");
  assert.equal(out.text, "got:2:stdout");
});

test("shell metacharacters stay inert", posix, async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "ocr-test-")), "pwned");
  await assert.rejects(runOcr(`true; touch ${marker}`, Buffer.from("x"), ".png"), /not found/);
  await assert.rejects(runOcr(`nonexistent-ocr && touch ${marker}`, Buffer.from("x"), ".png"), /not found/);
  const echoed = await runOcr(`/bin/echo $(touch ${marker})`, Buffer.from("x"), ".png");
  assert.match(echoed.text, /^\$\(touch /);
  assert.ok(!existsSync(marker));
  const file = script('echo "$1"');
  const out = await runOcr(`${file} '$HOME;id' *`, Buffer.from("x"), ".png");
  assert.equal(out.text, "$HOME;id");
});

test("a program that ignores SIGTERM is still stopped at the timeout, and the temp image is removed", posix, async () => {
  const seen = join(mkdtempSync(join(tmpdir(), "ocr-test-")), "image-path");
  const file = script(`echo "$1" > '${seen}'\ntrap '' TERM\nexec sleep 8`);
  const start = Date.now();
  await assert.rejects(runOcr(file, Buffer.from("x"), ".png", { timeoutMs: 500 }), /longer than/);
  assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
  const image = readFileSync(seen, "utf8").trim();
  assert.match(image, /image\.png$/);
  assert.ok(!existsSync(dirname(image)), "the temporary directory is gone");
});

test("a stub that forks a background child holding stdout open is also cut at the timeout", posix, async () => {
  const file = script("trap '' TERM\nsleep 8 &\nwait");
  const start = Date.now();
  await runOcr(file, Buffer.from("x"), ".png", { timeoutMs: 500 }).catch(() => undefined);
  assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
});
