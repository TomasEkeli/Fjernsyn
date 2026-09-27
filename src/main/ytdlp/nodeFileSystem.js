import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'

/**
 * The few filesystem operations the installer and extraction need, on the
 * real filesystem. Tests hand them an in-memory one with the same shape.
 *
 * @typedef {object} FileSystem
 * @property {(dir: string) => Promise<void>} mkdir recursive, and fine if it exists
 * @property {(filePath: string, options?: { exclusive?: boolean }) => Promise<{ write: (chunk: Uint8Array) => Promise<void>, close: () => Promise<void> }>} openWrite
 *   exclusive: fails with EEXIST rather than truncate a file already there
 * @property {(filePath: string) => Promise<Uint8Array>} readFile
 * @property {(filePath: string) => AsyncIterable<Uint8Array>} openRead
 * @property {(from: string, to: string) => Promise<void>} rename replaces `to`
 * @property {(filePath: string) => Promise<void>} rm fine if it does not exist
 * @property {(filePath: string, mode: number) => Promise<void>} chmod
 * @property {(filePath: string) => Promise<boolean>} exists anything at that path, file or not
 * @property {(from: string, to: string) => Promise<void>} link a hard link; fails with EEXIST rather than replace `to`
 */

/** @type {FileSystem} */
export const nodeFileSystem = {
  mkdir: async (dir) => {
    await fs.mkdir(dir, { recursive: true })
  },

  openWrite: async (filePath, { exclusive = false } = {}) => {
    const handle = await fs.open(filePath, exclusive ? 'wx' : 'w')
    return {
      write: async (chunk) => {
        // A short write is possible, and would otherwise leave a file shorter
        // than the bytes that were checked
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
          offset += bytesWritten
        }
      },
      close: () => handle.close(),
    }
  },

  readFile: async (filePath) => new Uint8Array(await fs.readFile(filePath)),

  openRead: filePath => createReadStream(filePath),

  rename: (from, to) => fs.rename(from, to),

  rm: (filePath) => fs.rm(filePath, { force: true }),

  chmod: (filePath, mode) => fs.chmod(filePath, mode),

  link: (from, to) => fs.link(from, to),

  exists: async (filePath) => {
    try {
      await fs.lstat(filePath)
      return true
    } catch {
      return false
    }
  },
}
