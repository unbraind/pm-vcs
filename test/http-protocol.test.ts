/** Untrusted envelope validation complements the real-socket transport tests. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as protocol from "../engine/http-protocol.ts";

const id = "a".repeat(64);
const update = { ref: "refs/heads/main", expected: null, next: id };

test("wire decoders refuse malformed JSON, error envelopes, ref moves and objects", () => {
  for (const text of ["broken", "null", "[]", "42"]) {
    assert.equal(protocol.decodeWireObject(Buffer.from(text)), null);
    assert.equal(protocol.decodeErrorBody(Buffer.from(text)), null);
  }
  for (const error of [null, [], 1, {}, { code: 1, message: "m" }, { code: "c", message: 1 }]) {
    assert.equal(protocol.decodeErrorBody(Buffer.from(JSON.stringify({ error }))), null);
  }
  assert.deepEqual(protocol.decodeErrorBody(protocol.encodeErrorBody("c", "m")), { code: "c", message: "m" });
  for (const body of [{}, { refs: [], haves: [1] }, { refs: [1], haves: [] }, { refs: [], haves: ["bad"] }]) {
    assert.equal(protocol.decodeFetchRequest(body), null);
  }
  for (const value of [null, {}, [null], [[]], [1], [{ ...update, ref: 1 }], [{ ...update, ref: "" }], [{ ...update, expected: "bad" }], [{ ...update, next: null }], [{ ...update, next: 1 }]]) {
    assert.equal(protocol.decodePushUpdates({ updates: value }, "updates"), null);
  }
  assert.deepEqual(protocol.decodePushUpdates({ updates: [{ ...update, expected: id }] }, "updates"), [{ ...update, expected: id }]);
  assert.equal(protocol.decodeMissingRequest({}), null);
  assert.equal(protocol.decodeMissingRequest({ ids: ["bad"] }), null);
  for (const body of [{}, { session: "", objects: [] }, { session: "s", objects: {} }, { session: "s", objects: [null] }, { session: "s", objects: [[]] }, { session: "s", objects: [{ id, type: "unknown", payload: "" }] }, { session: "s", objects: [{ id: "bad", type: "blob", payload: "" }] }, { session: "s", objects: [{ id, type: "blob", payload: 1 }] }]) {
    assert.equal(protocol.decodeUploadRequest(body), null);
  }
  for (const body of [{}, { updated: [], added: ["bad"] }, { updated: [], added: 1 }]) assert.equal(protocol.decodePushReceipt(body), null);
  assert.deepEqual(protocol.decodePushReceipt({ updated: [], added: [id] }), { updated: [], added: [id] });
  for (const now of [undefined, null, "today", Infinity, 1e30]) assert.equal(protocol.decodeWireDate({ now }, "now"), null);
  assert.equal(protocol.decodeWireDate({ now: 0 }, "now")?.getTime(), 0);
  protocol.assertWireSuccess(204, Buffer.alloc(0), "peer");
  assert.throws(() => protocol.assertWireSuccess(400, protocol.encodeErrorBody("c", "m"), "peer"), { code: "c" });
});
