// worker/public-media.js
// Immutable, content-addressed public media. Decoding is strict: the declared
// MIME must match the real file signature, so a renamed script can never be
// published as an image.

const DATA_IMAGE = /^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/]*={0,2})$/i;

// D1 caps a statement at 100 bound parameters and a row at ~2 MB; a publication
// batch is also capped so one release can never become an unbounded write.
export const MAX_PUBLICATION_STATEMENTS = 30;
export const MAX_PUBLIC_IMAGE_BYTES = 900000;

export const validatePublicImageBytes=(contentType,bytes)=>contentType==='image/png'
  ? bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)
  : contentType==='image/jpeg'
    ? bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff
    : contentType==='image/webp'
      ? bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP'
      : false;

// A D1 BLOB column can come back as an ArrayBuffer, a typed-array view or a plain array of byte numbers.
// Accept exactly those shapes (same rule as main's eb13e4b); anything else is not image bytes.
export function normalizePublicMediaBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    try { return new Uint8Array(value); } catch { return null; }
  }
  if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Uint8Array.from(value);
  }
  return null;
}

export function decodePublicDataUrl(value) {
  const match = String(value||'').match(DATA_IMAGE);
  if (!match) throw new Error('invalid public image data');
  const raw = atob(match[2]);
  const bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0));
  if (!bytes.length || bytes.byteLength > MAX_PUBLIC_IMAGE_BYTES) throw new Error(`public image exceeds ${MAX_PUBLIC_IMAGE_BYTES} bytes`);
  const subtype = match[1].toLowerCase();
  const contentType=subtype==='jpg'||subtype==='jpeg'?'image/jpeg':`image/${subtype}`;
  if (!validatePublicImageBytes(contentType,bytes)) throw new Error('public image signature does not match MIME');
  return {contentType,bytes};
}

export async function materializePublicMedia(value) {
  const {contentType,bytes} = decodePublicDataUrl(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map(x=>x.toString(16).padStart(2,'0')).join('');
  return {hash,contentType,bytes,byteLength:bytes.byteLength,publicUrl:`/public/media/${hash}`};
}

// Deterministic: same input order in, same chunk boundaries out. Duplicate
// hashes collapse first, so a menu that reuses one photo pays for it once.
export function chunkMediaForD1(media = [], {maxItems = 20, maxBytes = 1500000} = {}) {
  const seen = new Set();
  const unique = [];
  for (const item of media) {
    if (!item || seen.has(item.hash)) continue;
    seen.add(item.hash);
    unique.push(item);
  }
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const item of unique) {
    const size = Number(item.byteLength) || 0;
    if (size > maxBytes) throw new Error(`public media ${item.hash} exceeds the ${maxBytes} byte statement budget`);
    if (current.length && (current.length >= maxItems || bytes + size > maxBytes)) {
      chunks.push(current); current = []; bytes = 0;
    }
    current.push(item); bytes += size;
  }
  if (current.length) chunks.push(current);
  if (chunks.length > MAX_PUBLICATION_STATEMENTS) {
    throw new Error(`public media needs ${chunks.length} statements, over the ${MAX_PUBLICATION_STATEMENTS} statement publication budget`);
  }
  return chunks;
}

export function publicMediaInsertStatements(env,media,releaseId,sourceRevision,now=new Date()) {
  return chunkMediaForD1(media,{maxItems:20,maxBytes:1500000}).map(chunk=>{
    const values=chunk.map(()=>'(?,?,?,?)').join(',');
    return env.DB.prepare(`INSERT OR IGNORE INTO public_media(hash,content_type,body,byte_length,created_at)
      SELECT column1,column2,column3,column4,? FROM (VALUES ${values})
      WHERE EXISTS(SELECT 1 FROM public_content_releases WHERE id=? AND source_revision=?)`)
      // SQLite numbers `?` by position in the SQL text: created_at is the first
      // placeholder (inside SELECT), then the VALUES tuples, then the guard.
      .bind(now.toISOString(),...chunk.flatMap(item=>[item.hash,item.contentType,item.bytes,item.byteLength]),releaseId,sourceRevision);
  });
}
