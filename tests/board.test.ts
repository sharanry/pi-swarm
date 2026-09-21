import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BoardStore, parseBoardAddress } from "../src/board.ts";

const senderA = { peerId: "peer-a", sessionId: "session-a", name: "Alpha" };
const senderB = { peerId: "peer-b", sessionId: "session-b", name: "Beta" };

test("board addresses use s/<topic-slug>/<conv-slug>", () => {
  assert.deepEqual(parseBoardAddress("s/release-planning/api-review"), {
    address: "s/release-planning/api-review",
    topic: "release-planning",
    conversation: "api-review",
  });
  for (const invalid of ["release/api", "s/UPPER/api", "s/topic", "s/topic/../api", "s/topic/api/extra"]) {
    assert.throws(() => parseBoardAddress(invalid), /board address/i);
  }
});

test("boards persist messages and track unread messages once per session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-board-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new BoardStore(root, "a".repeat(64));

  await store.post("s/release/api", senderA, "first", { now: 1_000, id: "message-a" });
  await store.post("s/release/api", senderB, "second", { now: 2_000, id: "message-b" });

  const summaries = await store.list("session-c");
  assert.deepEqual(summaries.map(({ address, messageCount, unreadCount }) => ({ address, messageCount, unreadCount })), [
    { address: "s/release/api", messageCount: 2, unreadCount: 2 },
  ]);

  const firstDrain = await store.drainUnread("session-c");
  assert.deepEqual(firstDrain.map((thread) => thread.address), ["s/release/api"]);
  assert.deepEqual(firstDrain[0].messages.map((message) => message.body), ["first", "second"]);
  assert.deepEqual(await store.drainUnread("session-c"), []);
  assert.equal((await store.list("session-c"))[0].unreadCount, 0);

  assert.equal((await store.list("another-session"))[0].unreadCount, 2);
});

test("a session does not receive its own posts but advances past them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-board-own-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new BoardStore(root, "b".repeat(64));

  await store.post("s/design/names", senderA, "my own post", { now: 1_000, id: "own" });
  assert.deepEqual(await store.drainUnread("session-a"), []);
  await store.post("s/design/names", senderB, "a reply", { now: 2_000, id: "reply" });
  const unread = await store.drainUnread("session-a");
  assert.deepEqual(unread[0].messages.map((message) => message.body), ["a reply"]);
  assert.deepEqual(await store.drainUnread("session-a"), []);
});

test("same-timestamp posts arriving after a cursor are not skipped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-board-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new BoardStore(root, "e".repeat(64));
  await store.post("s/topic/conv", senderA, "first", { now: 1_000, id: "first" });
  assert.equal((await store.drainUnread("reader"))[0].messages.length, 1);
  await store.post("s/topic/conv", senderB, "same millisecond", { now: 1_000, id: "second" });
  assert.deepEqual((await store.drainUnread("reader"))[0].messages.map((message) => message.body), ["same millisecond"]);
});

test("board state is isolated by cwd-derived swarm id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-board-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const one = new BoardStore(root, "c".repeat(64));
  const two = new BoardStore(root, "d".repeat(64));
  await one.post("s/topic/conv", senderA, "only here");
  assert.equal((await one.list("reader")).length, 1);
  assert.deepEqual(await two.list("reader"), []);
});
