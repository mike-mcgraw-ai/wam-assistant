/**
 * Save what the Even simulator's glasses display is showing, on black.
 *
 *   npm run dev                     # the app, on :5173
 *   npm run sim                     # the simulator, automation on :9898
 *   node tools/shot.mjs [out.png]   # default /tmp/screen.png
 *
 * This grabs whatever screen the app is on — navigate with the simulator's
 * own controls, or POST /api/input. It used to render one hardcoded screen
 * through the hub's /probe route, which showed the native text container;
 * since v0.100.0 the glasses show the compact bitmap instead, so that picture
 * was no longer the one on your face. For every screen at once, use the
 * screens page (`npm run screens`); this is for checking the simulator — the
 * real SDK's container placement — against it.
 *
 * The simulator returns RGBA on a *transparent* ground. Anything that reads
 * it as greyscale without compositing first sees every empty pixel as ink —
 * that cost a day once — so the saved file is already composited onto black.
 *
 * SIM_PORT overrides the automation port.
 */
import { writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'

const out = process.argv[2] ?? '/tmp/screen.png'
const port = process.env.SIM_PORT || '9898'

let png
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/screenshot/glasses`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  png = Buffer.from(await res.arrayBuffer())
} catch (err) {
  console.error(`No simulator on :${port} (${err.message}). Start it with: npm run sim`)
  process.exit(1)
}

// ---- just enough PNG to composite one 8-bit RGBA image ----------------------

function chunks(buf) {
  const list = []
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at)
    list.push({ type: buf.toString('latin1', at + 4, at + 8), data: buf.subarray(at + 8, at + 8 + len) })
    at += 12 + len
  }
  return list
}

function decodeRgba(buf) {
  const all = chunks(buf)
  const ihdr = all.find(c => c.type === 'IHDR').data
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const [depth, colour, , , interlace] = ihdr.subarray(8, 13)
  const channels = { 6: 4, 2: 3 }[colour]
  if (depth !== 8 || !channels || interlace) return null
  const raw = inflateSync(Buffer.concat(all.filter(c => c.type === 'IDAT').map(c => c.data)))
  const stride = width * channels
  const px = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? px[y * stride + x - channels] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[y * stride + x] = v & 255
    }
  }
  return { width, height, channels, px }
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC[(c ^ byte) & 255] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
function encodeRgb(width, height, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.alloc(height * (width * 3 + 1))
  for (let y = 0; y < height; y += 1) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- composite onto black, and say where the ink is -------------------------

const img = decodeRgba(png)
if (!img) {
  writeFileSync(out, png)
  console.log(`saved ${out} as the simulator sent it (unexpected PNG format — still transparent, composite before measuring)`)
  process.exit(0)
}

const { width, height, channels, px } = img
const rgb = Buffer.alloc(width * height * 3)
let minX = width, minY = height, maxX = -1, maxY = -1
for (let i = 0, o = 0; i < width * height; i += 1, o += 3) {
  const alpha = channels === 4 ? px[i * 4 + 3] / 255 : 1
  for (let ch = 0; ch < 3; ch += 1) rgb[o + ch] = Math.round(px[i * channels + ch] * alpha)
  if (rgb[o] + rgb[o + 1] + rgb[o + 2] > 90) {
    const x = i % width
    const y = Math.floor(i / width)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
}
writeFileSync(out, encodeRgb(width, height, rgb))
console.log(`saved ${out} (${width}x${height}, on black)`)
console.log(maxX < 0 ? 'no ink: the display is blank' : `ink spans x ${minX}..${maxX}, y ${minY}..${maxY}`)
