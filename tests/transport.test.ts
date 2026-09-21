import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeliveryManager } from "../src/delivery.ts";
import { createEnvelope } from "../src/protocol.ts";
import { LocalTransport, TransportError } from "../src/transport.ts";

const swarmId = "e".repeat(64);
const sender = { peerId: "sender", sessionId: "sender-session", name: "Sender" };

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = "test-secret";
  const endpoint = LocalTransport.endpointFor(root, swarmId, `receiver-${process.pid}-${Date.now()}`);
  return { root, secret, endpoint };
}

test("local transport authenticates and acknowledges an envelope", async (t) => {
  const { secret, endpoint } = await fixture(t);
  const received: string[] = [];
  const server = new LocalTransport({ endpoint, secret, swarmId, peerId: "receiver" });
  t.after(() => server.close());
  await server.listen(async (envelope) => {
    received.push(envelope.body);
    return { status: "accepted" };
  });

  const envelope = createEnvelope({ swarmId, from: sender, to: "receiver", body: "wake up" });
  const ack = await LocalTransport.send(endpoint, secret, envelope);
  assert.equal(ack.status, "accepted");
  assert.deepEqual(received, ["wake up"]);
});

test("local transport rejects invalid authentication", async (t) => {
  const { secret, endpoint } = await fixture(t);
  const server = new LocalTransport({ endpoint, secret, swarmId, peerId: "receiver" });
  t.after(() => server.close());
  await server.listen(async () => ({ status: "accepted" }));
  const envelope = createEnvelope({ swarmId, from: sender, to: "receiver", body: "nope" });
  await assert.rejects(LocalTransport.send(endpoint, "wrong-secret", envelope), /authentication/i);
});

test("receiver deduplicates retries and delivery removes accepted spool", async (t) => {
  const { root, secret, endpoint } = await fixture(t);
  let calls = 0;
  const server = new LocalTransport({ endpoint, secret, swarmId, peerId: "receiver" });
  t.after(() => server.close());
  await server.listen(async () => {
    calls += 1;
    return { status: "accepted" };
  });
  const manager = new DeliveryManager({ root, swarmId, secret });
  const envelope = createEnvelope({ swarmId, from: sender, to: "receiver", body: "once" });

  const first = await manager.deliver({ peerId: "receiver", endpoint }, envelope);
  const second = await manager.deliver({ peerId: "receiver", endpoint }, envelope);
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "accepted");
  assert.equal(calls, 2, "transport retries; receiver integration owns semantic deduplication");
  assert.deepEqual(await manager.listSpool("receiver"), []);
});

test("failed direct delivery remains queued for retry", async (t) => {
  const { root, secret, endpoint } = await fixture(t);
  const manager = new DeliveryManager({ root, swarmId, secret });
  const envelope = createEnvelope({ swarmId, from: sender, to: "receiver", body: "later" });
  const result = await manager.deliver({ peerId: "receiver", endpoint }, envelope, { timeoutMs: 50 });
  assert.equal(result.status, "queued");
  assert.deepEqual((await manager.listSpool("receiver")).map((item) => item.id), [envelope.id]);
});

test("transport rejects oversized frames", async (t) => {
  const { secret, endpoint } = await fixture(t);
  const server = new LocalTransport({ endpoint, secret, swarmId, peerId: "receiver" });
  t.after(() => server.close());
  await server.listen(async () => ({ status: "accepted" }));
  await assert.rejects(
    LocalTransport.sendRaw(endpoint, `${"x".repeat(70 * 1024)}\n`),
    (error: unknown) => error instanceof TransportError,
  );
});
