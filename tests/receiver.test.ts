import assert from "node:assert/strict";
import test from "node:test";

import { SwarmReceiver } from "../src/receiver.ts";
import { createEnvelope } from "../src/protocol.ts";

const envelope = createEnvelope({
  swarmId: "f".repeat(64),
  from: { peerId: "peer-a", sessionId: "session-a", name: "Alpha" },
  to: "peer-b",
  body: "Please inspect the tests",
});

test("idle receiver persists an attributed custom message and triggers a turn", async () => {
  const calls: Array<{ message: unknown; options: unknown }> = [];
  const receiver = new SwarmReceiver({
    peerId: "peer-b",
    isIdle: () => true,
    sendMessage: (message, options) => calls.push({ message, options }),
  });

  assert.deepEqual(await receiver.accept(envelope), { status: "accepted" });
  assert.equal(calls.length, 1);
  assert.match((calls[0].message as { content: string }).content, /Alpha/);
  assert.equal((calls[0].message as { customType: string }).customType, "swarm:message");
  assert.equal((calls[0].message as { details: { envelope: { id: string } } }).details.envelope.id, envelope.id);
  assert.deepEqual(calls[0].options, { triggerTurn: true });
});

test("busy receiver uses steering delivery", async () => {
  const options: unknown[] = [];
  const receiver = new SwarmReceiver({
    peerId: "peer-b",
    isIdle: () => false,
    sendMessage: (_message, value) => options.push(value),
  });
  await receiver.accept(envelope);
  assert.deepEqual(options, [{ deliverAs: "steer", triggerTurn: true }]);
});

test("receiver deduplicates message IDs", async () => {
  let calls = 0;
  const receiver = new SwarmReceiver({
    peerId: "peer-b",
    isIdle: () => true,
    sendMessage: () => { calls += 1; },
    seenIds: [envelope.id],
  });
  assert.deepEqual(await receiver.accept(envelope), { status: "duplicate" });
  assert.equal(calls, 0);
});

test("receiver rejects envelopes addressed elsewhere", async () => {
  const receiver = new SwarmReceiver({ peerId: "peer-c", isIdle: () => true, sendMessage: () => {} });
  await assert.rejects(receiver.accept(envelope), /addressed/);
});
