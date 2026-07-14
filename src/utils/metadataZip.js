// ============================================================================
// I9 ORG EXPLORER — Montagem de ZIP para Metadata API deploy
// Spec v2.1 · Sprint 2
// ============================================================================

import { createGzip } from 'zlib';
import { Writable } from 'stream';

// Minimal ZIP builder (sem dependência externa — arquivos sem compressão)
// Metadata API aceita ZIPs com Store (sem compressão) sem problema.

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function toLittleEndian(n, bytes) {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) { buf[i] = n & 0xFF; n >>>= 8; }
  return buf;
}

/**
 * Cria um ZIP Buffer com package.xml + arquivo(s) de metadado.
 *
 * @param {Array<{path: string, content: string}>} files
 *   Ex: [
 *     { path: 'package.xml', content: '<Package>...</Package>' },
 *     { path: 'flows/MyFlow.flow', content: '<Flow>...</Flow>' }
 *   ]
 * @returns {Buffer} ZIP buffer pronto para conn.metadata.deploy()
 */
export function buildMetadataZip(files) {
  const entries = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.path, 'utf-8');
    const dataBuf = Buffer.from(f.content, 'utf-8');
    const crc = crc32(dataBuf);

    // Local file header (30 + nameLen + dataLen)
    const localHeader = Buffer.concat([
      Buffer.from([0x50, 0x4B, 0x03, 0x04]),    // signature
      toLittleEndian(20, 2),                      // version needed
      toLittleEndian(0, 2),                       // flags
      toLittleEndian(0, 2),                       // compression: Store
      toLittleEndian(0, 2),                       // mod time
      toLittleEndian(0, 2),                       // mod date
      toLittleEndian(crc, 4),                     // crc-32
      toLittleEndian(dataBuf.length, 4),          // compressed size
      toLittleEndian(dataBuf.length, 4),          // uncompressed size
      toLittleEndian(nameBuf.length, 2),          // filename length
      toLittleEndian(0, 2),                       // extra field length
      nameBuf,
      dataBuf
    ]);

    entries.push({ nameBuf, dataBuf, crc, localHeader, offset });
    offset += localHeader.length;
  }

  // Central directory
  const cdEntries = [];
  for (const e of entries) {
    const cd = Buffer.concat([
      Buffer.from([0x50, 0x4B, 0x01, 0x02]),
      toLittleEndian(20, 2),                      // version made by
      toLittleEndian(20, 2),                      // version needed
      toLittleEndian(0, 2),                       // flags
      toLittleEndian(0, 2),                       // compression
      toLittleEndian(0, 2),                       // mod time
      toLittleEndian(0, 2),                       // mod date
      toLittleEndian(e.crc, 4),
      toLittleEndian(e.dataBuf.length, 4),
      toLittleEndian(e.dataBuf.length, 4),
      toLittleEndian(e.nameBuf.length, 2),
      toLittleEndian(0, 2),                       // extra length
      toLittleEndian(0, 2),                       // comment length
      toLittleEndian(0, 2),                       // disk number start
      toLittleEndian(0, 2),                       // internal attrs
      toLittleEndian(0, 4),                       // external attrs
      toLittleEndian(e.offset, 4),                // local header offset
      e.nameBuf
    ]);
    cdEntries.push(cd);
  }

  const cdBuf = Buffer.concat(cdEntries);
  const cdOffset = offset;

  // End of central directory
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4B, 0x05, 0x06]),
    toLittleEndian(0, 2),                          // disk number
    toLittleEndian(0, 2),                          // disk with CD
    toLittleEndian(entries.length, 2),              // entries on disk
    toLittleEndian(entries.length, 2),              // total entries
    toLittleEndian(cdBuf.length, 4),                // CD size
    toLittleEndian(cdOffset, 4),                    // CD offset
    toLittleEndian(0, 2),                          // comment length
  ]);

  return Buffer.concat([
    ...entries.map(e => e.localHeader),
    cdBuf,
    eocd
  ]);
}

/**
 * Monta package.xml para um conjunto de componentes.
 *
 * @param {Array<{type: string, fullName: string}>} components
 * @param {string} [apiVersion='62.0']
 * @returns {string}
 */
export function buildPackageXml(components, apiVersion = '62.0') {
  const byType = {};
  for (const c of components) {
    if (!byType[c.type]) byType[c.type] = [];
    byType[c.type].push(c.fullName);
  }

  const typesXml = Object.entries(byType).map(([type, members]) =>
    `    <types>\n${members.map(m => `        <members>${m}</members>`).join('\n')}\n        <name>${type}</name>\n    </types>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
${typesXml}
    <version>${apiVersion}</version>
</Package>`;
}

/**
 * Determina o path dentro do ZIP para um tipo de metadado.
 */
export function metadataPath(type, fullName) {
  const MAP = {
    Flow:                    { dir: 'flows',              ext: '.flow' },
    ApexClass:               { dir: 'classes',            ext: '.cls' },
    ApexTrigger:             { dir: 'triggers',           ext: '.trigger' },
    PermissionSet:           { dir: 'permissionsets',     ext: '.permissionset' },
    CustomField:             { dir: 'objects',            ext: '.object' },
    Layout:                  { dir: 'layouts',            ext: '.layout' },
    ValidationRule:          { dir: 'objects',            ext: '.object' },
    LightningComponentBundle:{ dir: 'lwc',                ext: '' },
    Profile:                 { dir: 'profiles',           ext: '.profile' },
    CustomObject:            { dir: 'objects',            ext: '.object' },
    Bot:                     { dir: 'bots',               ext: '.bot' },
    BotVersion:              { dir: 'bots',               ext: '.botVersion' },
    GenAiPlannerBundle:      { dir: 'genAiPlannerBundles', ext: '.genAiPlannerBundle' },
    GenAiPlugin:             { dir: 'genAiPlugins',       ext: '.genAiPlugin' },
    GenAiFunction:           { dir: 'genAiFunctions',     ext: '.genAiFunction' },
  };
  const m = MAP[type] || { dir: type.toLowerCase() + 's', ext: '' };
  // CustomField/VR fullName = "Object.FieldName" → path = objects/Object.object
  if (type === 'CustomField' || type === 'ValidationRule') {
    const objName = fullName.split('.')[0];
    return `${m.dir}/${objName}${m.ext}`;
  }
  return `${m.dir}/${fullName}${m.ext}`;
}
