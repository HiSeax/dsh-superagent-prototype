/**
 * Login QR rendering for the Weixin Source.
 *
 * The iLink login QR encodes the `qrcode_img_content` URL a confirmed account scans; the references render that URL as a
 * terminal matrix (CowAgent `_print_qr`), which a desktop host cannot show. This module renders the same URL into a PNG
 * beside the credentials file and writes the URL as text as well, so the management panel points at files instead of
 * stdout. It performs no network call.
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

interface QrMatrix { addData(text: string): void; make(): void; getModuleCount(): number; isDark(row: number, col: number): boolean }
type QrFactory = (typeNumber: 0, level: 'L' | 'M' | 'Q' | 'H') => QrMatrix
// `qrcode-generator` is a CommonJS module declared with `export =`, which this ESM, non-interop project cannot import. The
// factory is loaded at runtime; only its small surface is typed here. The error-correction level M matches what terminal
// renderers of the references use for the same URL (L in CowAgent; either scans reliably).
const qrcode: QrFactory = createRequire(import.meta.url)('qrcode-generator') as QrFactory
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let value = n
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB8_8320 ^ (value >>> 1) : value >>> 1
    table[n] = value >>> 0
  }
  return table
})()
function crc32(buffer: Buffer): number {
  let value = 0xFFFF_FFFF
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xFF]! ^ (value >>> 8)
  return (value ^ 0xFFFF_FFFF) >>> 0
}
/** One PNG chunk: length, type, data, CRC of type+data. */
function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  name.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
  return out
}
/**
 * Renders `text` (the login URL) as a black-and-white PNG: an 8-bit greyscale image, one square per QR module.
 * @param text - the URL the login QR must encode.
 * @param options - module pixel size and quiet-zone width in modules.
 */
export function qrPng(text: string, options: { scale?: number; margin?: number } = {}): Buffer {
  const scale = options.scale ?? 6, margin = options.margin ?? 4
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const modules = qr.getModuleCount()
  const size = (modules + margin * 2) * scale
  const raw = Buffer.alloc((size + 1) * size)
  let offset = 0
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / scale) - margin, column = Math.floor(x / scale) - margin
      const dark = row >= 0 && column >= 0 && row < modules && column < modules && qr.isDark(row, column)
      raw[offset++] = dark ? 0x00 : 0xFF
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 0 // colour type: greyscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** The files a pending login points at: the PNG to scan, the text with the link, and the link itself. */
export interface LoginQrFiles { png: string; text: string; url: string }
/**
 * Writes the login QR of `url` into `stateDir` (PNG plus a text file naming it), replacing a previous pending QR.
 * @throws when the directory or either file cannot be written; the caller reports that on its health entry.
 */
export function loginQr(stateDir: string, url: string, names: { png?: string; text?: string } = {}): LoginQrFiles {
  const png = resolve(stateDir, names.png ?? 'weixin-qrcode.png')
  const text = resolve(stateDir, names.text ?? 'weixin-qrcode.txt')
  mkdirSync(dirname(png), { recursive: true })
  writeFileSync(png, qrPng(url))
  writeFileSync(text, `用微信扫描 ${png} 登录 iLink Bot。\n二维码链接（也可在微信中打开）：${url}\n`, 'utf8')
  return { png, text, url }
}