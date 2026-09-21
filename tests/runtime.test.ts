import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SwarmRuntime } from "../src/runtime.ts";

test("two runtimes in the same cwd discover and message each other", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-runtime-"));
  const cwd = join(root, "project");
  const state = join(root, "state");
  await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  const received: Array<{ content: string; options: unknown }> = [];
  const a = new SwarmRuntime({ cwd, sessionId: "session-a", name: "Alpha", root: state, isIdle: () => true, sendMessage: () => {} });
  const b = new SwarmRuntime({
    cwd,
    sessionId: "session-b",
    name: "Beta",
    root: state,
    isIdle: () => true,
    sendMessage: (message, options) => received.push({ content: message.content, options }),
  });
  t.after(async () => { await a.stop(); await b.stop(); });
  await a.start();
  await b.start();

  assert.deepEqual((await a.listPeers()).map((peer) => peer.name), ["Beta"]);
  const result = await a.send("Beta", "hello from alpha");
  assert.equal(result[0].status, "accepted");
  assert.match(received[0].content, /hello from alpha/);
  assert.deepEqual(received[0].options, { triggerTurn: true });
});

test("opening and active sessions receive each board message exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-runtime-board-"));
  const cwd = join(root, "project");
  const state = join(root, "state");
  await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));

  const author = new SwarmRuntime({ cwd, sessionId: "author-session", root: state, isIdle: () => true, sendMessage: () => {} });
  await author.start();
  await author.postBoard("s/release/api", "before reader opens");
  await author.postBoard("s/release/api", "also before reader opens");
  await author.stop();

  const received: Array<{ message: any; options: any }> = [];
  let resolveActiveNotice: (() => void) | undefined;
  const activeNotice = new Promise<void>((resolve) => { resolveActiveNotice = resolve; });
  let idle = true;
  const reader = new SwarmRuntime({
    cwd,
    sessionId: "reader-session",
    root: state,
    heartbeatMs: 20,
    isIdle: () => idle,
    sendMessage: (message, options) => {
      received.push({ message, options });
      if (received.length === 2) resolveActiveNotice?.();
    },
  });
  t.after(() => reader.stop());
  await reader.start();

  assert.equal(received.length, 1);
  assert.equal(received[0].message.customType, "swarm:board");
  assert.match(received[0].message.content, /2 unread messages/);
  assert.match(received[0].message.content, /before reader opens/);
  assert.match(received[0].message.content, /also before reader opens/);
  assert.deepEqual(received[0].options, { triggerTurn: true });
  await reader.checkBoards();
  assert.equal(received.length, 1);

  const secondAuthor = new SwarmRuntime({ cwd, sessionId: "second-author", root: state, isIdle: () => true, sendMessage: () => {} });
  t.after(() => secondAuthor.stop());
  await secondAuthor.start();
  idle = false;
  await secondAuthor.postBoard("s/release/api", "while reader is active");
  await Promise.race([
    activeNotice,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("active board notification timed out")), 500)),
  ]);

  assert.equal(received.length, 2);
  assert.match(received[1].message.content, /while reader is active/);
  assert.deepEqual(received[1].options, { triggerTurn: true, deliverAs: "followUp" });
  await reader.checkBoards();
  assert.equal(received.length, 2);
});

test("runtime reports compact incoming and outgoing activity counts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-runtime-activity-"));
  const cwd = join(root, "project");
  const state = join(root, "state");
  await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  const activityA: Array<{ incoming: number; outgoing: number }> = [];
  const activityB: Array<{ incoming: number; outgoing: number }> = [];
  const a = new SwarmRuntime({
    cwd, sessionId: "activity-a", name: "Alpha", root: state, isIdle: () => true, sendMessage: () => {},
    onActivity: (activity) => activityA.push(activity),
  });
  const b = new SwarmRuntime({
    cwd, sessionId: "activity-b", name: "Beta", root: state, isIdle: () => true, sendMessage: () => {},
    onActivity: (activity) => activityB.push(activity),
  });
  t.after(async () => { await a.stop(); await b.stop(); });
  await a.start();
  await b.start();
  await a.send("Beta", "direct");
  await a.postBoard("s/activity/counts", "durable");
  await b.checkBoards();

  assert.deepEqual(activityA.at(-1), { incoming: 0, outgoing: 2 });
  assert.deepEqual(activityB.at(-1), { incoming: 2, outgoing: 0 });
});

test("runtimes in different cwd values cannot discover each other", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-runtime-scope-"));
  const cwdA = join(root, "a");
  const cwdB = join(root, "b");
  await mkdir(cwdA);
  await mkdir(cwdB);
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = { root: join(root, "state"), isIdle: () => true, sendMessage: () => {} };
  const a = new SwarmRuntime({ ...base, cwd: cwdA, sessionId: "a" });
  const b = new SwarmRuntime({ ...base, cwd: cwdB, sessionId: "b" });
  t.after(async () => { await a.stop(); await b.stop(); });
  await a.start();
  await b.start();
  assert.deepEqual(await a.listPeers(), []);
  await a.postBoard("s/private/topic", "cwd-a only");
  assert.deepEqual(await b.listBoards(), []);
  await assert.rejects(a.send("b", "hello"), /No live/);
});
