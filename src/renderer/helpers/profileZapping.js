/**
 * The profile a step away from the active one, in the order the list is in,
 * wrapping around at either end, like zapping between channels.
 * @template {{ _id: string }} P
 * @param {P[]} profiles
 * @param {string} activeId
 * @param {1 | -1} step
 * @returns {P | undefined} undefined when there is nowhere else to go
 */
export function neighbourProfile(profiles, activeId, step) {
  if (profiles.length < 2) {
    return undefined
  }

  const index = profiles.findIndex(profile => profile._id === activeId)

  // An active profile missing from the list starts from the edge it is
  // stepped towards
  if (index === -1) {
    return step > 0 ? profiles[0] : profiles[profiles.length - 1]
  }

  return profiles[(index + step + profiles.length) % profiles.length]
}
