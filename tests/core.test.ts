import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createIdentity } from "../src/identity.ts";
import { createEnvelope, parseEnvelope, ProtocolError } from "../src/protocol.ts";
import { getOrCreateSecret, PresenceStore } from "../src/presence.ts";

test("canonical identity groups symlinked cwd paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const link = join(root, "project-link");
  await mkdir(project);
  await symlink(project, link);

  const one = await createIdentity(project, "session-a", "Alpha", 101);
  const two = await createIdentity(link, "session-b", "Beta", 202);

  assert.equal(one.cwd, await realpath(project));
  assert.equal(one.swarmId, two.swarmId);
  assert.notEqual(one.peerId, two.peerId);
});

test("different exact working directories form different swarms", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, "a");
  const b = join(root, "b");
  await mkdir(a);
  await mkdir(b);
  assert.notEqual(
    (await createIdentity(a, "one", undefined, 1)).swarmId,
    (await createIdentity(b, "two", undefined, 2)).swarmId,
  );
});

test("protocol validates size, ttl, and target", () => {
  const envelope = createEnvelope({
    swarmId: "a".repeat(64),
    from: { peerId: "sender", sessionId: "s1", name: "Sender" },
    to: "receiver",
    body: "hello",
    now: 1_000,
    ttlMs: 5_000,
  });
  assert.equal(parseEnvelope(envelope, { now: 2_000 }).body, "hello");
  assert.throws(() => parseEnvelope({ ...envelope, to: "" }), ProtocolError);
  assert.throws(() => parseEnvelope({ ...envelope, body: "x".repeat(32 * 1024 + 1) }), ProtocolError);
  assert.throws(() => parseEnvelope(envelope, { now: 6_001 }), /expired/);
  assert.throws(() => parseEnvelope({ ...envelope, protocol: "pi-swarm/2" }), /protocol/);
});

test("presence lists live peers, excludes stale leases, and resolves ambiguity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-presence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PresenceStore(root, "b".repeat(64), { staleAfterMs: 1_000 });
  await store.init();
  await store.write({
    protocol: "pi-swarm/1",
    peerId: "p1",
    sessionId: "session-1111",
    name: "Worker",
    pid: process.pid,
    cwd: "/tmp/project",
    swarmId: "b".repeat(64),
    endpoint: "/tmp/p1.sock",
    state: "idle",
    capabilities: ["message"],
    updatedAt: 10_000,
  });
  await store.write({
    protocol: "pi-swarm/1",
    peerId: "p2",
    sessionId: "session-2222",
    name: "Worker",
    pid: process.pid,
    cwd: "/tmp/project",
    swarmId: "b".repeat(64),
    endpoint: "/tmp/p2.sock",
    state: "idle",
    capabilities: ["message"],
    updatedAt: 10_000,
  });
  await store.write({
    protocol: "pi-swarm/1",
    peerId: "stale",
    sessionId: "session-old",
    name: "Old",
    pid: process.pid,
    cwd: "/tmp/project",
    swarmId: "b".repeat(64),
    endpoint: "/tmp/old.sock",
    state: "idle",
    capabilities: ["message"],
    updatedAt: 1,
  });

  const peers = await store.list(10_500);
  assert.deepEqual(peers.map((peer) => peer.peerId), ["p1", "p2"]);
  assert.equal(store.resolve(peers, "session-1111").peerId, "p1");
  assert.throws(() => store.resolve(peers, "Worker"), /ambiguous/i);
  await store.remove("p1");
  await assert.rejects(readFile(join(root, "b".repeat(64), "peers", "p1.json")), /ENOENT/);
});

test("concurrent secret creation returns one complete shared secret", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-secret-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = await Promise.all(Array.from({ length: 20 }, () => getOrCreateSecret(root)));
  assert.equal(new Set(values).size, 1);
  assert.match(values[0], /^[a-f0-9]{64}$/);
});

test("presence ignores malformed and cross-swarm records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-presence-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const swarmId = "c".repeat(64);
  const store = new PresenceStore(root, swarmId);
  await store.init();
  const peersDir = join(root, swarmId, "peers");
  await writeFile(join(peersDir, "bad.json"), "not json");
  await writeFile(join(peersDir, "other.json"), JSON.stringify({ swarmId: "d".repeat(64) }));
  assert.deepEqual(await store.list(), []);
});
