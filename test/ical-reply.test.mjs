import test from "node:test";
import assert from "node:assert/strict";
import { InviteError, buildInviteReply, findMyAttendee, parseInvite } from "../dist/utils/ical-reply.js";

const crlf = (lines) => lines.join("\r\n") + "\r\n";

const GOOGLE = crlf([
  "BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", "METHOD:REQUEST",
  "BEGIN:VEVENT", "DTSTART:20261015T090000Z", "DTEND:20261015T093000Z", "DTSTAMP:20261001T120000Z",
  "ORGANIZER;CN=Anna Boss:mailto:anna@example.com", "UID:abc123@google.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Dawid P;X-NUM-GUESTS=0:mailto:dawid.piaskowski@proton.me",
  "ATTENDEE;PARTSTAT=ACCEPTED;CN=Anna Boss:mailto:anna@example.com",
  "SEQUENCE:2", "SUMMARY:Planning\\, Q4 review", "LOCATION:Berlin", "STATUS:CONFIRMED",
  "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT10M", "SUMMARY:alarm text", "END:VALARM",
  "END:VEVENT", "END:VCALENDAR",
]);

const OUTLOOK = crlf([
  "BEGIN:VCALENDAR", "METHOD:REQUEST", "PRODID:Microsoft Exchange Server 2010", "VERSION:2.0",
  "BEGIN:VTIMEZONE", "TZID:W. Europe Standard Time",
  "BEGIN:STANDARD", "DTSTART:16010101T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "END:STANDARD",
  "BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT", "ORGANIZER;CN=\"Boss, Bob\":MAILTO:bob@corp.example", "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Dawid:MAILTO:dawid@corp.example",
  "DESCRIPTION;LANGUAGE=en-US:Long text", "UID:040000008200E00074C5B7101A82E00800000000", "SUMMARY;LANGUAGE=en-US:Sync", "DTSTART;TZID=W. Europe Standard Time:20261020T140000",
  "DTEND;TZID=W. Europe Standard Time:20261020T150000", "RRULE:FREQ=WEEKLY;BYDAY=TU", "END:VEVENT", "END:VCALENDAR",
]);

const mine = (address) => address.toLowerCase() === "dawid.piaskowski@proton.me";

test("an invitation is read: uid, organizer, attendees, the copied lines, and only the event's own properties", () => {
  const invite = parseInvite(GOOGLE);
  assert.equal(invite.uid, "abc123@google.com");
  assert.equal(invite.sequence, "2");
  assert.equal(invite.summary, "Planning, Q4 review");
  assert.deepEqual(invite.organizer, { address: "anna@example.com", name: "Anna Boss" });
  assert.equal(invite.attendees.length, 2);
  assert.equal(findMyAttendee(invite, mine)?.partstat, "NEEDS-ACTION");
  assert.ok(invite.copy.includes("DTSTART:20261015T090000Z"));
  assert.ok(!invite.copy.some((line) => /alarm text/.test(line)), "the VALARM's SUMMARY is not the event's");
  assert.equal(invite.hasRecurrence, false);
});

test("time zones and a recurrence survive: the reply must define the zone its dates use", () => {
  const invite = parseInvite(OUTLOOK);
  assert.equal(invite.hasRecurrence, true);
  assert.deepEqual(invite.organizer, { address: "bob@corp.example", name: "Boss, Bob" });
  assert.equal(invite.timezones.length, 1);
  assert.deepEqual(invite.timezones[0].filter((line) => /^(BEGIN|END):/.test(line)), ["BEGIN:VTIMEZONE", "BEGIN:STANDARD", "END:STANDARD", "BEGIN:DAYLIGHT", "END:DAYLIGHT", "END:VTIMEZONE"]);
  const reply = buildInviteReply(invite, { attendeeAddress: "dawid@corp.example", response: "accept", now: new Date("2026-10-08T10:00:00Z") });
  assert.match(reply.ics, /BEGIN:VTIMEZONE\r\nTZID:W\. Europe Standard Time\r\nBEGIN:STANDARD/);
  assert.match(reply.ics, /DTSTART;TZID=W\. Europe Standard Time:20261020T140000\r\n/);
  assert.ok(!/RRULE/.test(reply.ics), "the reply answers the series without restating it");
});

test("the reply is a METHOD:REPLY with only the answering attendee, the uid and sequence, and CRLF line ends", () => {
  const invite = parseInvite(GOOGLE);
  const reply = buildInviteReply(invite, { attendeeAddress: "dawid.piaskowski@proton.me", attendeeName: "Dawid P", response: "accept", comment: "See you; bring slides, please", now: new Date("2026-10-08T10:00:00Z") });
  const lines = reply.ics.split("\r\n");
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.ok(lines.includes("METHOD:REPLY"));
  assert.ok(lines.includes("UID:abc123@google.com"));
  assert.ok(lines.includes("SEQUENCE:2"));
  assert.ok(lines.includes("DTSTAMP:20261008T100000Z"));
  assert.ok(lines.includes('ORGANIZER;CN="Anna Boss":mailto:anna@example.com'));
  const attendees = lines.filter((line) => line.startsWith("ATTENDEE"));
  assert.deepEqual(attendees, ['ATTENDEE;PARTSTAT=ACCEPTED;CN="Dawid P":mailto:dawid.piaskowski@proton.me']);
  assert.ok(lines.includes("COMMENT:See you\\; bring slides\\, please"));
  assert.ok(reply.ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/(?<!\r)\n/.test(reply.ics), "every line ends in CRLF");
  assert.equal(reply.to, "anna@example.com");
  assert.equal(reply.subject, "Accepted: Planning, Q4 review");
  assert.match(reply.body, /Dawid P has accepted this invitation: Planning, Q4 review\./);
});

test("each answer maps to its PARTSTAT and subject", () => {
  const invite = parseInvite(GOOGLE);
  for (const [response, partstat, subject] of [["accept", "ACCEPTED", "Accepted"], ["decline", "DECLINED", "Declined"], ["tentative", "TENTATIVE", "Tentative"]]) {
    const reply = buildInviteReply(invite, { attendeeAddress: "me@example.com", response });
    assert.match(reply.ics, new RegExp(`ATTENDEE;PARTSTAT=${partstat}`));
    assert.ok(reply.subject.startsWith(`${subject}: `));
    assert.equal(reply.partstat, partstat);
  }
});

test("long lines are folded at 75 octets without splitting a character, and unfold back to the original", () => {
  const long = "Zażółć gęślą jaźń ".repeat(8).trim();
  const invite = parseInvite(GOOGLE.replace("SUMMARY:Planning\\, Q4 review", `SUMMARY:${long}`));
  const reply = buildInviteReply(invite, { attendeeAddress: "me@example.com", response: "accept" });
  for (const line of reply.ics.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75, line);
  const unfolded = reply.ics.replace(/\r\n /g, "");
  assert.ok(unfolded.includes(`SUMMARY:${long}`));
  assert.ok(!reply.ics.includes("�"));
});

test("an invitation that cannot be answered says why", () => {
  const without = (pattern) => GOOGLE.split("\r\n").filter((line) => !pattern.test(line)).join("\r\n");
  assert.throws(() => parseInvite(GOOGLE.replace("METHOD:REQUEST", "METHOD:CANCEL")), (e) => e instanceof InviteError && /cancelled/.test(e.message));
  assert.throws(() => parseInvite(GOOGLE.replace("METHOD:REQUEST", "METHOD:REPLY")), (e) => e instanceof InviteError && /REPLY/.test(e.message));
  assert.throws(() => parseInvite(without(/^ORGANIZER/)), (e) => e instanceof InviteError && /organizer/.test(e.message));
  assert.throws(() => parseInvite(without(/^UID/)), (e) => e instanceof InviteError && /UID/.test(e.message));
  assert.throws(() => parseInvite("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n"), (e) => e instanceof InviteError && /no calendar event/.test(e.message));
});

test("an attendee name cannot break out of the CN parameter", () => {
  const invite = parseInvite(GOOGLE);
  const reply = buildInviteReply(invite, { attendeeAddress: "me@example.com", attendeeName: 'Evil"\r\nATTENDEE:mailto:x@y.z', response: "accept" });
  assert.equal(reply.ics.split("\r\n").filter((line) => line.startsWith("ATTENDEE")).length, 1);
});

test("a hostile VTIMEZONE cannot inject components or properties into the reply", () => {
  const evil = crlf([
    "BEGIN:VCALENDAR", "METHOD:REQUEST",
    "BEGIN:VTIMEZONE", "TZID:x", "BEGIN:STANDARD", "TZOFFSETFROM:+0000", "TZOFFSETTO:+0100", "END:STANDARD",
    "END:VEVENT", "BEGIN:VEVENT", "UID:other-event", "ATTENDEE;PARTSTAT=DECLINED:mailto:me@ex.test", "END:VEVENT", "ATTACH:http://evil.example/x",
    "END:VTIMEZONE",
    "BEGIN:VEVENT", "UID:real", "ORGANIZER:mailto:o@x.test", "DTSTART:20261015T090000Z", "SUMMARY:hi", "END:VEVENT", "END:VCALENDAR",
  ]);
  const reply = buildInviteReply(parseInvite(evil), { attendeeAddress: "me@ex.test", response: "accept" });
  assert.equal((reply.ics.match(/BEGIN:VEVENT/g) ?? []).length, 1);
  assert.ok(!reply.ics.includes("other-event"));
  assert.ok(!reply.ics.includes("evil.example"));
  assert.ok(reply.ics.includes("TZOFFSETTO:+0100"));
});

test("an invitation nested too deeply or with a huge title is bounded", () => {
  const deep = "BEGIN:VCALENDAR\r\n" + "BEGIN:A\r\n".repeat(50) + "END:A\r\n".repeat(50) + "END:VCALENDAR\r\n";
  assert.throws(() => parseInvite(deep), InviteError);
  const big = crlf(["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:u", "ORGANIZER:mailto:a@b.test", `SUMMARY:${"x".repeat(100000)}`, "END:VEVENT", "END:VCALENDAR"]);
  const reply = buildInviteReply(parseInvite(big), { attendeeAddress: "me@x.test", response: "accept" });
  assert.ok(reply.subject.length <= 220);
  assert.ok(reply.ics.length < 2000);
});

test("copied lines carry no control characters, no foreign organizer parameters, and are bounded", () => {
  const base = (extra) => crlf(["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:u", ...extra, "END:VEVENT", "END:VCALENDAR"]);
  const reply = buildInviteReply(parseInvite(base([
    'ORGANIZER;SENT-BY="mailto:a@b.test";X-FOO=1:mailto:bob@evil.test?cc=victim@z.test',
    "DTEND:20300101\u2028ATTENDEE:mailto:x@y.test\u0007\u001b[31m",
  ])), { attendeeAddress: "me@x.test", response: "accept" });
  assert.ok(!/[\u2028\u2029\u0007\u001b]/.test(reply.ics));
  assert.ok(!reply.ics.includes("SENT-BY") && !reply.ics.includes("X-FOO") && !reply.ics.includes("victim@z.test"));
  assert.throws(() => parseInvite(base(["ORGANIZER:mailto:a@b.test", `DTEND:${"2".repeat(5000)}`])), InviteError);
  assert.throws(() => parseInvite(base([`ORGANIZER:mailto:${"a".repeat(400)}@b.test`])), InviteError);
});
