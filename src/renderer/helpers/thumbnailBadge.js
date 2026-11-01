/**
 * How a wall puts a badge of its own on its cards' thumbnails without any of
 * the components between it and the cards knowing: it provides a component
 * under this key, and every `FtListVideo` below it draws that component at the
 * top left of its thumbnail, given the card's video as its `video` prop. The
 * component decides for itself whether it shows anything.
 *
 * A wall that provides nothing, which is every wall but the collections walls
 * (the vote badge, components/CollectionsVoteBadge), gets its cards as they
 * always were. Provide and inject rather than a prop or a slot, which would
 * have had to be handed down through FtElementList and FtListLazyWrapper, two
 * more upstream files, to reach the card.
 *
 * @type {import('vue').InjectionKey<import('vue').Component>}
 */
export const THUMBNAIL_BADGE = Symbol('thumbnailBadge')
