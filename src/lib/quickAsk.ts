// Quick ask (src/screens/QuickAsk.tsx): who a message @-names, so the box can show them as chips and send it to the
// first one. Pure, so it can be checked without the app.

import { firstName } from "./format";

export type Named = { id: string; name: string };
/** A run of the message: plain text, or a person it names (`who`). */
export type Piece<T extends Named = Named> = { text: string; who?: T };

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What can follow @ for each person: the full name, and the first name when nobody else shares it. */
function namesOf<T extends Named>(people: T[]): { name: string; who: T }[] {
  const shared = (first: string) => people.filter((p) => firstName(p.name).toLowerCase() === first.toLowerCase()).length > 1;
  const out: { name: string; who: T }[] = [];
  for (const p of people) {
    out.push({ name: p.name, who: p });
    const first = firstName(p.name);
    if (first !== p.name && !shared(first)) out.push({ name: first, who: p });
  }
  // Longest first, so "Steve Jobs" wins over "Steve".
  return out.sort((a, b) => b.name.length - a.name.length);
}

/** The message in pieces, each person it @-names as their own piece ("@Ada", "@steve jobs", any case). Only @ names
 *  someone: many names are everyday words (Ledger, Coral, Tally), so a bare word is never taken as one. */
export function namedPieces<T extends Named>(text: string, people: T[]): Piece<T>[] {
  const names = namesOf(people);
  if (!names.length) return text ? [{ text }] : [];
  const pattern = new RegExp(`@(?:${names.map((n) => escape(n.name)).join("|")})`, "giu");
  const pieces: Piece<T>[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index;
    const end = start + m[0].length;
    const said = m[0].slice(1).toLowerCase();
    const hit = names.find((n) => n.name.toLowerCase() === said);
    if (!hit || isWordChar(text[start - 1]) || isWordChar(text[end])) continue;
    if (start > at) pieces.push({ text: text.slice(at, start) });
    pieces.push({ text: m[0], who: hit.who });
    at = end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

/** Who a quick ask goes to: the first person it @-names, or null when it names nobody. */
export function recipient<T extends Named>(pieces: Piece<T>[]): T | null {
  return pieces.find((p) => p.who)?.who ?? null;
}

/** The @ being typed just before the caret, and what follows it so far, to list the people it could be. Null once
 *  there is a space after it, or the @ is inside a word (an email address). */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0 || isWordChar(before[start - 1])) return null;
  const query = before.slice(start + 1);
  return /\s/.test(query) ? null : { start, query };
}

/** The people an @ query lists: whose name or any word of it starts with the query, in the order given. */
export function mentionMatches<T extends Named>(people: T[], query: string): T[] {
  const q = query.toLowerCase();
  return people.filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
}

/** The text with the @ query at `start` replaced by the person's name and a space, and where the caret goes. */
export function pickMention(text: string, start: number, caret: number, who: Named): { text: string; caret: number } {
  const name = `@${who.name} `;
  return { text: text.slice(0, start) + name + text.slice(caret), caret: start + name.length };
}
