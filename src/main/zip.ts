import { open, type FileHandle } from "node:fs/promises"
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib"

/**
 * ZIP mínimo (sem ZIP64), suficiente para exportar e importar mundos. Nomes
 * em UTF-8; cada arquivo é armazenado ou comprimido com deflate.
 */

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50
const UTF8_FLAG = 0x0800
const LIMIT = 0xffffffff

export interface ZipInput {
  name: string
  data: Buffer
  /** Mídia já comprimida (PNG, MP3…) vai armazenada; o resto, com deflate. */
  compress: boolean
}

function dosTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** Escreve o ZIP entrada por entrada, sem manter o arquivo inteiro na memória. */
export class ZipWriter {
  private offset = 0
  private readonly central: Buffer[] = []
  private count = 0

  private constructor(private readonly handle: FileHandle) {}

  static async create(path: string): Promise<ZipWriter> {
    return new ZipWriter(await open(path, "w"))
  }

  async add(entry: ZipInput): Promise<void> {
    const name = Buffer.from(entry.name, "utf8")
    const checksum = crc32(entry.data)
    const payload = entry.compress ? deflateRawSync(entry.data) : entry.data
    const method = entry.compress ? 8 : 0
    if (this.offset + payload.length + 30 + name.length > LIMIT || entry.data.length > LIMIT) throw new Error("O mundo passa de 4 GB, o limite da exportação em .zip.")
    const { time, date } = dosTime(new Date())
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    await this.handle.write(Buffer.concat([local, name]))
    await this.handle.write(payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_HEADER, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(UTF8_FLAG, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(this.offset, 42)
    this.central.push(Buffer.concat([central, name]))
    this.offset += local.length + name.length + payload.length
    this.count += 1
    if (this.count > 0xffff) throw new Error("Arquivos demais para um .zip sem ZIP64.")
  }

  async close(): Promise<void> {
    const directory = Buffer.concat(this.central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END_OF_CENTRAL, 0)
    end.writeUInt16LE(this.count, 8)
    end.writeUInt16LE(this.count, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(this.offset, 16)
    await this.handle.write(Buffer.concat([directory, end]))
    await this.handle.close()
  }

  async abort(): Promise<void> {
    await this.handle.close().catch(() => undefined)
  }
}

export interface ZipEntry {
  name: string
  size: number
  compressedSize: number
  method: number
  crc: number
  offset: number
}

/** Lê o diretório central; o conteúdo de cada entrada é lido sob demanda. */
export class ZipReader {
  private constructor(private readonly handle: FileHandle, readonly entries: ZipEntry[]) {}

  static async open(path: string): Promise<ZipReader> {
    const handle = await open(path, "r")
    try {
      const { size } = await handle.stat()
      const tailSize = Math.min(size, 22 + 0xffff)
      const tail = Buffer.alloc(tailSize)
      await handle.read(tail, 0, tailSize, size - tailSize)
      let end = -1
      for (let index = tail.length - 22; index >= 0; index -= 1) if (tail.readUInt32LE(index) === END_OF_CENTRAL) { end = index; break }
      if (end < 0) throw new Error("O arquivo não é um .zip válido.")
      const count = tail.readUInt16LE(end + 10)
      const directorySize = tail.readUInt32LE(end + 12)
      const directoryOffset = tail.readUInt32LE(end + 16)
      if (directoryOffset + directorySize > size) throw new Error("O .zip está corrompido.")
      const directory = Buffer.alloc(directorySize)
      await handle.read(directory, 0, directorySize, directoryOffset)
      const entries: ZipEntry[] = []
      let cursor = 0
      for (let index = 0; index < count; index += 1) {
        if (directory.readUInt32LE(cursor) !== CENTRAL_HEADER) throw new Error("O .zip está corrompido.")
        const nameLength = directory.readUInt16LE(cursor + 28)
        const extraLength = directory.readUInt16LE(cursor + 30)
        const commentLength = directory.readUInt16LE(cursor + 32)
        entries.push({
          method: directory.readUInt16LE(cursor + 10),
          crc: directory.readUInt32LE(cursor + 16),
          compressedSize: directory.readUInt32LE(cursor + 20),
          size: directory.readUInt32LE(cursor + 24),
          offset: directory.readUInt32LE(cursor + 42),
          name: directory.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"),
        })
        cursor += 46 + nameLength + extraLength + commentLength
      }
      return new ZipReader(handle, entries)
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  /** Conteúdo da entrada, com o CRC conferido. */
  async read(entry: ZipEntry, maxBytes: number): Promise<Buffer> {
    if (entry.size > maxBytes) throw new Error(`"${entry.name}" é grande demais.`)
    const header = Buffer.alloc(30)
    await this.handle.read(header, 0, 30, entry.offset)
    if (header.readUInt32LE(0) !== LOCAL_HEADER) throw new Error("O .zip está corrompido.")
    const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    const raw = Buffer.alloc(entry.compressedSize)
    await this.handle.read(raw, 0, entry.compressedSize, start)
    let data: Buffer
    if (entry.method === 0) data = raw
    else if (entry.method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) })
    else throw new Error(`"${entry.name}" usa uma compressão não suportada.`)
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error(`"${entry.name}" está corrompido dentro do .zip.`)
    return data
  }

  async close(): Promise<void> {
    await this.handle.close()
  }
}
