import { Transform } from 'node:stream';
import { ProviderException } from '../providers/AdapterInterface.js';

/** ID3v2.3 tag builder (title, artist, album art). */
const utf16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(s), 'utf16le')]);
const frame = (id, data) => {
  const h = Buffer.alloc(10);
  h.write(id, 0, 'ascii');
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data]);
};
const synchsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

export const Metadata = {
  id3(title, artist, cover = null, coverMime = 'image/jpeg') {
    const frames = [];
    if (title) frames.push(frame('TIT2', Buffer.concat([Buffer.from([1]), utf16(title)])));
    if (artist) frames.push(frame('TPE1', Buffer.concat([Buffer.from([1]), utf16(artist)])));
    if (cover && cover.length) {
      frames.push(frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from(coverMime, 'ascii'), Buffer.from([0, 3, 0]), cover])));
    }
    if (!frames.length) return Buffer.alloc(0);
    const body = Buffer.concat(frames);
    return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), synchsafe(body.length), body]);
  },
};

/** Prepends an ID3 tag (unless the file already starts with one) and enforces a byte limit. */
export class TagPrefixer extends Transform {
  constructor(tag, max = 0) {
    super();
    this.tag = tag; this.max = max; this.bytes = 0; this.buf = Buffer.alloc(0); this.done = !tag.length;
  }

  _transform(chunk, _enc, cb) {
    this.bytes += chunk.length;
    if (this.max && this.bytes > this.max) return cb(new ProviderException('too_large', 'File exceeds the configured maximum size.'));
    if (this.done) return cb(null, chunk);
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length < 3) return cb();
    this.done = true;
    if (this.buf.subarray(0, 3).toString('latin1') !== 'ID3') this.push(this.tag);
    const out = this.buf; this.buf = Buffer.alloc(0);
    return cb(null, out);
  }

  _flush(cb) { if (this.buf.length) { if (this.buf.subarray(0, 3).toString('latin1') !== 'ID3' && this.tag.length && !this.done) this.push(this.tag); this.push(this.buf); } cb(); }
}
