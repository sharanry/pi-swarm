import assert from "node:assert/strict";
import test from "node:test";

import { cultureName, shortIdentifier } from "../src/naming.ts";

test("culture names are deterministic and contain at most three words", () => {
  const identifier = "01a0c41e-b9ed-74fb-b71d-c4cf7b89237a";
  const first = cultureName(identifier);

  assert.equal(cultureName(identifier), first);
  assert.match(first, /^[A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*){1,2}$/);
  assert.ok(first.split(" ").length <= 3);
});

test("culture names vary with the full identifier", () => {
  assert.notEqual(
    cultureName("01a0c41e-b9ed-74fb-b71d-c4cf7b89237a"),
    cultureName("01a0c41e-ef90-70de-9156-11f19214cb24"),
  );
});

test("identifiers retain a compact recognizable prefix", () => {
  assert.equal(shortIdentifier("01a0c41e-b9ed-74fb"), "01a0c41e-b9ed…");
  assert.equal(shortIdentifier("short"), "short");
});
