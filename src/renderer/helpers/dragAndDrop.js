import { startDragPicture } from './channelDragAndDrop'

/**
 * @typedef {object} VideoData
 * @prop {string | null} videoId
 * @prop {string | null} playlistItemId
 */

/**
 * @callback DragVideo
 * @param {DragEvent} event
 * @param {VideoData} video
 */

/**
 * @callback MoveDraggedVideo
 * @param {VideoData} video
 * @param {VideoData} draggedVideo
 */

/**
 * @callback AfterDrag
 */

/**
 * @typedef {object} EventHandlers
 * @prop {DragVideo} dragVideo
 * @prop {MoveDraggedVideo} moveDraggedVideo
 * @prop {AfterDrag} afterDrag
 */

/**
 *
 * @param {(event: string, args: any[]) => void} emit
 * @returns {EventHandlers} eventHandlers
 */
export const handleDragAndDrop = (emit) => {
  /** Whether the drag in hand has been ended, by its drop or by dragend */
  let ended = true

  const endDrag = () => {
    document.removeEventListener('drop', endDrag, true)

    if (ended) { return }

    ended = true
    emit('drag-video-end')
  }

  /**
   * @type {DragVideo}
   */
  const dragVideo = (event, { videoId, playlistItemId }) => {
    // Use correct drag cursor.
    event.dataTransfer.effectAllowed = 'move'

    // Allows drag and drop to work with touch devices.
    event.dataTransfer.setData('text/plain', '_')

    // Fjernsyn: the picture under the pointer is the page's, not the
    // browser's, which hangs over the drop for half a second or more after it
    // (as on the Channels page). And the drag ends at the drop, not at the
    // dragend that comes after that pause.
    const source = event.currentTarget instanceof HTMLElement ? event.currentTarget : event.target
    if (source instanceof HTMLElement) {
      startDragPicture(event, source, null, (copy) => {
        copy.classList.remove('draggedVideo')
      })
    }

    ended = false
    document.addEventListener('drop', endDrag, true)

    emit('drag-video', { videoId, playlistItemId })
  }

  /**
   * @type {MoveDraggedVideo}
   */
  const moveDraggedVideo = (video, draggedVideo) => {
    const differentPlaylistItem = video.videoId !== draggedVideo.videoId || video.playlistItemId !== draggedVideo.playlistItemId

    if (differentPlaylistItem) {
      emit('move-dragged-video', video, draggedVideo)
    }
  }

  /**
   * @type {AfterDrag}
   */
  const afterDrag = endDrag

  return {
    dragVideo,
    moveDraggedVideo,
    afterDrag,
  }
}
