// The reading these pin: an uncommitted edit names its pieces the way a commit
// does — a new function as added, an edited one as reworked, one whose
// definition is gone as removed — so the same plain-language lines can be asked
// for each.

import { expect, test } from "bun:test";

import type { OutlineNode } from "./api";
import { workingPieces } from "./workingPieces";

// After the edit:
//  1 import x
//  2
//  3 export function sendEmail(to) {
//  4   return deliver(to, { retries: 3 });
//  5 }
//  6
//  7 export function scheduleDigest(user) {
//  8   return queue(user);
//  9 }
// 10
// 11 export class Mailer {}
const outline: OutlineNode[] = [
  { kind: "fn", name: "sendEmail", line: 3 },
  { kind: "fn", name: "scheduleDigest", line: 7 },
  { kind: "class", name: "Mailer", line: 11 },
];

const diff = [
  "diff --git a/src/mail.ts b/src/mail.ts",
  "--- a/src/mail.ts",
  "+++ b/src/mail.ts",
  "@@ -1,14 +1,11 @@",
  " import x",
  " ",
  " export function sendEmail(to) {",
  "-  return deliver(to);",
  "+  return deliver(to, { retries: 3 });",
  " }",
  " ",
  "-export function legacySend(to) {",
  "-  return deliver(to);",
  "-}",
  "-",
  "+export function scheduleDigest(user) {",
  "+  return queue(user);",
  "+}",
  "+",
  " export class Mailer {}",
].join("\n");

test("names added, reworked and removed pieces", () => {
  const pieces = workingPieces(diff, outline);
  expect(pieces.map((p) => [p.change, p.identifier, p.kind])).toEqual([
    ["modified", "sendEmail", "fn"],
    ["added", "scheduleDigest", "fn"],
    ["deleted", "legacySend", "fn"],
  ]);
  expect(pieces[0].start_line).toBe(3);
  expect(pieces[0].end_line).toBe(6);
});

test("a renamed signature is a rework, not an add", () => {
  const d = [
    "@@ -1,3 +1,3 @@",
    "-fn total(items: &[Item]) -> u32 {",
    "+fn total(items: &[Item], tax: u32) -> u32 {",
    "     items.len() as u32",
    " }",
  ].join("\n");
  const p = workingPieces(d, [{ kind: "fn", name: "total", line: 1 }]);
  expect(p.map((x) => [x.change, x.identifier])).toEqual([["modified", "total"]]);
});

test("no diff, no pieces", () => {
  expect(workingPieces("", outline)).toEqual([]);
});
