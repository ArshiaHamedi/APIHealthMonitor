// STUN connectivity check (RFC 5389). WebRTC voice and video use STUN over UDP to find a
// client's public address. If this check fails, real-time calls from this network will struggle.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const BINDING_ERROR = 0x0111;
const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

// UDP can drop packets, so the request is resent at these times (ms after the first send).
const RETRANSMIT_AT = [500, 1500];

const round = (n) => (n == null ? null : Math.round(n * 10) / 10);

const stunError = (code, message) => Object.assign(new Error(message), { code });

// "stun:stun.l.google.com:19302" -> { host, port }. Port defaults to 3478.
export function parseStunUrl(url) {
  const m = /^stuns?:([^:?\s]+)(?::(\d+))?$/i.exec(url);
  if (!m) throw new Error(`Not a STUN URL: ${url} (expected stun:host:port)`);
  return { host: m[1], port: Number(m[2] ?? 3478) };
}

// 20-byte header: type, length (0, no attributes), magic cookie, 12-byte transaction ID.
export function buildBindingRequest(txId = randomBytes(12)) {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(BINDING_REQUEST, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(MAGIC_COOKIE, 4);
  txId.copy(buf, 8);
  return buf;
}

// A minimal Binding Success response with an IPv4 XOR-MAPPED-ADDRESS. Used by the mock server and tests.
export function buildBindingSuccess(txId, address, port) {
  const buf = Buffer.alloc(32);
  buf.writeUInt16BE(BINDING_SUCCESS, 0);
  buf.writeUInt16BE(12, 2);
  buf.writeUInt32BE(MAGIC_COOKIE, 4);
  txId.copy(buf, 8);
  buf.writeUInt16BE(ATTR_XOR_MAPPED_ADDRESS, 20);
  buf.writeUInt16BE(8, 22);
  buf[24] = 0;
  buf[25] = 0x01;
  buf.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 26);
  const ip = address.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
  buf.writeUInt32BE((ip ^ MAGIC_COOKIE) >>> 0, 28);
  return buf;
}

function decodeAddress(value, xor, msg) {
  const family = value[1];
  let port = value.readUInt16BE(2);
  if (xor) port ^= MAGIC_COOKIE >>> 16;

  if (family === 0x01) {
    const raw = value.readUInt32BE(4);
    const ip = xor ? (raw ^ MAGIC_COOKIE) >>> 0 : raw;
    return { family: 'IPv4', address: [24, 16, 8, 0].map((s) => (ip >>> s) & 255).join('.'), port };
  }
  if (family === 0x02) {
    const bytes = Buffer.from(value.subarray(4, 20));
    if (xor) {
      const key = msg.subarray(4, 20); // magic cookie + transaction ID
      for (let i = 0; i < 16; i++) bytes[i] ^= key[i];
    }
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
    return { family: 'IPv6', address: groups.join(':'), port };
  }
  throw stunError('STUN_BAD_RESPONSE', `Unknown address family 0x${family.toString(16)}`);
}

// Returns the mapped address, or null if the packet belongs to a different transaction.
export function parseBindingResponse(msg, txId) {
  if (msg.length < 20) throw stunError('STUN_BAD_RESPONSE', 'Reply is shorter than a STUN header');
  if (msg.readUInt32BE(4) !== MAGIC_COOKIE) throw stunError('STUN_BAD_RESPONSE', 'Reply has no STUN magic cookie, so it is not a STUN server');
  if (!msg.subarray(8, 20).equals(txId)) return null;

  const type = msg.readUInt16BE(0);
  if (type === BINDING_ERROR) throw stunError('STUN_ERROR_RESPONSE', 'Server answered with a Binding Error response');
  if (type !== BINDING_SUCCESS) throw stunError('STUN_BAD_RESPONSE', `Unexpected STUN message type 0x${type.toString(16)}`);

  const end = Math.min(msg.length, 20 + msg.readUInt16BE(2));
  let mapped = null;
  for (let off = 20; off + 4 <= end;) {
    const attrType = msg.readUInt16BE(off);
    const attrLen = msg.readUInt16BE(off + 2);
    const value = msg.subarray(off + 4, off + 4 + attrLen);
    if (attrType === ATTR_XOR_MAPPED_ADDRESS) return decodeAddress(value, true, msg);
    if (attrType === ATTR_MAPPED_ADDRESS) mapped = decodeAddress(value, false, msg);
    off += 4 + Math.ceil(attrLen / 4) * 4; // attributes are padded to 4 bytes
  }
  if (!mapped) throw stunError('STUN_BAD_RESPONSE', 'Reply has no mapped address');
  return mapped;
}

// Same result shape as timedRequest(), so the retry, classify and storage code work unchanged.
export async function stunCheck({ url, timeoutMs = 3000 }) {
  const { host, port } = parseStunUrl(url);
  const start = performance.now();
  const fail = (code, message, dnsMs = null) => ({
    status: null,
    error: { code, message },
    timings: { dns: round(dnsMs), tcp: null, tls: null, ttfb: null, download: null, total: round(performance.now() - start) },
  });

  let address = host;
  let dnsMs = null;
  if (!net.isIP(host)) {
    try {
      ({ address } = await dns.lookup(host, { family: 4 }));
      dnsMs = performance.now() - start;
    } catch (err) {
      return fail(err.code ?? 'ENOTFOUND', `DNS lookup for ${host} failed: ${err.message}`);
    }
  }

  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const txId = randomBytes(12);
    const request = buildBindingRequest(txId);
    const timers = [];
    let sent = 0;
    let lastSentAt;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      socket.close();
      resolve(result);
    };

    const send = () => {
      sent++;
      lastSentAt = performance.now();
      socket.send(request, port, address);
    };

    socket.on('message', (msg) => {
      try {
        const mapped = parseBindingResponse(msg, txId);
        if (!mapped) return;
        const now = performance.now();
        finish({
          status: null,
          timings: {
            dns: round(dnsMs), tcp: null, tls: null,
            // Round trip from the most recent packet; the reply could belong to an earlier one.
            ttfb: round(now - lastSentAt), download: null, total: round(now - start),
          },
          stun: { server: `${address}:${port}`, publicAddress: mapped.address, publicPort: mapped.port, family: mapped.family, packetsSent: sent },
        });
      } catch (err) {
        finish(fail(err.code ?? 'STUN_BAD_RESPONSE', err.message, dnsMs));
      }
    });

    socket.on('error', (err) => {
      // Windows reports an ICMP "port unreachable" on a UDP socket as ECONNRESET.
      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
        return finish(fail('STUN_UNREACHABLE', `Nothing is listening on UDP ${address}:${port} (ICMP port unreachable)`, dnsMs));
      }
      finish(fail(err.code ?? 'UDP_ERROR', err.message, dnsMs));
    });

    send();
    for (const at of RETRANSMIT_AT) if (at < timeoutMs) timers.push(setTimeout(send, at));
    timers.push(setTimeout(
      () => finish(fail('STUN_TIMEOUT', `No STUN reply over UDP after ${sent} packet(s) in ${timeoutMs} ms`, dnsMs)),
      timeoutMs,
    ));
  });
}
