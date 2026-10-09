// Streamable HTTP entry point, stateless, JSON responses, for remote clients (ChatGPT plugins,
// connectors, registries that require a remote server). Same tools as the stdio server; every
// page link carries utm_source=chatgpt.
//   handleMcp(req, res, parsedBody?)  the reusable handler (api/mcp.ts on Vercel)
//   node dist/http.js                 a local server on PORT (default 8787) at /mcp
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server';
import { loadSnapshot, type Snapshot } from './tools';

let snapshot: Snapshot | undefined;

function jsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json', ...(status === 405 ? { allow: 'POST' } : {}) });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

export async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, parsedBody?: unknown): Promise<void> {
  if (req.method !== 'POST') {
    // stateless: no SSE stream (GET) and no session to delete (DELETE)
    jsonRpcError(res, 405, 'Method not allowed: this stateless MCP endpoint only accepts POST.');
    return;
  }
  snapshot ??= loadSnapshot();
  // remote clients read structuredContent: the text block is the one-sentence summary
  const server = createServer(snapshot, { utm: 'chatgpt', text: 'summary' });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    if (!res.headersSent) jsonRpcError(res, 500, `Internal error: ${(err as Error).message}`);
  }
}

export default handleMcp;

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  http
    .createServer((req, res) => {
      if ((req.url ?? '/').split('?')[0] !== '/mcp') return jsonRpcError(res, 404, 'Not found: the MCP endpoint is /mcp');
      void handleMcp(req, res);
    })
    .listen(port, '127.0.0.1', () => console.log(`eorscope-mcp HTTP listening on http://127.0.0.1:${port}/mcp`));
}
