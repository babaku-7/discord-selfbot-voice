'use strict';

const assert = require('node:assert/strict');
const { H264Dispatcher } = require('../../src/client/voice/dispatcher/AnnexBDispatcher');
const { H264Helpers } = require('../../src/client/voice/player/processing/AnnexBNalSplitter');
const Util = require('../../src/util/Util');

const nalus = [
  Buffer.from([0x67, 0x42, 0x00, 0x1e]),
  Buffer.from([0x68, 0xce, 0x06, 0xe2]),
  Buffer.from([0x65, 0x88, 0x84, 0x21]),
];
const accessUnit = Buffer.concat(nalus.flatMap(nalu => {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(nalu.length);
  return [size, nalu];
}));
const encryptedFrame = Buffer.from([
  0, 0, 0, 1, ...nalus[0],
  0, 0, 0, 1, ...nalus[1],
  0, 0, 0, 1, ...nalus[2],
  0xfa, 0xfa,
]);

const calls = [];
const player = {
  voiceConnection: {
    dave: {
      encrypt: (frame, codec) => {
        calls.push({ frame: Buffer.from(frame), codec });
        return encryptedFrame;
      },
    },
  },
};
const dispatcher = Object.create(H264Dispatcher.prototype);
dispatcher.player = player;
dispatcher.payloadType = Util.getPayloadType('H264');
dispatcher._nalFunctions = H264Helpers;
dispatcher.mtu = 1200;
dispatcher.createPayloadExtension = () => Buffer.alloc(0);
const packets = [];
dispatcher._playChunk = (chunk, last) => packets.push({ chunk: Buffer.from(chunk), last });

dispatcher._codecCallback(accessUnit);

assert.equal(calls.length, 1, 'encrypt one complete video frame, not each RTP packet');
assert.equal(calls[0].codec, 'H264');
assert.equal(
  calls[0].frame.toString('hex'),
  '000000016742001e0000000168ce06e20000000165888421',
);
assert.equal(packets.length, 3, 'packetize encrypted frame only after DAVE encryption');
assert.equal(packets[2].last, true, 'mark end of encrypted video frame');
assert.deepEqual(packets[2].chunk, Buffer.concat([nalus[2], Buffer.from([0xfa, 0xfa])]));
console.log('dave-video-encryption.smoke: PASS');
