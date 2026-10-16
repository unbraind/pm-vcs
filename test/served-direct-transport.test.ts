import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { exportBundle, parseBundle } from "../engine/bundle.ts";
import { HttpTransport } from "../engine/http-transport.ts";
import { hashObject } from "../engine/objects.ts";
import { Repository } from "../engine/repo.ts";
import { startRepositoryServer, TokenGrants } from "../engine/serve.ts";
import type { Advertisement } from "../engine/transport.ts";
import { makeTempDir } from "./helpers/tmp.ts";

/** Serve catalogued parent and nested repositories through a capability-filtering legacy peer. */
async function servePair(legacy: boolean) {
  const directory = makeTempDir();
  const parent = Repository.init(join(directory.root, "tenant"));
  const nested = Repository.init(join(parent.root, "objects"));
  const parentId = parent.objects.write("blob", Buffer.from("parent-only"));
  const nestedId = nested.objects.write("blob", Buffer.from("nested-only"));
  const addressed: string[] = [];
  const server = await startRepositoryServer({
    root: directory.root, host: "127.0.0.1", port: 0,
    grants: new TokenGrants([
      { token: "both-repositories", repository: "tenant", access: "write" },
      { token: "both-repositories", repository: "tenant/objects", access: "write" },
    ]),
    hooks: { holdResponse(repository, endpoint) { addressed.push(`${repository}:${endpoint}`); } },
  });
  const routes: string[] = [];
  const peer = createServer(async (request, response) => {
    const route = request.url ?? "";
    routes.push(route);
    // A legacy peer rejects the new namespace, advertises no support for it,
    // and dispatches its old suffixes to the actual parent served repository.
    if (legacy && route.includes("/.pmvcs/")) {
      request.resume(); response.writeHead(404); response.end(); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const upstreamRoute = legacy ? route.replace("/tenant/", "/tenant/.pmvcs/") : route;
    const upstream = await fetch(`http://127.0.0.1:${server.port}${upstreamRoute}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer both-repositories" },
      body: Buffer.concat(chunks).toString("utf8"),
    });
    let body = Buffer.from(await upstream.arrayBuffer());
    if (legacy && route === "/tenant/advertise") {
      const advertisement = JSON.parse(body.toString("utf8")) as Advertisement;
      body = Buffer.from(JSON.stringify({ ...advertisement, capabilities: advertisement.capabilities.filter(capability => capability !== "explicit-endpoints") }));
    }
    response.writeHead(upstream.status); response.end(body);
  });
  await new Promise<void>(resolve => { peer.listen(0, "127.0.0.1", resolve); });
  const address = peer.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    parent, nested, parentId, nestedId, routes, addressed,
    /** Construct an unnegotiated production transport for the parent. */
    wire() { return new HttpTransport(`http://127.0.0.1:${address.port}/tenant`, { token: "both-repositories" }); },
    /** Close both real listeners before removing the fixture. */
    async close() {
      await new Promise<void>(resolve => { peer.close(() => resolve()); peer.closeAllConnections(); });
      await server.close(); directory.cleanup();
    },
  };
}

for (const legacy of [false, true]) {
  const mode = legacy ? "legacy" : "explicit";
  const prefix = legacy ? "/tenant/" : "/tenant/.pmvcs/";

  test(`direct missingObjects negotiates once for the parent beside nested objects (${mode})`, async () => {
    const pair = await servePair(legacy);
    try {
      const wire = pair.wire();
      assert.deepEqual(await wire.missingObjects([pair.parentId, pair.nestedId]), [pair.nestedId]);
      assert.deepEqual(await wire.missingObjects([pair.parentId]), []);
      assert.deepEqual(pair.routes, ["/tenant/advertise", `${prefix}objects/missing`, `${prefix}objects/missing`]);
      assert.deepEqual(pair.addressed, ["tenant:advertise", "tenant:objects/missing", "tenant:objects/missing"]);
    } finally { await pair.close(); }
  });

  test(`direct uploadObjects negotiates once and writes the parent beside nested objects (${mode})`, async () => {
    const pair = await servePair(legacy);
    try {
      const wire = pair.wire();
      const payload = Buffer.from("new upload");
      const id = hashObject("blob", payload);
      assert.equal(pair.parent.objects.has(id), false);
      await wire.uploadObjects([{ id, type: "blob", payload }]);
      assert.deepEqual(pair.parent.objects.readTyped(id, "blob"), payload);
      await wire.uploadObjects([{ id, type: "blob", payload }]);
      assert.deepEqual(await wire.missingObjects([id]), []);
      assert.deepEqual(pair.routes, ["/tenant/advertise", `${prefix}objects/upload`, `${prefix}objects/upload`, `${prefix}objects/missing`]);
      assert.deepEqual(pair.addressed, ["tenant:advertise", "tenant:objects/upload", "tenant:objects/upload", "tenant:objects/missing"]);
      assert.equal(pair.nested.objects.has(id), false);
      assert.equal(pair.nested.objects.has(pair.parentId), false);
    } finally { await pair.close(); }
  });

  test(`all other direct operations negotiate the parent namespace (${mode})`, async () => {
    const pair = await servePair(legacy);
    try {
      const operations: ReadonlyArray<readonly [string, (wire: HttpTransport) => Promise<unknown>]> = [
        ["objects/fetch", async wire => { assert.ok(parseBundle(await wire.fetchObjects([pair.parentId])).lines.some(line => line.id === pair.parentId)); }],
        ["fetch", wire => wire.fetch([], [])],
        ["push", wire => wire.push(exportBundle(pair.parent.objects, pair.parent.refs, []), [], false, new Date(0))],
        ["publish", wire => wire.publish([], false, new Date(0))],
        ["leases", wire => wire.lease({ action: "inspect", fileId: "a".repeat(32) })],
        ["forge/read", wire => wire.forge({ action: "list", kind: "series" })],
      ];
      for (const [endpoint, operation] of operations) {
        pair.routes.length = 0; pair.addressed.length = 0;
        await operation(pair.wire());
        assert.deepEqual(pair.routes, ["/tenant/advertise", `${prefix}${endpoint}`]);
        assert.deepEqual(pair.addressed, ["tenant:advertise", `tenant:${endpoint}`]);
      }
    } finally { await pair.close(); }
  });
}
