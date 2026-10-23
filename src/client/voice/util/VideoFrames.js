'use strict';

const { Buffer } = require('node:buffer');

const START = Buffer.from([0, 0, 0, 1]);

function lengthPrefixedToAnnexB(frame) {
  const nalus = [];
  let offset = 0;
  while (offset < frame.length) {
    if (offset + 4 > frame.length) throw new RangeError('Truncated NAL length');
    const size = frame.readUInt32BE(offset);
    offset += 4;
    if (!size || offset + size > frame.length) throw new RangeError('Invalid NAL length');
    nalus.push(START, frame.subarray(offset, offset + size));
    offset += size;
  }
  return Buffer.concat(nalus);
}

function annexBNalus(frame) {
  const starts = [];
  for (let i = 0; i + 3 < frame.length; i++) {
    if (frame[i] || frame[i + 1]) continue;
    const size = frame[i + 2] === 1 ? 3 : frame[i + 2] === 0 && frame[i + 3] === 1 ? 4 : 0;
    if (size) {
      starts.push({ offset: i, size });
      i += size - 1;
    }
  }
  if (!starts.length || starts[0].offset !== 0) throw new RangeError('Missing Annex B start code');
  return starts.map((start, i) => frame.subarray(start.offset + start.size, starts[i + 1]?.offset ?? frame.length));
}

module.exports = { lengthPrefixedToAnnexB, annexBNalus };
