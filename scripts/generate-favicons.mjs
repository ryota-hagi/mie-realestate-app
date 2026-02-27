#!/usr/bin/env node
/**
 * generate-favicons.mjs
 * SVG favicon から各サイズの PNG + ICO を生成
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const svgPath = join(ROOT, 'favicon.svg');
const svgBuffer = readFileSync(svgPath);

const sizes = [
  { name: 'favicon-16x16.png', size: 16 },
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'favicon-48x48.png', size: 48 },
  { name: 'favicon-96x96.png', size: 96 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'android-chrome-192x192.png', size: 192 },
  { name: 'android-chrome-512x512.png', size: 512 },
];

async function generatePngs() {
  for (const { name, size } of sizes) {
    await sharp(svgBuffer, { density: Math.max(72, Math.round(72 * size / 64)) })
      .resize(size, size)
      .png()
      .toFile(join(ROOT, name));
    console.log(`Generated ${name} (${size}x${size})`);
  }
}

async function generateIco() {
  const png16 = await sharp(svgBuffer, { density: 150 }).resize(16, 16).png().toBuffer();
  const png32 = await sharp(svgBuffer, { density: 300 }).resize(32, 32).png().toBuffer();
  const png48 = await sharp(svgBuffer, { density: 300 }).resize(48, 48).png().toBuffer();

  // Build ICO file (PNG-in-ICO format, supported by all modern browsers)
  const images = [png16, png32, png48];
  const imageSizes = [16, 32, 48];
  const headerSize = 6;
  const entrySize = 16;
  const numImages = images.length;
  const dirSize = headerSize + entrySize * numImages;

  let offset = dirSize;
  const entries = [];
  for (let i = 0; i < numImages; i++) {
    entries.push({ size: imageSizes[i], offset, data: images[i] });
    offset += images[i].length;
  }

  const totalSize = offset;
  const buf = Buffer.alloc(totalSize);

  // ICO header
  buf.writeUInt16LE(0, 0);      // reserved
  buf.writeUInt16LE(1, 2);      // type: ICO
  buf.writeUInt16LE(numImages, 4); // count

  // Directory entries
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const off = headerSize + i * entrySize;
    buf.writeUInt8(e.size < 256 ? e.size : 0, off);     // width
    buf.writeUInt8(e.size < 256 ? e.size : 0, off + 1); // height
    buf.writeUInt8(0, off + 2);           // color palette
    buf.writeUInt8(0, off + 3);           // reserved
    buf.writeUInt16LE(1, off + 4);        // color planes
    buf.writeUInt16LE(32, off + 6);       // bits per pixel
    buf.writeUInt32LE(e.data.length, off + 8);  // size
    buf.writeUInt32LE(e.offset, off + 12);      // offset
  }

  // Image data
  for (const e of entries) {
    e.data.copy(buf, e.offset);
  }

  writeFileSync(join(ROOT, 'favicon.ico'), buf);
  console.log('Generated favicon.ico (16x16 + 32x32 + 48x48)');
}

await generatePngs();
await generateIco();
console.log('All favicons generated!');
