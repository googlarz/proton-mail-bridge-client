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

export function createMessage(uid, { subject = `Mail ${uid}`, from = "alice@example.com", to = "owner@example.com", flags = [], body, html, headers = {}, date = new Date(Date.UTC(2026, 2, 24, 10, uid % 60)) } = {}) {
  const text = body ?? `Body of mail ${uid}\r\n`;
  const source = [
    `From: Alice <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <m${uid}@fake.bridge>`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "MIME-Version: 1.0",
    `Content-Type: ${html ? "text/html" : "text/plain"}; charset=utf-8`,
    "",
    html ?? text,
  ].join("\r\n");
  return { uid, flags: new Set(flags), internalDate: date, from, to, subject, messageId: `<m${uid}@fake.bridge>`, source: Buffer.from(source) };
}

// A message appended by a client: only the headers the server needs to answer an envelope.
function messageFromSource(uid, source, flags, internalDate) {
  const head = source.toString().split("\r\n\r\n")[0];
  const header = (name) => head.match(new RegExp(`^${name}:\\s*(.*)$`, "im"))?.[1]?.trim();
  const from = header("From")?.match(/<([^>]+)>/)?.[1] ?? header("From") ?? "unknown@example.com";
  const to = header("To")?.match(/<([^>]+)>/)?.[1] ?? header("To") ?? "owner@example.com";
  return { uid, flags: new Set(flags), internalDate, from, to, subject: header("Subject") ?? "", messageId: header("Message-ID") ?? `<a${uid}@fake.bridge>`, source };
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
    const capability = () => `IMAP4rev1 AUTH=PLAIN ID IDLE UIDPLUS MOVE NAMESPACE${upgraded ? "" : " STARTTLS"}`;
    const nextUid = (name) => Math.max(0, ...(folder(name)?.messages ?? []).map((m) => m.uid)) + 1;
    const expunge = (name, predicate) => {
      const f = folder(name);
      const before = sorted(name);
      const removed = before.filter(predicate);
      f.messages = f.messages.filter((m) => !predicate(m));
      // Sequence numbers shift as messages go, so they are reported from the highest down.
      return [...removed].reverse().map((m) => `* ${before.indexOf(m) + 1} EXPUNGE\r\n`).join("");
    };
    const folder = (name) => folders[name];
    const sorted = (name) => [...(folder(name)?.messages ?? [])].sort((a, b) => a.uid - b.uid);

    const finishLogin = (tag, user, password) => {
      if (accounts[user] !== undefined && accounts[user] === password) {
        state.logins += 1;
        return write(`${tag} OK [CAPABILITY ${capability()}] Authentication successful\r\n`);
      }
      return write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
    };

    const appendMessage = (tag, rest, source) => {
      const name = rest.match(/^"((?:[^"\\]|\\.)*)"|^(\S+)/);
      const mailbox = (name?.[1] ?? name?.[2] ?? "").replace(/\\(.)/g, "$1");
      const target = folder(mailbox);
      if (!target) return write(`${tag} NO [TRYCREATE] Mailbox does not exist\r\n`);
      const flags = (rest.match(/\(([^)]*)\)/)?.[1] ?? "").split(/\s+/).filter(Boolean);
      const uid = nextUid(mailbox);
      target.messages.push(messageFromSource(uid, source, flags, new Date()));
      write(`${tag} OK [APPENDUID ${target.uidValidity ?? 1} ${uid}] APPEND completed\r\n`);
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
        case "CREATE": {
          const name = rest.replace(/^"|"$/g, "");
          if (folder(name)) return write(`${tag} NO [ALREADYEXISTS] Mailbox already exists\r\n`);
          folders[name] = { uidValidity: 100 + Object.keys(folders).length, messages: [] };
          return write(`${tag} OK CREATE completed\r\n`);
        }
        case "EXPUNGE": {
          if (!selected) return write(`${tag} BAD No mailbox selected\r\n`);
          return write(`${expunge(selected, (m) => m.flags.has("\\Deleted"))}${tag} OK EXPUNGE completed\r\n`);
        }
        case "UID": {
          const [sub, ...more] = rest.split(/\s+/);
          const args = more.join(" ");
          if (!selected) return write(`${tag} BAD No mailbox selected\r\n`);
          const messages = sorted(selected);
          const maxUid = messages.at(-1)?.uid ?? 0;
          if (sub.toUpperCase() === "SEARCH") {
            const unseenOnly = /UNSEEN/i.test(args);
            const header = args.match(/HEADER\s+"?([^"\s]+)"?\s+"?([^"]*?)"?\s*$/i);
            const hasHeader = (m) => {
              const head = m.source.toString().split("\r\n\r\n")[0];
              return head.split("\r\n").some((line) => line.toLowerCase().startsWith(`${header[1].toLowerCase()}:`) && line.toLowerCase().includes(header[2].toLowerCase()));
            };
            const uids = messages.filter((m) => (!unseenOnly || !m.flags.has("\\Seen")) && (!header || hasHeader(m))).map((m) => m.uid);
            return write(`* SEARCH ${uids.join(" ")}\r\n${tag} OK UID SEARCH completed\r\n`);
          }
          if (sub.toUpperCase() === "EXPUNGE") {
            const inSet = parseSet(args.trim(), maxUid);
            return write(`${expunge(selected, (m) => inSet(m.uid) && m.flags.has("\\Deleted"))}${tag} OK UID EXPUNGE completed\r\n`);
          }
          if (sub.toUpperCase() === "MOVE" || sub.toUpperCase() === "COPY") {
            const [set, ...destParts] = args.split(" ");
            const destination = destParts.join(" ").replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");
            const target = folder(destination);
            if (!target) return write(`${tag} NO [TRYCREATE] Mailbox does not exist\r\n`);
            const inSet = parseSet(set, maxUid);
            const chosen = messages.filter((m) => inSet(m.uid));
            const pairs = chosen.map((m) => {
              const copy = { ...m, uid: nextUid(destination), flags: new Set(m.flags) };
              target.messages.push(copy);
              return [m.uid, copy.uid];
            });
            const code = pairs.length ? `[COPYUID ${target.uidValidity ?? 1} ${pairs.map(([a]) => a).join(",")} ${pairs.map(([, b]) => b).join(",")}] ` : "";
            const expunged = sub.toUpperCase() === "MOVE" ? expunge(selected, (m) => chosen.includes(m)) : "";
            return write(`${expunged}${tag} OK ${code}${sub.toUpperCase()} completed\r\n`);
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
              const literals = [];
              const headerBlock = m.source.subarray(0, m.source.indexOf("\r\n\r\n") + 4);
              const fields = items.match(/BODY(?:\.PEEK)?\[HEADER\.FIELDS \(([^)]*)\)\]/);
              if (fields) {
                const wanted = fields[1].toLowerCase().split(/\s+/).filter(Boolean);
                const lines = headerBlock.toString().split("\r\n").filter((line) => wanted.includes(line.split(":")[0].toLowerCase()));
                literals.push([`BODY[HEADER.FIELDS (${fields[1]})]`, Buffer.from(`${lines.join("\r\n")}${lines.length ? "\r\n" : ""}\r\n`)]);
              }
              if (/BODY(\.PEEK)?\[\]/.test(items)) literals.push(["BODY[]", m.source]);
              else if (/BODY(\.PEEK)?\[HEADER\]/.test(items)) literals.push(["BODY[HEADER]", headerBlock]);
              write(`* ${index + 1} FETCH (${parts.join(" ")}`);
              for (const [key, data] of literals) {
                write(` ${key} {${data.length}}\r\n`);
                write(data);
              }
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

    let pendingLiteral;

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (pendingLiteral) {
          if (buffer.length < pendingLiteral.length + 2) return;
          const data = buffer.subarray(0, pendingLiteral.length);
          buffer = buffer.subarray(pendingLiteral.length + 2);
          const { tag, rest } = pendingLiteral;
          pendingLiteral = undefined;
          appendMessage(tag, rest, Buffer.from(data));
          continue;
        }
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
        const literal = match[2].toUpperCase() === "APPEND" ? match[3].match(/\{(\d+)\+?\}$/) : null;
        if (literal) {
          pendingLiteral = { tag: match[1], rest: match[3], length: Number(literal[1]) };
          if (!/\+\}$/.test(match[3])) write("+ Ready for literal data\r\n");
          continue;
        }
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
    // What Bridge does to a connection when something it depends on goes away.
    dropConnections: () => { for (const socket of sockets) socket.destroy(); },
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
      setTimeout(resolve, 500).unref();
    }),
  };
}
