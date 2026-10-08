"use strict";

// Local control of Heatzy devices through the Gizwits LAN protocol (GAgent firmware):
// - UDP 12414: discovery (cmd 0x0003, the device answers 0x0004 with its did)
// - TCP 12416: session authenticated by the device passcode (login 0x0008 -> 0x0009),
//   then P0 data with a sequence number (0x0093 -> 0x0094): action 0x02 reads the status, 0x01 writes it
// The layout of the status comes from the product datapoint schema (GET /app/datapoint?product_key=...)

const net = require("net");
const dgram = require("dgram");
const os = require("os");

const tcpPort = 12416;
const udpPort = 12414;
const requestTimeout = 5000; // ms
const discoveryTimeout = 3000; // ms

const P0_WRITE = 0x01;
const P0_READ = 0x02;
const P0_READ_REPLY = 0x03;

function frame(cmd, payload) {
  const body = Buffer.concat([Buffer.from([0, cmd >> 8, cmd & 0xff]), payload]);
  // The length is a varint, like MQTT
  const len = [];
  let n = body.length;
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    len.push(b);
  } while (n);
  return Buffer.concat([Buffer.from([0, 0, 0, 3].concat(len)), body]);
}

// Returns the complete frames found in buf, and what is left of it
function splitFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 5 <= buf.length && buf.readUInt32BE(i) === 3) {
    let j = i + 4;
    let len = 0;
    let shift = 0;
    let b;
    do {
      b = buf[j++];
      len |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80 && j < buf.length);
    if (j + len > buf.length) break;
    const body = buf.slice(j, j + len);
    frames.push({ cmd: body.readUInt16BE(1), payload: body.slice(3) });
    i = j + len;
  }
  return { frames, rest: buf.slice(i) };
}

// Keeps only what the plugin needs from the datapoint schema, or returns null if it cannot be used locally
function compactSchema(schema) {
  if (!schema || schema.protocolType !== "standard" || !schema.entities || !schema.entities[0]) {
    return null;
  }
  const writable = schema.entities[0].attrs.filter((a) => a.type === "status_writable");
  const attrs = {};
  let writableLength = 0;
  for (const a of writable) {
    const p = a.position;
    const end = p.unit === "bit" ? p.byte_offset + 1 : p.byte_offset + p.len;
    writableLength = Math.max(writableLength, end);
    if (a.name === "mode" || a.name === "timer_switch") {
      // Bit fields are only supported within a single byte
      if (p.unit === "bit" && p.bit_offset + p.len > 8) return null;
      attrs[a.name] = { id: a.id, unit: p.unit, byte: p.byte_offset, bit: p.bit_offset, len: p.len, enum: a.enum };
    }
  }
  if (!attrs.mode || !attrs.timer_switch) return null;
  return { flagsLength: Math.ceil(writable.length / 8), writableLength, attrs };
}

function decodeAttr(status, attr) {
  if (attr.unit === "bit") {
    const value = (status[attr.byte] >> attr.bit) & ((1 << attr.len) - 1);
    return attr.enum ? attr.enum[value] : value;
  }
  return status[attr.byte];
}

function encodeAttr(status, attr, value) {
  if (attr.enum) value = attr.enum.indexOf(value);
  if (value < 0) throw new Error("Unknown value for " + attr.id);
  if (attr.unit === "bit") {
    const mask = ((1 << attr.len) - 1) << attr.bit;
    status[attr.byte] = (status[attr.byte] & ~mask) | ((value << attr.bit) & mask);
  } else {
    status[attr.byte] = value;
  }
}

// One TCP session: connect, login, a few requests, close
function Session(ip, did) {
  this.ip = ip;
  this.did = did;
  this.buf = Buffer.alloc(0);
  this.waiters = [];
  this.sn = 1;
  this.socket = null;
}

Session.prototype.open = function (passcode) {
  return new Promise((resolve, reject) => {
    this.socket = net.connect({ host: this.ip, port: tcpPort });
    this.socket.setTimeout(requestTimeout, () => this.fail(new Error("LAN connection timeout")));
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("data", (data) => this.onData(data));
    this.socket.on("connect", () => {
      const pc = Buffer.from(passcode, "latin1");
      const payload = Buffer.concat([Buffer.from([pc.length >> 8, pc.length & 0xff]), pc]);
      this.request(0x0008, payload, 0x0009, null).then((f) => {
        if (f.payload[0] !== 0) {
          const error = new Error("LAN login refused");
          error.code = "PASSCODE";
          throw error;
        }
      }).then(resolve, reject);
    });
    this.waiters.push({ cmd: -1, reject }); // Errors before the login request is sent
  });
};

Session.prototype.onData = function (data) {
  const { frames, rest } = splitFrames(Buffer.concat([this.buf, data]));
  this.buf = rest;
  for (const f of frames) {
    const i = this.waiters.findIndex((w) => w.cmd === f.cmd &&
      (w.sn === null || (f.payload.length >= 4 && f.payload.readUInt32BE(0) === w.sn)));
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve(f);
  }
};

Session.prototype.fail = function (error) {
  const waiters = this.waiters;
  this.waiters = [];
  waiters.forEach((w) => w.reject(error));
  this.close();
};

Session.prototype.request = function (cmd, payload, expect, sn) {
  this.waiters = this.waiters.filter((w) => w.cmd !== -1);
  return new Promise((resolve, reject) => {
    this.waiters.push({ cmd: expect, sn, resolve, reject });
    this.socket.write(frame(cmd, payload));
  });
};

Session.prototype.p0 = function (data) {
  const sn = this.sn++;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(sn);
  return this.request(0x0093, Buffer.concat([header, data]), 0x0094, sn);
};

Session.prototype.read = async function () {
  const f = await this.p0(Buffer.from([P0_READ]));
  // Some firmwares insert the did (2 bytes length + did) between the sequence number and P0
  let offset = 4;
  if (f.payload.length >= offset + 2) {
    const len = f.payload.readUInt16BE(offset);
    if (f.payload.slice(offset + 2, offset + 2 + len).toString("latin1") === this.did) {
      offset += 2 + len;
    }
  }
  if (f.payload[offset] !== P0_READ_REPLY) {
    throw new Error("Unexpected LAN reply to status read");
  }
  return Buffer.from(f.payload.slice(offset + 1));
};

// attrs: { name: value }. The whole writable status is sent, copied from current, flags select what is written.
// Returns the P0 sent and the payload of the acknowledgement, for traces
Session.prototype.write = async function (schema, current, attrs) {
  const status = Buffer.from(current.slice(0, schema.writableLength));
  const flags = Buffer.alloc(schema.flagsLength);
  for (const name of Object.keys(attrs)) {
    const attr = schema.attrs[name];
    encodeAttr(status, attr, attrs[name]);
    flags[schema.flagsLength - 1 - (attr.id >> 3)] |= 1 << (attr.id & 7);
  }
  const request = Buffer.concat([Buffer.from([P0_WRITE]), flags, status]);
  const ack = await this.p0(request);
  return { request, ack: ack.payload };
};

Session.prototype.close = function () {
  if (this.socket) this.socket.destroy();
  this.socket = null;
};

// Sends the discovery request to every address of the local /24 networks (and to the hints first),
// returns the IP of the device with this did, or null. Broadcast is not used: Heatzy devices ignore it
function discover(did, hints) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const request = Buffer.from([0, 0, 0, 3, 3, 0, 0, 3]);
    let found = null;
    const done = () => {
      clearTimeout(timer);
      try { socket.close(); } catch (e) { /* already closed */ }
      resolve(found);
    };
    const timer = setTimeout(done, discoveryTimeout);
    socket.on("error", done);
    socket.on("message", (msg, rinfo) => {
      const { frames } = splitFrames(msg);
      if (frames.length && frames[0].cmd === 0x0004) {
        const p = frames[0].payload;
        if (p.length >= 2 && p.slice(2, 2 + p.readUInt16BE(0)).toString("latin1") === did) {
          found = rinfo.address;
          done();
        }
      }
    });
    socket.bind(0, () => {
      const targets = (hints || []).filter(Boolean);
      for (const list of Object.values(os.networkInterfaces())) {
        for (const itf of list) {
          if (itf.family !== "IPv4" && itf.family !== 4) continue;
          if (itf.internal) continue;
          const prefix = itf.address.split(".").slice(0, 3).join(".");
          for (let i = 1; i < 255; i++) targets.push(prefix + "." + i);
        }
      }
      for (const ip of new Set(targets)) socket.send(request, udpPort, ip, () => {});
    });
  });
}

module.exports = { Session, discover, compactSchema, decodeAttr };
