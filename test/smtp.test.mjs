import test from "node:test";
import assert from "node:assert/strict";
import { applySignature, sanitizeHeader, SMTPService } from "../dist/services/smtp-service.js";

test("sanitizeHeader replaces CR and LF with spaces", () => {
  assert.equal(sanitizeHeader("hello\r\nBcc: evil"), "hello  Bcc: evil");
});

test("sanitizeHeader leaves normal headers unchanged", () => {
  assert.equal(sanitizeHeader("normal subject"), "normal subject");
});

function createConfig() {
  return {
    smtp: {
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      username: "owner@example.com",
      password: "secret",
    },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "secret" },
    dataDir: "/tmp/protonmail-pro-mcp-test",
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: {
      readOnly: false,
      allowSend: true,
      allowRemoteDraftSync: true,
      allowedActions: [],
      startupSync: false,
      autoSyncFolder: "INBOX",
      autoSyncFull: false,
      autoSyncLimitPerFolder: 25,
      idleWatchEnabled: false,
      idleMaxSeconds: 30,
      confirmDestructive: false,
      allowEmptyFolder: false,
      restrictOutboundToSelf: false,
      allowFileDownloadDir: undefined,
      maxInlineBytes: 40960,
      opDelayMs: 0,
    },
  };
}

// buildRawMessage compiles a full RFC822 message locally via nodemailer's
// MailComposer — no network/transporter involved, so it's a safe way to
// exercise buildMailOptions' header-sanitization and HTML-sanitization
// logic without a live SMTP connection.
test("buildRawMessage neutralizes CRLF header injection from subject and fromName", async () => {
  // sanitizeHeader replaces CR/LF with a space rather than deleting the text, so the
  // injected text still appears — the security property is that it stays confined
  // inside the Subject:/From: line and never becomes its own standalone MIME header.
  const service = new SMTPService(createConfig());
  const raw = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "Hello\r\nBcc: attacker@evil.com",
    fromName: "Attacker\r\nX-Injected: true",
    body: "plain text body",
  });
  const headerBlock = raw.toString("utf8").split("\r\n\r\n")[0];
  const headerLines = headerBlock.split("\r\n");

  assert.ok(!headerLines.some((line) => /^bcc:/i.test(line.trim())));
  assert.ok(!headerLines.some((line) => /^x-injected:/i.test(line.trim())));
  assert.ok(headerLines.some((line) => /^subject: hello/i.test(line.trim())));
});

// Proton Bridge is logged in as one address, but the account can have other
// verified addresses/aliases; Proton's outgoing MTA accepts a From header set to
// any of them regardless of Bridge's login identity — this lets a caller pick one.
test("buildRawMessage sends as the caller's from address instead of the Bridge login when provided", async () => {
  const service = new SMTPService(createConfig());
  const raw = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "Hi",
    body: "plain text body",
    from: "owner@pm.me",
  });
  const headerBlock = raw.toString("utf8").split("\r\n\r\n")[0];
  assert.ok(/^from: owner@pm\.me/im.test(headerBlock));
  assert.ok(!headerBlock.toLowerCase().includes("owner@example.com"));
});

test("buildRawMessage falls back to the Bridge login when from is omitted", async () => {
  const service = new SMTPService(createConfig());
  const raw = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "Hi",
    body: "plain text body",
  });
  const headerBlock = raw.toString("utf8").split("\r\n\r\n")[0];
  assert.ok(/^from: owner@example\.com/im.test(headerBlock));
});

test("buildRawMessage falls back to the Bridge login when from is not a valid email address", async () => {
  const service = new SMTPService(createConfig());
  const raw = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "Hi",
    body: "plain text body",
    from: "not-an-email",
  });
  const headerBlock = raw.toString("utf8").split("\r\n\r\n")[0];
  assert.ok(/^from: owner@example\.com/im.test(headerBlock));
});

// Regression test for an externally-reported bug (review of 7c36bae / v2.1.3): a
// signature with an inline logo (attached with a Content-ID, referenced as
// <img src="cid:...">) survived as an attachment, but its <img> tag was stripped
// entirely by the sanitizer — img wasn't in allowedTags at all — so the logo never
// displayed. Now allowed, but ONLY for the cid: scheme (via allowedSchemesByTag) —
// not http/https, since this sanitizes OUTBOUND content and an http(s) img src
// could let a prompt-injected signature/quoted-original exfiltrate data through
// the URL when the recipient's client loads it.
test("buildRawMessage keeps an inline <img src=\"cid:...\"> (e.g. a signature logo) but strips an http(s) img src", async () => {
  const service = new SMTPService(createConfig());
  const raw = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "Logo test",
    body: "fallback text",
    isHtml: true,
    htmlBody: '<p>Best,</p><img src="cid:logo123" alt="Logo"><img src="http://evil.example.com/track.png">',
    attachments: [
      { filename: "logo.png", content: Buffer.from("fake-png-bytes").toString("base64"), contentType: "image/png", cid: "logo123", contentDisposition: "inline" },
    ],
  });
  const message = raw.toString("utf8");

  assert.ok(message.includes('src="cid:logo123"'), "an inline cid: image reference must survive sanitization");
  assert.ok(!message.includes("evil.example.com"), "an http(s) image src must still be stripped");
});

// Regression test for an externally-reported bug (second-pass review of a292ab6 /
// v2.1.5): allowedSchemesByTag only inspects a URL that HAS an explicit scheme — a
// protocol-relative URL like "//tracking.example/pixel?token=..." has none, so
// sanitize-html's own default (allowProtocolRelative: true) let it straight
// through even with img scoped to "cid" — reopening the exact remote-image
// exfiltration risk that restriction exists to close.
test("buildRawMessage strips a protocol-relative img src just like an http(s) one", async () => {
  const service = new SMTPService(createConfig());
  const raw = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "Tracking pixel test",
    body: "fallback text",
    isHtml: true,
    htmlBody: '<p>Best,</p><img src="//tracking.example/pixel?token=fixture">',
  });
  const message = raw.toString("utf8");

  assert.ok(!message.includes("tracking.example"), "a protocol-relative image src must be stripped, not silently allowed through");
});

test("buildRawMessage sanitizes script tags out of HTML bodies by default", async () => {
  const service = new SMTPService(createConfig());
  const raw = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "HTML test",
    body: "fallback text",
    isHtml: true,
    htmlBody: '<p>hello</p><script>alert("xss")</script>',
  });
  const message = raw.toString("utf8");

  assert.ok(!message.includes("<script>"));
  assert.ok(message.includes("hello"));
});

// Regression test: when isHtml is true and the caller does NOT supply a separate
// htmlBody, `body` IS the HTML source (the normal send_email/reply/forward/send_draft
// shape). buildMailOptions used to pass that raw, PRE-sanitization body straight through
// as the text/plain alternative part — so a script tag or javascript: link the HTML
// sanitizer had just stripped out of the html part still reached any plain-text-preferring
// client (or a quoted reply, or an MCP consumer reading `text`) completely intact, and
// every plain-text recipient saw literal HTML markup instead of readable text.
test("buildRawMessage does not leak raw pre-sanitization HTML into the text/plain part", async () => {
  const service = new SMTPService(createConfig());
  const raw = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "HTML test",
    body: '<p>Hi</p><script>alert(1)</script><a href="javascript:evil()">x</a>',
    isHtml: true,
    // no htmlBody — body itself is the HTML source.
  });
  const message = raw.toString("utf8");

  assert.ok(!message.includes("<script>"), "the disallowed script tag must not appear anywhere in the raw message");
  assert.ok(!message.includes("javascript:"), "the disallowed javascript: URI must not appear anywhere in the raw message");
  // "<p>Hi</p>" legitimately appears once, inside the html part — the bug was the text/plain
  // part carrying it too (twice total). A single occurrence proves the text part converted it.
  const pTagOccurrences = message.split("<p>Hi</p>").length - 1;
  assert.equal(pTagOccurrences, 1, "literal HTML tags must appear only in the html part, not duplicated into text/plain");
  assert.ok(message.includes("Hi"), "the readable text content must survive the conversion");
});

test("buildRawMessage still uses the caller's real plain text when htmlBody is supplied separately", async () => {
  // No-regression check for the sibling case the fix must NOT touch: when htmlBody is
  // explicit, `body` is genuine author-provided plain text and must pass through unchanged.
  const service = new SMTPService(createConfig());
  const raw = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "Separate plain text",
    body: "Plain text fallback, unrelated to the HTML below.",
    isHtml: true,
    htmlBody: "<p>Hello</p>",
  });
  const message = raw.toString("utf8");

  assert.ok(message.includes("Plain text fallback, unrelated to the HTML below."));
});

// Regression test for the "buildMailOptions can silently send a completely
// empty-body email" bug: when isHtml is true and sanitization strips the body
// down to nothing, the send must fail loudly rather than deliver a blank email
// (html: "" and text: undefined) with no signal to the caller.
test("buildRawMessage throws when HTML body sanitizes down to nothing", async () => {
  const service = new SMTPService(createConfig());
  await assert.rejects(
    () =>
      service.buildRawMessage({
        to: ["victim@example.com"],
        subject: "Empty after sanitization",
        body: "<script>alert(1)</script>",
        isHtml: true,
      }),
    /empty after removing disallowed HTML content/,
  );
});

test("buildRawMessage throws when a separately-provided htmlBody sanitizes down to nothing", async () => {
  const service = new SMTPService(createConfig());
  await assert.rejects(
    () =>
      service.buildRawMessage({
        to: ["victim@example.com"],
        subject: "Empty after sanitization",
        body: "fallback text",
        isHtml: true,
        htmlBody: "<script>alert(1)</script>",
      }),
    /empty after removing disallowed HTML content/,
  );
});

test("buildRawMessage does not throw for a normal HTML body that survives sanitization", async () => {
  const service = new SMTPService(createConfig());
  const raw = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "Normal HTML",
    body: "fallback text",
    isHtml: true,
    htmlBody: "<p>hello</p><script>alert(1)</script>",
  });
  const message = raw.toString("utf8");
  assert.ok(!message.includes("<script>"));
  assert.ok(message.includes("hello"));
});

test("buildRawMessage does not throw for a plain-text (isHtml:false) empty-looking body", async () => {
  const service = new SMTPService(createConfig());
  // isHtml:false never goes through sanitization at all, so this bug's fix must
  // not affect plain-text sends, even ones a caller might consider near-empty.
  const raw = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "Plain text",
    body: "<script>alert(1)</script>",
    isHtml: false,
  });
  const message = raw.toString("utf8");
  assert.ok(message.includes("alert(1)"));
});

test("buildRawMessage respects PROTONMAIL_ALLOW_UNSAFE_HTML=true plus explicit sanitizeHtml:false", async () => {
  const previous = process.env.PROTONMAIL_ALLOW_UNSAFE_HTML;
  process.env.PROTONMAIL_ALLOW_UNSAFE_HTML = "true";
  try {
    const service = new SMTPService(createConfig());
    const raw = await service.buildRawMessage({
      to: ["victim@example.com"],
      subject: "HTML test",
      body: "fallback text",
      isHtml: true,
      htmlBody: "<p>hello</p><b>bold</b>",
      sanitizeHtml: false,
    });
    const message = raw.toString("utf8");
    assert.ok(message.includes("<b>bold</b>"));
  } finally {
    if (previous === undefined) {
      delete process.env.PROTONMAIL_ALLOW_UNSAFE_HTML;
    } else {
      process.env.PROTONMAIL_ALLOW_UNSAFE_HTML = previous;
    }
  }
});

test("buildRawMessage round-trips a base64 attachment", async () => {
  const service = new SMTPService(createConfig());
  const content = Buffer.from("attachment body").toString("base64");
  const raw = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "Attachment test",
    body: "see attached",
    attachments: [{ filename: "note.txt", content, contentType: "text/plain" }],
  });
  const message = raw.toString("utf8");

  assert.ok(message.includes("note.txt"));
  assert.ok(message.includes(content) || message.includes("attachment body"));
});

test("buildRawMessage adds Disposition-Notification-To only when requestReadReceipt is set", async () => {
  const service = new SMTPService(createConfig());

  const withReceipt = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "Receipt test",
    body: "please confirm reading this",
    requestReadReceipt: true,
  });
  assert.ok(withReceipt.toString("utf8").toLowerCase().includes("disposition-notification-to: owner@example.com"));

  const withoutReceipt = await service.buildRawMessage({
    to: ["victim@example.com"],
    subject: "No receipt",
    body: "normal email",
  });
  assert.ok(!withoutReceipt.toString("utf8").toLowerCase().includes("disposition-notification-to"));
});

test("buildRawMessage appends PROTONMAIL_SIGNATURE to text and HTML bodies by default", async () => {
  const previous = process.env.PROTONMAIL_SIGNATURE;
  process.env.PROTONMAIL_SIGNATURE = "Best,\nOwner";
  try {
    const service = new SMTPService(createConfig());
    const raw = await service.buildRawMessage({
      to: ["victim@example.com"],
      subject: "Signature test",
      body: "hello there",
      htmlBody: "<p>hello there</p>",
    });
    const message = raw.toString("utf8");
    assert.ok(message.includes("Best,"));
    assert.ok(message.includes("Owner"));
  } finally {
    if (previous === undefined) delete process.env.PROTONMAIL_SIGNATURE;
    else process.env.PROTONMAIL_SIGNATURE = previous;
  }
});

test("buildRawMessage still attaches an html part (with signature) for a plain-text send with no htmlBody", async () => {
  const previous = process.env.PROTONMAIL_SIGNATURE;
  process.env.PROTONMAIL_SIGNATURE = "Best,\nOwner";
  try {
    const service = new SMTPService(createConfig());
    const raw = await service.buildRawMessage({
      to: ["victim@example.com"],
      subject: "Plain text signature test",
      body: "hello there",
      isHtml: false,
    });
    const message = raw.toString("utf8");
    assert.ok(message.includes("multipart/alternative"), "expected a multipart message with a text and html part");
    assert.ok(message.includes("hello there<br>Best,<br>Owner") || message.includes("hello there<br><br>Best,<br>Owner"));
  } finally {
    if (previous === undefined) delete process.env.PROTONMAIL_SIGNATURE;
    else process.env.PROTONMAIL_SIGNATURE = previous;
  }
});

test("buildRawMessage omits the signature when appendSignature is false", async () => {
  const previous = process.env.PROTONMAIL_SIGNATURE;
  process.env.PROTONMAIL_SIGNATURE = "Best,\nOwner";
  try {
    const service = new SMTPService(createConfig());
    const raw = await service.buildRawMessage({
      to: ["victim@example.com"],
      subject: "No signature",
      body: "hello there",
      appendSignature: false,
    });
    assert.ok(!raw.toString("utf8").includes("Best,"));
  } finally {
    if (previous === undefined) delete process.env.PROTONMAIL_SIGNATURE;
    else process.env.PROTONMAIL_SIGNATURE = previous;
  }
});

test("buildRawMessage sends no signature block when PROTONMAIL_SIGNATURE is unset", async () => {
  const previous = process.env.PROTONMAIL_SIGNATURE;
  delete process.env.PROTONMAIL_SIGNATURE;
  try {
    const service = new SMTPService(createConfig());
    const raw = await service.buildRawMessage({
      to: ["victim@example.com"],
      subject: "No signature configured",
      body: "hello there",
    });
    const message = raw.toString("utf8");
    assert.ok(message.includes("hello there"));
    assert.ok(!message.includes("Best,"));
  } finally {
    if (previous === undefined) delete process.env.PROTONMAIL_SIGNATURE;
    else process.env.PROTONMAIL_SIGNATURE = previous;
  }
});

// applySignature is what reply_to_email/reply_all_email/forward_email call
// directly on their own text BEFORE quote/forward-wrapping, so the signature
// lands after the user's own words and before the quoted/forwarded content
// instead of at the very end of the whole message (the bug found in review).
test("applySignature appends after the given text, not conditioned on any wrapping the caller does later", () => {
  const previous = process.env.PROTONMAIL_SIGNATURE;
  process.env.PROTONMAIL_SIGNATURE = "Best,\nOwner";
  try {
    const result = applySignature("Sounds good!", "<p>Sounds good!</p>", true);
    assert.equal(result.body, "Sounds good!\n\nBest,\nOwner");
    assert.equal(result.htmlBody, "<p>Sounds good!</p><br><br>Best,<br>Owner");

    // Simulates the reply flow: quote-wrap AFTER signing, so the signature
    // ends up between the reply text and the quote, not after the quote.
    const quoted = `${result.body}\n\nOn Jan 1, sender wrote:\n> original text`;
    const signatureIndex = quoted.indexOf("Best,");
    const quoteIndex = quoted.indexOf("On Jan 1");
    assert.ok(signatureIndex < quoteIndex, "signature must appear before the quoted original");
  } finally {
    if (previous === undefined) delete process.env.PROTONMAIL_SIGNATURE;
    else process.env.PROTONMAIL_SIGNATURE = previous;
  }
});

// Regression test for an externally-reported bug (code review of 7c36bae / v2.1.3):
// isHtml:true with no separate htmlBody used to treat `body` as plain text
// regardless — gluing a literal "\n\n" (which HTML collapses, so lines visually
// ran together) and an UNESCAPED signature onto raw HTML source. Downstream
// sanitization then stripped anything in that unescaped signature that looked
// like a disallowed tag (e.g. a literal "<Sales>" in the signature vanished
// outright instead of rendering as text). Passing isHtml=true routes this
// through the same escaped-<br> treatment the separate-htmlBody branch already
// used, and returns it via `body` (not `htmlBody`) since `body` IS the HTML
// source when isHtml is true and htmlBody wasn't supplied.
test("applySignature escapes and <br>-joins the signature into `body` when isHtml is true and there's no separate htmlBody", () => {
  const previous = process.env.PROTONMAIL_SIGNATURE;
  process.env.PROTONMAIL_SIGNATURE = "Best,\n<Sales>";
  try {
    const result = applySignature("<p>Sounds good!</p>", undefined, true, true);
    assert.equal(result.body, "<p>Sounds good!</p><br><br>Best,<br>&lt;Sales&gt;");
    assert.equal(result.htmlBody, undefined, "htmlBody stays undefined — body IS the html source in this case");
    assert.ok(!result.body.includes("\n\n"), "no raw newline glued onto HTML source, which HTML would collapse visually");
  } finally {
    if (previous === undefined) delete process.env.PROTONMAIL_SIGNATURE;
    else process.env.PROTONMAIL_SIGNATURE = previous;
  }
});

test("applySignature is a no-op when appendSignature is false or no signature is configured", () => {
  const previous = process.env.PROTONMAIL_SIGNATURE;
  try {
    process.env.PROTONMAIL_SIGNATURE = "Best,\nOwner";
    assert.deepEqual(applySignature("hi", undefined, false), { body: "hi", htmlBody: undefined });

    delete process.env.PROTONMAIL_SIGNATURE;
    assert.deepEqual(applySignature("hi", undefined, true), { body: "hi", htmlBody: undefined });
  } finally {
    if (previous === undefined) delete process.env.PROTONMAIL_SIGNATURE;
    else process.env.PROTONMAIL_SIGNATURE = previous;
  }
});
