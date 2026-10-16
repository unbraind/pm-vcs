/** Native-runtime socket fixture for deterministic denial headers. */
import { startRepositoryServer, TokenGrants } from "../../engine/serve.ts";

const server = await startRepositoryServer({
  root: process.argv[2], host: "127.0.0.1", port: 0,
  grants: new TokenGrants([{ token: "fixture", repository: "missing", access: "read" }]),
});
console.log(`READY ${server.port}`);
process.once("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});
