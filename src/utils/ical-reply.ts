// Answering a calendar invitation: read the invite (an iCalendar METHOD:REQUEST) and build the reply an organizer's
// calendar understands (METHOD:REPLY, RFC 5546). Pure functions, no I/O.

export type InviteResponse = "accept" | "decline" | "tentative";

export class InviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InviteError";
  }
}

const PARTSTAT: Record<InviteResponse, string> = { accept: "ACCEPTED", decline: "DECLINED", tentative: "TENTATIVE" };
const SUBJECT_PREFIX: Record<InviteResponse, string> = { accept: "Accepted", decline: "Declined", tentative: "Tentative" };
const VERB: Record<InviteResponse, string> = { accept: "accepted", decline: "declined", tentative: "tentatively accepted" };

interface IcsProperty {
  name: string;
  params: Map<string, string>;
  value: string;
  /** The line as it was written (unfolded), to be copied into the reply unchanged. */
  raw: string;
}

export interface InviteAttendee {
  address: string;
  name?: string;
  partstat?: string;
}

export interface ParsedInvite {
  method: string;
  uid: string;
  sequence: string;
  summary?: string;
  location?: string;
  hasRecurrence: boolean;
  organizer: { address: string; name?: string };
  attendees: InviteAttendee[];
  /** Lines copied into the reply: RECURRENCE-ID, SUMMARY, DTSTART, DTEND, ORGANIZER. */
  copy: string[];
  /** VTIMEZONE components of the invite, rebuilt from whitelisted properties only (never copied verbatim). */
  timezones: string[][];
}

const MAX_LINES = 20_000;
const MAX_DEPTH = 8;
const MAX_TIMEZONES = 4;
const MAX_TIMEZONE_LINES = 60;
const MAX_TITLE = 200;
const TIMEZONE_PROPERTIES = new Set(["TZID", "TZOFFSETFROM", "TZOFFSETTO", "TZNAME", "DTSTART", "RRULE", "RDATE"]);
const MAX_COPIED_LINE = 500;
// Control characters and the Unicode line separators are never legitimate in these lines; a lenient reader might
// treat U+2028 as a line break.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;
const clean = (value: string) => value.replace(UNSAFE_CHARS, "");
const TIMEZONE_PARTS = new Set(["STANDARD", "DAYLIGHT"]);

function unfold(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseProperty(raw: string): IcsProperty | undefined {
  let quoted = false;
  let colon = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon <= 0) return undefined;
  const head = raw.slice(0, colon);
  const parts: string[] = [];
  let current = "";
  quoted = false;
  for (const char of head) {
    if (char === '"') quoted = !quoted;
    if (char === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  const params = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    if (equals > 0) params.set(part.slice(0, equals).toUpperCase(), part.slice(equals + 1).replace(/^"|"$/g, ""));
  }
  return { name: parts[0].trim().toUpperCase(), params, value: raw.slice(colon + 1).trim(), raw };
}

function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_match, char: string) => (char === "n" || char === "N" ? " " : char));
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n?|\n/g, "\\n");
}

function mailtoAddress(value: string): string | undefined {
  const match = /^mailto:(.+)$/i.exec(value.trim());
  const address = (match ? match[1] : value).split("?")[0].trim();
  return address.length <= 320 && /^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(address) ? address : undefined;
}

/** The first VEVENT of an invitation, with what a reply needs. Throws InviteError when it cannot be answered. */
export function parseInvite(text: string): ParsedInvite {
  const lines = unfold(text);
  if (lines.length > MAX_LINES) throw new InviteError("The calendar attachment is too large to answer.");
  let method = "";
  const depth: string[] = [];
  let seenEvent = false;
  let inFirstEvent = false;
  const event: IcsProperty[] = [];
  const timezones: string[][] = [];
  let timezone: string[] | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const marker = /^(BEGIN|END):(\S+)$/i.exec(line);
    if (marker) {
      const component = marker[2].toUpperCase();
      const begin = marker[1].toUpperCase() === "BEGIN";
      if (timezone && TIMEZONE_PARTS.has(component) && timezone.length < MAX_TIMEZONE_LINES) timezone.push(`${begin ? "BEGIN" : "END"}:${component}`);
      if (begin) {
        if (depth.length >= MAX_DEPTH) throw new InviteError("The calendar attachment is nested too deeply to answer.");
        const insideTimezone = depth.includes("VTIMEZONE");
        depth.push(component);
        if (component === "VEVENT" && !seenEvent && !insideTimezone) {
          seenEvent = true;
          inFirstEvent = true;
        }
        if (component === "VTIMEZONE") timezone = [];
      } else {
        if (component === "VEVENT" && inFirstEvent) inFirstEvent = false;
        if (component === "VTIMEZONE" && timezone) {
          if (timezones.length < MAX_TIMEZONES) timezones.push(["BEGIN:VTIMEZONE", ...timezone, "END:VTIMEZONE"]);
          timezone = undefined;
        }
        const index = depth.lastIndexOf(component);
        if (index >= 0) depth.length = index;
      }
      continue;
    }
    if (timezone && depth.includes("VTIMEZONE")) {
      // Only known time-zone properties, re-emitted from what was parsed, so no foreign line rides along.
      const property = parseProperty(line);
      if (property && TIMEZONE_PROPERTIES.has(property.name) && timezone.length < MAX_TIMEZONE_LINES) {
        timezone.push(`${property.name}:${property.value}`);
      }
      continue;
    }
    const property = parseProperty(line);
    if (!property) continue;
    if (depth.length === 1 && depth[0] === "VCALENDAR" && property.name === "METHOD") method = property.value.toUpperCase();
    // Only the event's own properties: not those of a VALARM inside it.
    if (inFirstEvent && depth[depth.length - 1] === "VEVENT") event.push(property);
  }

  if (!seenEvent) throw new InviteError("The attachment holds no calendar event.");
  if (method === "CANCEL") throw new InviteError("The organizer cancelled this event; there is nothing to answer.");
  if (method && method !== "REQUEST") throw new InviteError(`This is a calendar message of type ${method}, not an invitation that can be answered.`);

  const first = (name: string) => event.find((property) => property.name === name);
  const uid = clean(first("UID")?.value ?? "").slice(0, 255) || undefined;
  if (!uid) throw new InviteError("The invitation has no UID, so a reply could not be matched to it.");
  const organizerProperty = first("ORGANIZER");
  const organizerAddress = organizerProperty ? mailtoAddress(organizerProperty.value) : undefined;
  if (!organizerProperty || !organizerAddress) throw new InviteError("The invitation names no organizer to answer.");

  const attendees: InviteAttendee[] = [];
  for (const property of event.filter((candidate) => candidate.name === "ATTENDEE")) {
    const address = mailtoAddress(property.value);
    if (address) attendees.push({ address, name: property.params.get("CN"), partstat: property.params.get("PARTSTAT")?.toUpperCase() });
  }

  const copy: string[] = [];
  for (const name of ["RECURRENCE-ID", "SUMMARY", "DTSTART", "DTEND"]) {
    const property = first(name);
    if (!property) continue;
    if (property.raw.length > MAX_COPIED_LINE && name !== "SUMMARY") throw new InviteError(`The invitation's ${name} line is too long to answer.`);
    // SUMMARY is rebuilt from its capped text: an invite must not make the reply arbitrarily large.
    copy.push(name === "SUMMARY" ? `SUMMARY:${escapeText(unescapeText(property.value).slice(0, MAX_TITLE))}` : clean(property.raw));
  }
  const organizerName = organizerProperty.params.get("CN");
  copy.push(`ORGANIZER${organizerName ? `;CN="${clean(organizerName).replace(/"/g, "").slice(0, 100)}"` : ""}:mailto:${organizerAddress}`);

  const summaryProperty = first("SUMMARY");
  const locationProperty = first("LOCATION");
  return {
    method: method || "REQUEST",
    uid,
    sequence: clean(first("SEQUENCE")?.value ?? "").slice(0, 10) || "0",
    summary: summaryProperty ? unescapeText(summaryProperty.value).slice(0, MAX_TITLE) : undefined,
    location: locationProperty ? unescapeText(locationProperty.value).slice(0, MAX_TITLE) : undefined,
    hasRecurrence: Boolean(first("RRULE") || first("RDATE")),
    organizer: { address: organizerAddress, name: organizerProperty.params.get("CN") },
    attendees,
    copy,
    timezones,
  };
}

/** Which of the invited attendees is one of the reader's addresses (`isMine`), if any. */
export function findMyAttendee(invite: ParsedInvite, isMine: (address: string) => boolean): InviteAttendee | undefined {
  return invite.attendees.find((attendee) => isMine(attendee.address));
}

// Content lines are folded at 75 octets (RFC 5545 section 3.1); a fold never splits a UTF-8 character.
function fold(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > limit) {
      out.push(current);
      current = " ";
      bytes = 1;
      limit = 75;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out;
}

function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export interface InviteReply {
  ics: string;
  to: string;
  subject: string;
  body: string;
  partstat: string;
}

/** The METHOD:REPLY for `invite`, answering as `attendee` (the address the invitation was sent to). */
export function buildInviteReply(
  invite: ParsedInvite,
  options: { attendeeAddress: string; attendeeName?: string; response: InviteResponse; comment?: string; now?: Date },
): InviteReply {
  const partstat = PARTSTAT[options.response];
  const name = options.attendeeName?.replace(/["\r\n]/g, "").trim();
  const attendee = `ATTENDEE;PARTSTAT=${partstat}${name ? `;CN="${name}"` : ""}:mailto:${options.attendeeAddress}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//proton-mail-bridge-client//invite reply//EN",
    "VERSION:2.0",
    "METHOD:REPLY",
    "CALSCALE:GREGORIAN",
    ...invite.timezones.flat(),
    "BEGIN:VEVENT",
    `UID:${invite.uid}`,
    `SEQUENCE:${invite.sequence}`,
    `DTSTAMP:${utcStamp(options.now ?? new Date())}`,
    ...invite.copy,
    attendee,
  ];
  const comment = options.comment?.trim();
  if (comment) lines.push(`COMMENT:${escapeText(comment)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  const ics = `${lines.flatMap((line) => fold(line)).join("\r\n")}\r\n`;

  const title = invite.summary?.trim() || "(no title)";
  const who = name || options.attendeeAddress;
  const body = [`${who} has ${VERB[options.response]} this invitation: ${title}.`, comment ? `\n${comment}` : ""].join("");
  return { ics, to: invite.organizer.address, subject: `${SUBJECT_PREFIX[options.response]}: ${title}`, body, partstat };
}
