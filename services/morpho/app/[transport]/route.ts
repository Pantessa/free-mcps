// MCP endpoint on a CLEAN path. With basePath "" this route lives at
// app/[transport] → served at `/mcp` (Streamable HTTP) and `/sse` — no
// `/api/mcp/mcp` doubling.
import { createCleanMcpHandler } from "@yeetful/mcp-kit";
import { registerMorphoTools } from "@/lib/tools";

const handler = createCleanMcpHandler((server) => {
  registerMorphoTools(server);
});

export { handler as GET, handler as POST, handler as DELETE };
