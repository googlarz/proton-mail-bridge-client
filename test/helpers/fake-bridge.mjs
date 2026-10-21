import net from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A small IMAP server that behaves like Proton Bridge where this project depends on it: a login per account,
// implicit TLS or STARTTLS, folders with special-use flags, UIDs and UIDVALIDITY, flags, FETCH of envelope / structure /
// source, SEARCH, STATUS, IDLE. Tests drive the real SimpleIMAPService against it, so a bug that needs a server to show
// up (a folder missing from one account, flags changed elsewhere, a TLS mode) can be reproduced without a Bridge.
// Not a general IMAP server: only what imapflow sends for the calls above.

export function makeCertificate() {
  try {
    const dir = mkdtempSync(join(tmpdir(), "fake-bridge-cert-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
  } catch {
    return undefined;
  }
}

const quote = (value) => (value === undefined || value === null ? "NIL" : `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);

export function createMessage(uid, { subject = `Mail ${uid}`, from = "alice@example.com", to = "owner@example.com", flags = [], body, html, date = new Date(Date.UTC(2026, 2, 24, 10, uid % 60)) } = {}) {
  const text = body ?? `Body of mail ${uid}\r\n`;
  const source = [
    `From: Alice <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <m${uid}@fake.bridge>`,
    "MIME-Version: 1.0",
    `Content-Type: ${html ? "text/html" : "text/plain"}; charset=utf-8`,
    "",
    html ?? text,
  ].join("\r\n");
  return { uid, flags: new Set(flags), internalDate: date, from, to, subject, messageId: `<m${uid}@fake.bridge>`, source: Buffer.from(source) };
}

function address(email) {
  const [mailbox, host] = email.split("@");
  return `(("Alice" NIL ${quote(mailbox)} ${quote(host)}))`;
}

function envelope(message) {
  const to = message.to.split("@");
  return `(${quote(message.internalDate.toUTCString())} ${quote(message.subject)} ${address(message.from)} ${address(message.from)} ${address(message.from)} ((NIL NIL ${quote(to[0])} ${quote(to[1])})) NIL NIL NIL ${quote(message.messageId)})`;
}

function parseSet(set, maxUid) {
  const ranges = set.split(",").map((part) => {
    const [a, b = a] = part.split(":");
    const num = (value) => (value === "*" ? maxUid : Number(value));
    return [Math.min(num(a), num(b)), Math.max(num(a), num(b))];
  });
  return (uid) => ranges.some(([from, to]) => uid >= from && uid <= to);
}

/**
 * options: { accounts: { user: password }, folders: { name: { uidValidity, specialUse, messages: [createMessage()] } },
 *            mode: "implicit" | "starttls" | "plain", certificate }
 */
export async function startFakeBridge(options) {
  const { accounts = { "owner@example.com": "secret" }, mode = "plain", certificate } = options;
  const folders = options.folders;
  const state = { connections: 0, logins: 0, commands: [], folders };
  const sockets = new Set();

  const handle = (rawSocket) => {
    state.connections += 1;
    sockets.add(rawSocket);
    rawSocket.on("close", () => sockets.delete(rawSocket));
    let socket = rawSocket;
    let buffer = Buffer.alloc(0);
    let upgraded = mode !== "starttls";
    let selected;
    let idleTag;
    let pendingAuth;

    const write = (text) => socket.write(text);
    const capability = () => `IMAP4rev1 AUTH=PLAIN ID IDLE UIDPLUS NAMESPACE${upgraded ? "" : " STARTTLS"}`;
    const folder = (name) => folders[name];
    const sorted = (name) => [...(folder(name)?.messages ?? [])].sort((a, b) => a.uid - b.uid);

    const finishLogin = (tag, user, password) => {
      if (accounts[user] !== undefined && accounts[user] === password) {
        state.logins += 1;
        return write(`${tag} OK [CAPABILITY ${capability()}] Authentication successful\r\n`);
      }
      return write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
    };

    const run = (tag, command, rest) => {
      state.commands.push(`${command} ${rest}`.trim());
      switch (command) {
        case "CAPABILITY":
          return write(`* CAPABILITY ${capability()}\r\n${tag} OK CAPABILITY completed\r\n`);
        case "STARTTLS": {
          write(`${tag} OK Begin TLS negotiation now\r\n`);
          const plain = socket;
          plain.removeAllListeners("data");
          const secure = new tls.TLSSocket(plain, { isServer: true, key: certificate.key, cert: certificate.cert });
          socket = secure;
          upgraded = true;
          secure.on("data", onData);
          secure.on("error", () => {});
          return undefined;
        }
        case "ID":
          return write(`* ID NIL\r\n${tag} OK ID completed\r\n`);
        case "NAMESPACE":
          return write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n`);
        case "LOGIN":
        case "AUTHENTICATE": {
          let user;
          let password;
          if (command === "LOGIN") {
            [user, password] = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] ?? m[2]).replace(/\\(.)/g, "$1"));
          } else {
            const encoded = rest.split(/\s+/)[1];
            if (!encoded) {
              pendingAuth = tag;
              return write("+ \r\n");
            }
            [, user, password] = Buffer.from(encoded, "base64").toString().split("\0");
          }
          return finishLogin(tag, user, password);
        }
        case "NOOP":
          return write(`${tag} OK NOOP completed\r\n`);
        case "LOGOUT":
          write(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);
          return socket.end();
        case "LSUB":
          return write(`${Object.keys(folders).map((name) => `* LSUB () "/" ${quote(name)}\r\n`).join("")}${tag} OK LSUB completed\r\n`);
        case "LIST": {
          const lines = Object.entries(folders).map(([name, f]) => {
            const flags = ["\\HasNoChildren", ...(f.specialUse ? [f.specialUse] : [])];
            return `* LIST (${flags.join(" ")}) "/" ${quote(name)}\r\n`;
          });
          if (/""\s+""/.test(rest)) return write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK LIST completed\r\n`);
          return write(`${lines.join("")}${tag} OK LIST completed\r\n`);
        }
        case "STATUS": {
          const name = rest.match(/^"?([^"(]+?)"?\s*\(/)?.[1];
          const f = folder(name);
          if (!f) return write(`${tag} NO [NONEXISTENT] Mailbox does not exist\r\n`);
          const messages = sorted(name);
          const maxUid = messages.at(-1)?.uid ?? 0;
          return write(`* STATUS ${quote(name)} (MESSAGES ${messages.length} UIDNEXT ${maxUid + 1} UIDVALIDITY ${f.uidValidity ?? 1} UNSEEN ${messages.filter((m) => !m.flags.has("\\Seen")).length})\r\n${tag} OK STATUS completed\r\n`);
        }
        case "SELECT":
        case "EXAMINE": {
          const name = rest.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");
          const f = folder(name);
          if (!f) return write(`${tag} NO [NONEXISTENT] Mailbox does not exist\r\n`);
          selected = name;
          const messages = sorted(name);
          const maxUid = messages.at(-1)?.uid ?? 0;
          return write(
            `* ${messages.length} EXISTS\r\n* 0 RECENT\r\n* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] \r\n* OK [UIDVALIDITY ${f.uidValidity ?? 1}] \r\n* OK [UIDNEXT ${maxUid + 1}] \r\n${tag} OK [${command === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${command} completed\r\n`,
          );
        }
        case "CLOSE":
        case "UNSELECT":
          selected = undefined;
          return write(`${tag} OK ${command} completed\r\n`);
        case "IDLE":
          idleTag = tag;
          return write("+ idling\r\n");
        case "UID": {
          const [sub, ...more] = rest.split(/\s+/);
          const args = more.join(" ");
          if (!selected) return write(`${tag} BAD No mailbox selected\r\n`);
          const messages = sorted(selected);
          const maxUid = messages.at(-1)?.uid ?? 0;
          if (sub.toUpperCase() === "SEARCH") {
            const unseenOnly = /UNSEEN/i.test(args);
            const uids = messages.filter((m) => !unseenOnly || !m.flags.has("\\Seen")).map((m) => m.uid);
            return write(`* SEARCH ${uids.join(" ")}\r\n${tag} OK UID SEARCH completed\r\n`);
          }
          if (sub.toUpperCase() === "STORE") {
            const [set, mode, flagList] = [args.split(" ")[0], args.split(" ")[1], args.slice(args.indexOf("(") + 1, args.lastIndexOf(")"))];
            const inSet = parseSet(set, maxUid);
            const flags = flagList.split(/\s+/).filter(Boolean);
            for (const m of messages.filter((entry) => inSet(entry.uid))) {
              if (/^\+/.test(mode)) for (const f of flags) m.flags.add(f);
              else if (/^-/.test(mode)) for (const f of flags) m.flags.delete(f);
              else { m.flags.clear(); for (const f of flags) m.flags.add(f); }
              if (!/SILENT/i.test(mode)) write(`* ${messages.indexOf(m) + 1} FETCH (UID ${m.uid} FLAGS (${[...m.flags].join(" ")}))\r\n`);
            }
            return write(`${tag} OK UID STORE completed\r\n`);
          }
          if (sub.toUpperCase() === "FETCH") {
            const set = args.split(" ")[0];
            const items = args.slice(set.length + 1).toUpperCase();
            const inSet = parseSet(set, maxUid);
            for (const [index, m] of messages.entries()) {
              if (!inSet(m.uid)) continue;
              const parts = [`UID ${m.uid}`];
              if (/FLAGS/.test(items)) parts.push(`FLAGS (${[...m.flags].join(" ")})`);
              if (/INTERNALDATE/.test(items)) parts.push(`INTERNALDATE "${m.internalDate.toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) ([\d:]+) GMT$/, "$1-$2-$3 $4 +0000")}"`);
              if (/RFC822\.SIZE/.test(items)) parts.push(`RFC822.SIZE ${m.source.length}`);
              if (/ENVELOPE/.test(items)) parts.push(`ENVELOPE ${envelope(m)}`);
              if (/BODYSTRUCTURE/.test(items)) parts.push(`BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${m.source.length} 3)`);
              let literal;
              if (/BODY(\.PEEK)?\[\]/.test(items)) literal = ["BODY[]", m.source];
              else if (/BODY(\.PEEK)?\[HEADER/.test(items)) literal = ["BODY[HEADER]", m.source.subarray(0, m.source.indexOf("\r\n\r\n") + 4)];
              write(`* ${index + 1} FETCH (${parts.join(" ")}${literal ? ` ${literal[0]} {${literal[1].length}}\r\n` : ""}`);
              if (literal) write(literal[1]);
              write(")\r\n");
            }
            return write(`${tag} OK UID FETCH completed\r\n`);
          }
          return write(`${tag} BAD Unsupported UID command\r\n`);
        }
        default:
          return write(`${tag} BAD Unsupported command ${command}\r\n`);
      }
    };

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 2);
        if (pendingAuth) {
          const tag = pendingAuth;
          pendingAuth = undefined;
          const [, user, password] = Buffer.from(line, "base64").toString().split("\0");
          finishLogin(tag, user, password);
          continue;
        }
        if (idleTag && /^DONE$/i.test(line)) {
          const tag = idleTag;
          idleTag = undefined;
          write(`${tag} OK IDLE terminated\r\n`);
          continue;
        }
        const match = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
        if (!match) continue;
        run(match[1], match[2].toUpperCase(), match[3]);
      }
    }

    socket.on("data", onData);
    socket.on("error", () => {});
    write(`* OK [CAPABILITY ${capability()}] Fake Bridge ready\r\n`);
  };

  const server = mode === "implicit" ? tls.createServer({ key: certificate.key, cert: certificate.cert }, handle) : net.createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    state,
    folders,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
      setTimeout(resolve, 500).unref();
    }),
  };
}
