import { squareCrop, validProfilePicture } from '../../helpers/profilePictures'

/** @import { ProfilePicture } from '../../helpers/profilePictures' */

/** Larger than any photo needs to be, to be made into 128 pixels */
const MAX_FILE_SIZE = 20 * 1024 * 1024
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** The side of the square stored: twice the largest bubble, for sharp edges on a high density screen */
const SIZE = 128

/**
 * A local image file made into a picture, all in the renderer: the largest
 * square in its middle, scaled to 128 by 128 and encoded as WebP (or PNG,
 * where the canvas cannot encode WebP). An animated GIF gives its first
 * frame. What comes out is always a `data:` URL the app made itself, whatever
 * went in.
 * @param {File} file
 * @returns {Promise<(ProfilePicture & { kind: 'image' }) | null>} null for a file that cannot be used
 */
export async function pictureFromFile(file) {
  if (file.size > MAX_FILE_SIZE || !TYPES.has(file.type)) {
    return null
  }

  /** @type {ImageBitmap} */
  let bitmap

  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // Not an image, whatever its name says
    return null
  }

  try {
    const { sx, sy, size } = squareCrop(bitmap.width, bitmap.height)

    if (size === 0) {
      return null
    }

    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE

    const context = canvas.getContext('2d')

    if (!context) {
      return null
    }

    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, sx, sy, size, size, 0, 0, SIZE, SIZE)

    const picture = validProfilePicture({ kind: 'image', src: canvas.toDataURL('image/webp', 0.9) })

    return picture?.kind === 'image' ? picture : null
  } finally {
    bitmap.close()
  }
}
