import test from "node:test";
import assert from "node:assert/strict";
import { searchKey, searchNeedles, searchIncludes, foldSearchText } from "../dist/utils/helpers.js";

test("a stored text with an umlaut is found by the plain, folded and spelled-out forms", () => {
  assert.equal(searchKey("Müller"), "muller\nmueller");
  for (const needle of ["Müller", "MÜLLER", "muller", "mueller", "Mueller"]) {
    assert.ok(searchIncludes("Herr Müller aus Köln", needle), needle);
  }
  assert.ok(searchIncludes("Herr Müller aus Köln", "koln"));
  assert.ok(searchIncludes("Herr Müller aus Köln", "koeln"));
});

test("a stored text written without umlauts is found by a query that has them", () => {
  assert.ok(searchIncludes("Mueller GmbH", "Müller"));
  assert.ok(searchIncludes("Muller GmbH", "Müller"));
});

test("plain ASCII text is not widened: Dueck is not found as duck, Samuel stays Samuel", () => {
  assert.equal(searchKey("Dueck"), "dueck");
  assert.equal(searchIncludes("Dueck", "duck"), false);
  assert.equal(searchIncludes("Samuel", "samul"), false);
  assert.ok(searchIncludes("Samuel", "samuel"));
});

test("Scandinavian letters are spelled out as pairs too", () => {
  assert.ok(searchIncludes("Søren Åberg", "soeren"));
  assert.ok(searchIncludes("Søren Åberg", "soren"));
  assert.ok(searchIncludes("Søren Åberg", "aaberg"));
  assert.ok(searchIncludes("Søren Åberg", "aberg"));
});

test("letters that are only folded keep working: ł, ß, ć, ó and decomposed input", () => {
  assert.ok(searchIncludes("Łódź Michał", "lodz"));
  assert.ok(searchIncludes("Łódź Michał", "michal"));
  assert.ok(searchIncludes("Straße", "strasse"));
  assert.ok(searchIncludes("Straße", "straße"));
  assert.ok(searchIncludes("Müller", "mueller"), "NFD-encoded umlaut");
});

test("searchNeedles gives one form for plain terms and two for terms with spelled-out letters", () => {
  assert.deepEqual(searchNeedles("invoice"), ["invoice"]);
  assert.deepEqual(searchNeedles("Müller"), ["muller", "mueller"]);
  assert.deepEqual(searchNeedles("Łódź"), [foldSearchText("Łódź")]);
});

test("a multi-word term matches as a whole in either spelling", () => {
  assert.ok(searchIncludes("Jana Müller", "jana mueller"));
  assert.ok(searchIncludes("Jana Müller", "jana muller"));
  assert.equal(searchIncludes("Jana Müller", "muller jana"), false);
});

test("a term with nothing searchable in it (only combining marks) matches nothing instead of everything", () => {
  assert.deepEqual(searchNeedles("\u0301"), []);
  assert.equal(searchIncludes("abc", "\u0301"), false);
  assert.equal(searchIncludes("", "\u0301"), false);
  assert.deepEqual(searchNeedles("e\u0301"), ["e"], "a real letter with an accent still folds to the letter");
});

test("only ä, ö, ü, ø and å get a spelled-out form; other accented letters just fold", () => {
  for (const letter of ["é", "ß", "ł", "ç", "ñ", "ć", "æ", "œ", "ā"]) {
    assert.equal(searchKey(letter).includes("\n"), false, `${letter} -> ${JSON.stringify(searchKey(letter))}`);
    assert.equal(searchNeedles(letter).length, 1, letter);
  }
  for (const letter of ["ä", "ö", "ü", "ø", "å"]) {
    assert.equal(searchNeedles(letter).length, 2, letter);
  }
});

test("the ASCII fast path gives exactly what the full folding gives", () => {
  const full = (value) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const samples = ["", "Hello World", "INVOICE-2026_03", "a@b.example", "Tab\tand\nnewline", "MiXeD 123 !@#$%^&*()", "{\"from\":[{\"name\":\"A B\",\"address\":\"a@x.com\"}]}"];
  for (const sample of samples) {
    assert.equal(foldSearchText(sample), full(sample), JSON.stringify(sample));
    assert.equal(searchKey(sample), full(sample), JSON.stringify(sample));
  }
  // One non-ASCII character takes the full path and still folds the whole string.
  assert.equal(foldSearchText("INVOICE Łódź"), "invoice lodz");
});
