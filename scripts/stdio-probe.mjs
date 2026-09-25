#!/usr/bin/env node
/**
 * Minimal scripted MCP handshake against the built graphite-mcp server over
 * real stdio — proves the compiled entrypoint starts and speaks the protocol
 * on stdout (acceptance evidence, not part of the server surface).
 *
 * Sends initialize → tools/list → tools/call; prints compact evidence and
 * exits 0 on success.
 *
 * Usage: node scripts/stdio-probe.mjs [toolName] [jsonArguments]
 */
import { spawn } from 'node:child_process';

const CHILD = process.argv[2] ?? 'dist/src/index.js';
const TOOL = process.argv[3] ?? 'graphite_list_nodes';
const ARGS = process.argv[4] ? JSON.parse(process.argv[4]) : {};

const child = spawn(process.execPath, [CHILD], { stdio: ['pipe', 'pipe', 'pipe'] });
let nextId = 1;
const pending = new Map();

child.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not a protocol frame
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[server-stderr] ${c}`));

function request(method, params) {
  const id = nextId;
  nextId += 1;
  const msg = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve });
    child.stdin.write(`${JSON.stringify(msg)}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 60_000);
  });
}

const init = await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'stdio-probe', version: '0.0.0' },
});
console.log('initialize -> serverInfo:', JSON.stringify(init.result?.serverInfo));
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const list = await request('tools/list', {});
console.log('tools/list ->', list.result.tools.map((t) => t.name).sort().join(', '));

const call = await request('tools/call', { name: TOOL, arguments: ARGS });
console.log(`tools/call(${TOOL}) -> isError: ${call.result?.isError === true}`);
console.log(call.result.content[0].text.slice(0, 400));

child.kill('SIGTERM');
process.exit(0);