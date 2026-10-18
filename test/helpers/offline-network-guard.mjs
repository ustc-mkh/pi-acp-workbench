// Test-only Node preload. This is an assertion aid, not an OS/network sandbox.
// No URLs, headers or environment contents are logged.
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
const trace = process.env.WORKBENCH_OFFLINE_TRACE;
if (!trace) throw new Error('offline guard requires its owned trace file');
appendFileSync(
  trace,
  JSON.stringify({ type: 'boot', pid: process.pid, ppid: process.ppid }) + '\n',
);
const deny = (method) =>
  function () {
    appendFileSync(trace, JSON.stringify({ type: 'network', pid: process.pid, method }) + '\n');
    throw new Error(`offline fixture forbids network: ${method}`);
  };
globalThis.fetch = deny('fetch');
net.connect = net.createConnection = deny('net.connect');
net.Socket.prototype.connect = deny('socket.connect');
tls.connect = deny('tls.connect');
http.request = http.get = deny('http.request');
https.request = https.get = deny('https.request');
dgram.Socket.prototype.send = deny('dgram.send');
syncBuiltinESMExports();
