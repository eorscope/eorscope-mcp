#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server';
import { loadSnapshot } from './tools';

await createServer(loadSnapshot()).connect(new StdioServerTransport());
