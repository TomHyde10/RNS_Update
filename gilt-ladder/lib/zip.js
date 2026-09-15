// Minimal read-only ZIP extractor.
//
// Exists so the BoE download needs no `unzip` binary in the container and no
// npm dependency. It is used twice per refresh: the BoE ships a zip, and the
// .xlsx inside it is itself a zip. Only what that requires is implemented -
// stored and deflated entries, no encryption, no zip64, no spanning.
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

function findEndOfCentralDirectory(buf) {
  // The EOCD sits at the end, after a comment of up to 64KB. Scan backwards.
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip file: no end-of-central-directory record');
}

function entries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === ZIP64_MARKER) throw new Error('zip64 archives are not supported');

  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CEN_SIG) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    out.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

function readEntry(buf, entry) {
  const { localOffset, method, compressedSize } = entry;
  if (buf.readUInt32LE(localOffset) !== LOC_SIG) throw new Error('corrupt zip local header');
  // The local header's own name/extra lengths are authoritative - they can
  // differ from the central directory's, and using the wrong one lands the
  // read a few bytes into the compressed stream.
  const nameLength = buf.readUInt16LE(localOffset + 26);
  const extraLength = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const data = buf.subarray(start, start + compressedSize);

  if (method === 0) return Buffer.from(data);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip compression method ${method}`);
}

// Extract one named entry. `name` may be an exact path or a predicate.
function extract(buf, name) {
  const all = entries(buf);
  const key =
    typeof name === 'function' ? [...all.keys()].find(name) : all.has(name) ? name : undefined;
  if (!key) throw new Error(`zip entry not found: ${name}`);
  return readEntry(buf, all.get(key));
}

const list = (buf) => [...entries(buf).keys()];

module.exports = { extract, list };
