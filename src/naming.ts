import { createHash } from "node:crypto";

// Keep these lists ordered and append-only: changing an existing entry would rename peers.
const ADJECTIVES = [
  "Absent",
  "Accidental",
  "Civil",
  "Considered",
  "Dubious",
  "Elegant",
  "Exquisite",
  "Friendly",
  "Gentle",
  "Gratuitous",
  "Implied",
  "Limited",
  "Minor",
  "Necessary",
  "Patient",
  "Plausible",
  "Polite",
  "Quiet",
  "Reasonable",
  "Reluctant",
  "Remote",
  "Sincere",
  "Slight",
  "Tactical",
  "Unforeseen",
  "Useful",
  "Vague",
  "Voluntary",
  "Wry",
] as const;

const NOUNS = [
  "Ambition",
  "Apology",
  "Consensus",
  "Delivery",
  "Detour",
  "Exception",
  "Failure",
  "Gesture",
  "Intervention",
  "Miscalculation",
  "Objection",
  "Optimism",
  "Paradox",
  "Patience",
  "Proposal",
  "Question",
  "Reminder",
  "Restraint",
  "Surprise",
  "Threat",
  "Victory",
  "Warning",
] as const;

/** Return a stable, Culture-inspired two-word alias for an opaque identifier. */
export function cultureName(identifier: string): string {
  const digest = createHash("sha256").update(`pi-swarm/culture-name/v1\0${identifier}`).digest();
  const adjective = ADJECTIVES[digest.readUInt16BE(0) % ADJECTIVES.length];
  const noun = NOUNS[digest.readUInt16BE(2) % NOUNS.length];
  return `${adjective} ${noun}`;
}

export function shortIdentifier(identifier: string): string {
  const uuidPrefix = identifier.match(/^([A-Za-z0-9]{8}-[A-Za-z0-9]{4})-/)?.[1];
  if (uuidPrefix) return `${uuidPrefix}…`;
  return identifier.slice(0, 8);
}
