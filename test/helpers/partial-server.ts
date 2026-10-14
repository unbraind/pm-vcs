/** Independent HTTP promisor for synchronous client demand reads. */
import { startRepositoryServer } from "../../engine/serve.ts";
const server = await startRepositoryServer({ root: process.argv[2], host: "127.0.0.1", port: 0 });
process.send?.({ port: server.port });
process.once("message", async () => { await server.close(); process.disconnect?.(); });
