import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCalendarText } from "../dist/utils/helpers.js";

// Found live: an invite.ics with a VTIMEZONE block ahead of its VEVENT was summarized as
// "Starts 19700329T020000" — the DTSTART of the Europe/Berlin DAYLIGHT rule — because the
// summarizer kept the first DTSTART in file order instead of the one inside BEGIN:VEVENT.
const INVITE_WITH_VTIMEZONE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Proton AG//ProtonCalendar//EN",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:abc-123@proton.me",
  "SUMMARY:Project sync",
  "ORGANIZER;CN=Alice:mailto:alice@example.com",
  "DTSTART;TZID=Europe/Berlin:20261012T170000",
  "DTEND;TZID=Europe/Berlin:20261012T180000",
  "LOCATION:Room 4",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("summarizeCalendarText reports the VEVENT's DTSTART/DTEND, not the VTIMEZONE rule's", () => {
  const summary = summarizeCalendarText(INVITE_WITH_VTIMEZONE);
  assert.ok(summary);
  assert.match(summary, /Starts 20261012T170000/);
  assert.match(summary, /Ends 20261012T180000/);
  assert.doesNotMatch(summary, /19700329T020000|19701025T030000/);
  assert.equal(
    summary,
    "Project sync | mailto:alice@example.com | Starts 20261012T170000 | Ends 20261012T180000 | Location Room 4",
  );
});

test("summarizeCalendarText still summarizes a bare VEVENT-less snippet", () => {
  const summary = summarizeCalendarText("SUMMARY:Standup\nDTSTART:20261013T090000Z\n");
  assert.equal(summary, "Standup | Starts 20261013T090000Z");
});

test("with several VEVENTs the first one is summarized, not a mix of them", () => {
  const ics = [
    "BEGIN:VCALENDAR", "BEGIN:VEVENT", "SUMMARY:First", "DTSTART:20261012T170000Z", "END:VEVENT",
    "BEGIN:VEVENT", "SUMMARY:Second", "DTSTART:20261013T090000Z", "DTEND:20261013T100000Z", "LOCATION:Elsewhere", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  assert.equal(summarizeCalendarText(ics), "First | Starts 20261012T170000Z | +1 more event");
});

const wrap = (...events) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
const vevent = (...props) => ["BEGIN:VEVENT", ...props, "END:VEVENT"].join("\r\n");

test("a folded long line is joined, so the end of a long SUMMARY is not lost", () => {
  const ics = wrap(vevent("SUMMARY:Quarterly planning meeting for the whole", "  product organisation", "DTSTART:20261012T170000Z"));
  assert.equal(summarizeCalendarText(ics), "Quarterly planning meeting for the whole product organisation | Starts 20261012T170000Z");
});

test("a quoted parameter that contains a colon does not cut the value in the wrong place", () => {
  const ics = wrap(vevent('ORGANIZER;CN="Doe: John":mailto:j@x.com', "SUMMARY:Sync", "DTSTART:20261012T170000Z"));
  assert.equal(summarizeCalendarText(ics), "Sync | mailto:j@x.com | Starts 20261012T170000Z");
});

test("escaped characters in text values are unescaped", () => {
  const ics = wrap(vevent("SUMMARY:Lunch\\, then review\; notes", "LOCATION:Room 4\\nFloor 2", "DTSTART:20261012T170000Z"));
  assert.equal(summarizeCalendarText(ics), "Lunch, then review; notes | Starts 20261012T170000Z | Location Room 4 Floor 2");
});

test("a cancelled meeting is marked as cancelled, by METHOD or by STATUS", () => {
  const byMethod = ["BEGIN:VCALENDAR", "METHOD:CANCEL", vevent("SUMMARY:Standup", "DTSTART:20260101T100000Z"), "END:VCALENDAR"].join("\r\n");
  assert.equal(summarizeCalendarText(byMethod), "[Cancelled] Standup | Starts 20260101T100000Z");
  const byStatus = wrap(vevent("SUMMARY:Standup", "STATUS:CANCELLED", "DTSTART:20260101T100000Z"));
  assert.equal(summarizeCalendarText(byStatus), "[Cancelled] Standup | Starts 20260101T100000Z");
  assert.equal(summarizeCalendarText(wrap(vevent("SUMMARY:Standup", "STATUS:CONFIRMED", "DTSTART:20260101T100000Z"))), "Standup | Starts 20260101T100000Z");
});

test("a calendar with several events says how many more there are", () => {
  const ics = wrap(vevent("SUMMARY:First", "DTSTART:20261012T170000Z"), vevent("SUMMARY:Second", "DTSTART:20261013T090000Z"), vevent("SUMMARY:Third", "DTSTART:20261014T090000Z"));
  assert.equal(summarizeCalendarText(ics), "First | Starts 20261012T170000Z | +2 more events");
});

test("a calendar with a timezone block but no event does not report the timezone rule as the start", () => {
  const ics = wrap("BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "BEGIN:DAYLIGHT", "DTSTART:19700329T020000", "END:DAYLIGHT", "END:VTIMEZONE");
  assert.doesNotMatch(summarizeCalendarText(ics) ?? "", /Starts 19700329/);
});
