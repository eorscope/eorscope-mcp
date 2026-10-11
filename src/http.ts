// Streamable HTTP entry point, stateless, JSON responses, for remote clients (ChatGPT plugins,
// connectors, registries that require a remote server). Same tools as the stdio server; every
// page link carries utm_source=chatgpt (utm_source=claude on /claude).
//   handleMcp(req, res, parsedBody?)  the reusable handler (api/mcp.ts on Vercel)
//   node dist/http.js                 a local server on PORT (default 8787) at /mcp
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server';
import { loadSnapshot, type Snapshot } from './tools';

let snapshot: Snapshot | undefined;

function jsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json', ...(status === 405 ? { allow: 'POST' } : {}) });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

// The SDK transport reads the raw headers (through @hono/node-server): set both views of a header.
function setHeader(req: http.IncomingMessage, name: string, value: string): void {
  req.headers[name] = value;
  const raw = req.rawHeaders;
  const kept: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() !== name) kept.push(raw[i], raw[i + 1]);
  req.rawHeaders = [...kept, name, value];
}

// Hosts and scanners do not all send the headers the SDK transport checks strictly (09/10: OpenAI's plugin scan got
// 406 for its Accept header and 400 for a newer MCP-Protocol-Version). This endpoint is stateless and answers in JSON,
// so any client that posts JSON-RPC is served; an unknown protocol version is served as the latest this server speaks
// (the version is negotiated in initialize anyway).
export function normalizeHeaders(req: http.IncomingMessage): void {
  const accept = String(req.headers.accept ?? '');
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) setHeader(req, 'accept', 'application/json, text/event-stream');
  const version = req.headers['mcp-protocol-version'];
  if (typeof version === 'string' && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) setHeader(req, 'mcp-protocol-version', LATEST_PROTOCOL_VERSION);
}

/** variant 'claude' (path /claude): widgets without _meta.ui.domain, see ServerOptions.uiDomain */
export async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, parsedBody?: unknown, variant: 'default' | 'claude' = 'default'): Promise<void> {
  if (req.method !== 'POST') {
    // stateless: no SSE stream (GET) and no session to delete (DELETE)
    jsonRpcError(res, 405, 'Method not allowed: this stateless MCP endpoint only accepts POST.');
    return;
  }
  normalizeHeaders(req);
  snapshot ??= loadSnapshot();
  // remote clients read structuredContent: the text block is the one-sentence summary
  const server = createServer(snapshot, { utm: 'chatgpt', text: 'summary', ...(variant === 'claude' ? { utm: 'claude', uiDomain: false, annotationTitle: true } : {}) });
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
      const path = (req.url ?? '/').split('?')[0];
      if (path !== '/mcp' && path !== '/claude') return jsonRpcError(res, 404, 'Not found: the MCP endpoint is /mcp (/claude for Claude)');
      void handleMcp(req, res, undefined, path === '/claude' ? 'claude' : 'default');
    })
    .listen(port, '127.0.0.1', () => console.log(`eorscope-mcp HTTP listening on http://127.0.0.1:${port}/mcp`));
}
