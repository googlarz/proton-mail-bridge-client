import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { SMTPService, normalizeSendResult } from "../dist/services/smtp-service.js";

// Sends through the REAL SMTPService and the REAL nodemailer over a real TCP socket to a
// small in-process SMTP server, and checks what arrives. Nothing here talks to Proton.
// It exists so that a nodemailer upgrade is judged by what goes over the wire (envelope,
// headers, MIME structure, result shape) and not only by whether the types still compile.

function startFakeSmtp({ rejectRcpt = [], tlsCredentials } = {}) {
  const received = [];
  const onConnection = (socket) => {
    let buffer = "";
    let mode = "command"; // command | data | authUser | authPass | authPlain
    let session = { rcpt: [], from: undefined, auth: undefined, data: "" };
    const say = (line) => socket.write(`${line}\r\n`);
    say("220 fake.example ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (mode === "data") {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          session.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          received.push({ ...session });
          session = { rcpt: [], from: undefined, auth: session.auth, data: "" };
          mode = "command";
          say("250 2.0.0 Ok: queued as FAKE123");
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        if (mode === "authUser") { session.auth = { user: Buffer.from(line, "base64").toString() }; mode = "authPass"; say("334 UGFzc3dvcmQ6"); continue; }
        if (mode === "authPass") { session.auth.pass = Buffer.from(line, "base64").toString(); mode = "command"; say("235 2.7.0 Authentication successful"); continue; }
        if (mode === "authPlain") { const [, user, pass] = Buffer.from(line, "base64").toString().split("\0"); session.auth = { user, pass }; mode = "command"; say("235 2.7.0 Authentication successful"); continue; }
        const [verb, ...rest] = line.split(" ");
        const arg = rest.join(" ");
        switch (verb.toUpperCase()) {
          case "EHLO": say("250-fake.example"); say("250-AUTH PLAIN LOGIN"); say("250 8BITMIME"); break;
          case "HELO": say("250 fake.example"); break;
          case "AUTH":
            if (/^PLAIN/i.test(arg)) { const inline = arg.split(" ")[1]; if (inline) { const [, user, pass] = Buffer.from(inline, "base64").toString().split("\0"); session.auth = { user, pass }; say("235 2.7.0 Authentication successful"); } else { mode = "authPlain"; say("334 "); } }
            else { mode = "authUser"; say("334 VXNlcm5hbWU6"); }
            break;
          case "MAIL": session.from = /<([^>]*)>/.exec(arg)?.[1]; say("250 2.1.0 Ok"); break;
          case "RCPT": {
            const address = /<([^>]*)>/.exec(arg)?.[1];
            if (rejectRcpt.includes(address)) { say("550 5.1.1 User unknown"); } else { session.rcpt.push(address); say("250 2.1.5 Ok"); }
            break;
          }
          case "DATA": mode = "data"; say("354 End data with <CR><LF>.<CR><LF>"); break;
          case "RSET": session.rcpt = []; say("250 2.0.0 Ok"); break;
          case "NOOP": say("250 2.0.0 Ok"); break;
          case "QUIT": say("221 2.0.0 Bye"); socket.end(); break;
          default: say("502 5.5.2 Command not recognized");
        }
      }
    });
  };
  const server = tlsCredentials ? tls.createServer(tlsCredentials, onConnection) : net.createServer(onConnection);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.address().port })));
}

// A throwaway self-signed certificate, made at test time (nothing secret is committed).
function selfSignedCredentials() {
  const dir = mkdtempSync(join(tmpdir(), "smtp-test-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const service = (port, secure = false) =>
  new SMTPService({
    smtp: { host: "127.0.0.1", port, secure, username: "me@example.com", password: "s3cret" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "me@example.com", password: "s3cret" },
    dataDir: "/tmp/smtp-real-transport-test", debug: false, runtime: {},
  });

test("a real send: envelope, headers, MIME structure, inline image, authentication and the normalized result", async () => {
  const { server, received, port } = await startFakeSmtp();
  try {
    const result = await service(port).sendEmail({
      to: ["anna@example.com"], cc: ["cc@example.com"], bcc: ["hidden@example.com"],
      subject: "Zażółć gęślą jaźń — quotation", body: "Plain text body", isHtml: true,
      htmlBody: '<p>Hello <b>Anna</b></p><img src="cid:logo123">',
      inReplyTo: "<orig@example.com>", references: ["<root@example.com>", "<orig@example.com>"],
      attachments: [
        { filename: "logo.png", content: Buffer.from("PNGDATA").toString("base64"), contentType: "image/png", cid: "logo123", contentDisposition: "inline" },
        { filename: "spec.pdf", content: Buffer.from("PDFDATA").toString("base64"), contentType: "application/pdf" },
      ],
      appendSignature: false,
    });

    assert.equal(received.length, 1);
    const mail = received[0];
    assert.deepEqual(mail.auth, { user: "me@example.com", pass: "s3cret" }, "authenticated with the configured login");
    assert.equal(mail.from, "me@example.com");
    assert.deepEqual([...mail.rcpt].sort(), ["anna@example.com", "cc@example.com", "hidden@example.com"], "Bcc is in the envelope");

    const parsed = await simpleParser(Buffer.from(mail.data, "latin1"));
    assert.equal(parsed.subject, "Zażółć gęślą jaźń — quotation", "non-ASCII subject survives");
    assert.equal(parsed.headers.get("bcc"), undefined, "Bcc must never appear in the delivered headers");
    assert.equal(parsed.inReplyTo, "<orig@example.com>");
    assert.deepEqual(parsed.references, ["<root@example.com>", "<orig@example.com>"]);
    assert.match(parsed.html, /Hello <b>Anna<\/b>/);
    assert.equal(parsed.text.trim(), "Plain text body");
    const inline = parsed.attachments.find((a) => a.filename === "logo.png");
    const pdf = parsed.attachments.find((a) => a.filename === "spec.pdf");
    assert.equal(inline?.cid, "logo123");
    assert.equal(inline?.related, true, "the cid image is a related part of the HTML");
    assert.equal(inline?.content.toString(), "PNGDATA");
    assert.equal(pdf?.content.toString(), "PDFDATA");

    assert.deepEqual([...result.accepted].sort(), ["anna@example.com", "cc@example.com", "hidden@example.com"]);
    assert.deepEqual(result.rejected, []);
    assert.match(result.response, /^250/);
    assert.ok(result.messageId.startsWith("<") && result.messageId.endsWith(">"), "a Message-ID comes back");
  } finally {
    server.close();
  }
});

test("a rejected recipient is reported in the normalized result while the message still goes to the others", async () => {
  const { server, received, port } = await startFakeSmtp({ rejectRcpt: ["nobody@example.com"] });
  try {
    const result = await service(port).sendEmail({ to: ["anna@example.com", "nobody@example.com"], subject: "s", body: "b", isHtml: false, appendSignature: false });
    assert.deepEqual(result.accepted, ["anna@example.com"]);
    assert.deepEqual(result.rejected, ["nobody@example.com"]);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].rcpt, ["anna@example.com"]);
  } finally {
    server.close();
  }
});

// nodemailer 10 types accepted/rejected/response as optional and they may hold address
// objects; every consumer (draft store, delivery queue, tools) needs plain, present values.
test("normalizeSendResult fills missing fields and flattens address objects", () => {
  assert.deepEqual(normalizeSendResult({ messageId: "<m@x>" }), { messageId: "<m@x>", accepted: [], rejected: [], response: "" });
  assert.deepEqual(
    normalizeSendResult({ messageId: "<m@x>", accepted: ["a@x", { address: "b@x", name: "B" }], rejected: [{ address: "c@x" }, null], response: "250 ok" }),
    { messageId: "<m@x>", accepted: ["a@x", "b@x"], rejected: ["c@x"], response: "250 ok" },
  );
  assert.deepEqual(normalizeSendResult({}), { messageId: "", accepted: [], rejected: [], response: "" });
});

// Proton Bridge's SMTP port speaks TLS from the first byte (secure: true) with a self-signed
// certificate, and the service accepts it because the host is loopback. That is the path a
// real installation uses, and the one a nodemailer upgrade could change (TLS defaults).
test("implicit TLS with a self-signed certificate on loopback (the Bridge configuration)", { skip: selfSignedCredentials() ? false : "openssl not available" }, async () => {
  const { server, received, port } = await startFakeSmtp({ tlsCredentials: selfSignedCredentials() });
  try {
    const result = await service(port, true).sendEmail({ to: ["anna@example.com"], subject: "over TLS", body: "hello", isHtml: false, appendSignature: false });
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].auth, { user: "me@example.com", pass: "s3cret" });
    assert.deepEqual(result.accepted, ["anna@example.com"]);
    const parsed = await simpleParser(Buffer.from(received[0].data, "latin1"));
    assert.equal(parsed.subject, "over TLS");
  } finally {
    server.close();
  }
});

test("a certificate that is NOT on loopback is still verified (the relaxation is loopback-only)", { skip: selfSignedCredentials() ? false : "openssl not available" }, async () => {
  const { server, port } = await startFakeSmtp({ tlsCredentials: selfSignedCredentials() });
  try {
    const remote = new SMTPService({
      // 0.0.0.0 reaches the local server but is not in the loopback list, so the self-signed
      // certificate must be refused for a TLS reason (not a DNS failure).
      smtp: { host: "0.0.0.0", port, secure: true, username: "me@example.com", password: "s3cret" },
      imap: {}, dataDir: "/tmp/x", debug: false, runtime: {},
    });
    await assert.rejects(
      remote.sendEmail({ to: ["a@example.com"], subject: "s", body: "b", isHtml: false, appendSignature: false }),
      (error) => /self[- ]signed|certificate|altnames|unable to verify/i.test(String(error?.message)) || /CERT|SELF_SIGNED|ESOCKET/.test(String(error?.code)),
    );
  } finally {
    server.close();
  }
});
