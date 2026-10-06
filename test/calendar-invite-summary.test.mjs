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
