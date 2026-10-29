export function parseConnectFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf[offset];
    const length = buf.readUInt32BE(offset + 1);
    if (offset + 5 + length > buf.length) break;
    frames.push({ flags, payload: buf.subarray(offset + 5, offset + 5 + length) });
    offset += 5 + length;
  }
  return frames;
}

export function frameBytes(flags, payload) {
  if (payload.length > 0xffff_ffff) throw new RangeError("Connect frame payload exceeds the 32-bit length limit");
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export const CONNECT_END_FRAME = frameBytes(0x02, Buffer.from("{}", "utf8"));
export const envelope = (payload) => frameBytes(0x00, payload);
