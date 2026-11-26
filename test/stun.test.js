import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { parseStunUrl, buildBindingRequest, buildBindingSuccess, parseBindingResponse, stunCheck } from '../src/stun.js';
import { classify } from '../src/classify.js';

test('parses STUN URLs', () => {
  assert.deepEqual(parseStunUrl('stun:stun.l.google.com:19302'), { host: 'stun.l.google.com', port: 19302 });
  assert.deepEqual(parseStunUrl('stun:example.com'), { host: 'example.com', port: 3478 });
  assert.throws(() => parseStunUrl('https://example.com'));
});

test('builds a valid 20-byte Binding Request', () => {
  const txId = randomBytes(12);
  const req = buildBindingRequest(txId);
  assert.equal(req.length, 20);
  assert.equal(req.readUInt16BE(0), 0x0001);
  assert.equal(req.readUInt32BE(4), 0x2112a442);
  assert.ok(req.subarray(8).equals(txId));
});

test('decodes XOR-MAPPED-ADDRESS from a Binding Success', () => {
  const txId = randomBytes(12);
  const res = buildBindingSuccess(txId, '203.0.113.42', 54321);
  assert.deepEqual(parseBindingResponse(res, txId), { family: 'IPv4', address: '203.0.113.42', port: 54321 });
});

test('ignores replies for other transactions and rejects non-STUN data', () => {
  const res = buildBindingSuccess(randomBytes(12), '1.2.3.4', 1);
  assert.equal(parseBindingResponse(res, randomBytes(12)), null);
  assert.throws(() => parseBindingResponse(Buffer.alloc(24), randomBytes(12)), { code: 'STUN_BAD_RESPONSE' });
});

function mockStun({ dropFirst = false } = {}) {
  const seen = new Set();
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    const txId = msg.subarray(8, 20);
    if (dropFirst && !seen.has(txId.toString('hex'))) { seen.add(txId.toString('hex')); return; }
    socket.send(buildBindingSuccess(txId, rinfo.address, rinfo.port), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => socket.bind(0, '127.0.0.1', () => resolve(socket)));
}

test('end to end: gets the public address from a STUN server', async () => {
  const server = await mockStun();
  const result = await stunCheck({ url: `stun:127.0.0.1:${server.address().port}` });
  server.close();
  assert.equal(result.error, undefined);
  assert.equal(result.stun.publicAddress, '127.0.0.1');
  assert.equal(result.stun.packetsSent, 1);
  assert.equal(classify(result, { type: 'stun' }).category, 'ok');
});

test('end to end: recovers from a lost packet by retransmitting', async () => {
  const server = await mockStun({ dropFirst: true });
  const result = await stunCheck({ url: `stun:127.0.0.1:${server.address().port}` });
  server.close();
  assert.equal(result.stun.packetsSent, 2);
});

test('end to end: no reply is classified as udp_no_response', async () => {
  const silent = dgram.createSocket('udp4');
  await new Promise((r) => silent.bind(0, '127.0.0.1', r));
  const result = await stunCheck({ url: `stun:127.0.0.1:${silent.address().port}`, timeoutMs: 700 });
  silent.close();
  assert.equal(result.error.code, 'STUN_TIMEOUT');
  assert.equal(classify(result, { type: 'stun' }).category, 'udp_no_response');
});
