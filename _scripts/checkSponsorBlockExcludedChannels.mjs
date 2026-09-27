/**
 * Checks the rules behind the SponsorBlock excluded channels list: reading the
 * setting, putting a channel on it and taking it off, carrying the fork's old
 * never-skip list over, and finding a subscribed channel from its name.
 *
 * A channel on the list that should not be, or one missing from it, shows only
 * as a sponsor read that is or is not jumped past, which is easy to put down
 * to SponsorBlock itself, so the rules are pinned down here, input to output.
 *
 * Run with `pnpm run check-sponsorblock-excluded-channels`.
 */

import {
  exclusionSuggestions,
  isExcludedChannel,
  mergeMarkOnlyChannels,
  parseExcludedChannels,
  resolveSubscribedChannel,
  subscribedChannelLabels,
  subscribedChannelsNamed,
  suggestionsMatching,
  withChannelExcluded,
  withoutChannel,
} from '../src/sponsorBlockExcludedChannels.js'

let failures = 0

function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    console.log(`FAIL ${name}`)
    failures++
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb'
const C = 'UCcccccccccccccccccccccc'

// Reading the setting
{
  const stored = [{ name: A, preferredName: 'Alpha' }]
  check('the default is an empty list', same(parseExcludedChannels('[]'), []))
  check('a stored list comes back as it was', same(parseExcludedChannels(JSON.stringify(stored)), stored))
  check('a value that does not parse is an empty list', same(parseExcludedChannels('[{'), []))
  check('a value that is not a list is an empty list', same(parseExcludedChannels('{"name":"x"}'), []))
  check('no value is an empty list', same(parseExcludedChannels(undefined), []))
  check('entries with no channel id in them are dropped', same(
    parseExcludedChannels(JSON.stringify([null, 'x', { preferredName: 'No id' }, { name: 7 }, ...stored])),
    stored
  ))
  check('so a damaged list can still take the old entries', same(
    mergeMarkOnlyChannels(parseExcludedChannels('[null]'), [{ id: B, name: 'Beta' }]),
    [{ name: B, preferredName: 'Beta' }]
  ))
}

// Membership
{
  const list = [{ name: A, preferredName: 'Alpha' }]
  check('a listed channel is excluded', isExcludedChannel(list, A))
  check('an unlisted channel is not', !isExcludedChannel(list, B))
  check('no channel id is never excluded', !isExcludedChannel([{ name: '' }], ''))
  check('the id is matched exactly, case and all', !isExcludedChannel(list, A.toLowerCase()))
}

// Putting a channel on the list and taking it off
{
  const list = [{ name: A, preferredName: 'Alpha', icon: 'a.jpg' }]

  check('a new channel goes on the end with its name', same(
    withChannelExcluded(list, B, 'Beta'),
    [...list, { name: B, preferredName: 'Beta' }]
  ))
  check('a channel already on it is left as it was', withChannelExcluded(list, A, 'Other') === list)
  check('an empty id adds nothing', withChannelExcluded(list, '', 'Nobody') === list)
  check('taking one off leaves the rest', same(
    withoutChannel([...list, { name: B }], A),
    [{ name: B }]
  ))
  check('taking off one that is not there changes nothing', same(withoutChannel(list, C), list))
  check('the list given is never changed in place', (() => {
    const before = JSON.stringify(list)
    withChannelExcluded(list, B, 'Beta')
    withoutChannel(list, A)
    return JSON.stringify(list) === before
  })())
}

// Carrying the old never-skip list over
{
  const upstream = [{ name: A, preferredName: 'Alpha', icon: 'a.jpg', iconHref: `/channel/${A}` }]

  check('old entries are added in upstream\'s shape', same(
    mergeMarkOnlyChannels([], [{ id: B, name: 'Beta' }]),
    [{ name: B, preferredName: 'Beta' }]
  ))
  check('a channel on both lists keeps upstream\'s entry, icon and all', same(
    mergeMarkOnlyChannels(upstream, [{ id: A, name: 'Old Alpha' }, { id: B, name: 'Beta' }]),
    [...upstream, { name: B, preferredName: 'Beta' }]
  ))
  check('a name that was only the id is dropped, so the real one is looked up', same(
    mergeMarkOnlyChannels([], [{ id: C, name: C }]),
    [{ name: C, preferredName: '' }]
  ))
  check('malformed old entries are skipped', same(
    mergeMarkOnlyChannels([], [null, 'x', { name: 'no id' }, { id: 42 }, { id: B }]),
    [{ name: B, preferredName: '' }]
  ))
  check('an old value that is not a list changes nothing', mergeMarkOnlyChannels(upstream, 'nope') === upstream)
  check('an old list repeating a channel adds it once', same(
    mergeMarkOnlyChannels([], [{ id: B, name: 'Beta' }, { id: B, name: 'Beta' }]),
    [{ name: B, preferredName: 'Beta' }]
  ))
}

// Finding a subscribed channel from its name
{
  const D = 'UCdddddddddddddddddddddd'
  const subscriptions = [
    { id: A, name: 'Alpha Channel' },
    { id: B, name: 'AC/DC' },
    { id: C, name: 'Twins' },
    { id: D, name: 'twins' },
    { id: 'UCeeeeeeeeeeeeeeeeeeeeee', name: 'Cafe\u0301' },
    { id: 'UCffffffffffffffffffffff' },
  ]

  const resolved = (text) => resolveSubscribedChannel(subscriptions, text)?.id ?? null

  check('a name finds its channel', resolved('Alpha Channel') === A)
  check('case and surrounding space do not matter', resolved('  alpha channel ') === A)
  check('a slash in a name is part of the name, not a URL', resolved('AC/DC') === B)
  check('composed and decomposed accents match', resolved('Caf\u00e9') === 'UCeeeeeeeeeeeeeeeeeeeeee')
  check('only a whole name matches', resolveSubscribedChannel(subscriptions, 'Alpha') === null)
  check('a name two channels share is ambiguous', same(resolveSubscribedChannel(subscriptions, 'Twins'), { ambiguous: true, name: 'Twins' }))
  check('whatever its case, and says the name as a channel has it', same(resolveSubscribedChannel(subscriptions, 'TWINS'), { ambiguous: true, name: 'Twins' }))
  check('but the label with the id finds the one meant', resolved(`twins (${D})`) === D && resolved(`Twins (${C})`) === C)
  check('both are reported as matching the name', subscribedChannelsNamed(subscriptions, 'TWINS').length === 2)
  check('an id is not a name', resolveSubscribedChannel(subscriptions, A) === null)
  check('empty text finds nothing', resolveSubscribedChannel(subscriptions, '   ') === null)
  check('a channel with no stored name is never matched', subscribedChannelsNamed(subscriptions, 'undefined').length === 0)
}

// Labels, and suggestions as the name is typed
{
  const D = 'UCdddddddddddddddddddddd'
  const E = 'UCeeeeeeeeeeeeeeeeeeeeee'
  const subscriptions = [
    { id: A, name: 'beta' },
    { id: B, name: 'Alpha' },
    { id: C, name: 'Gamma' },
    { id: D, name: 'Twins' },
    { id: E, name: 'twins' },
    { id: 'UCffffffffffffffffffffff', name: '  ' },
  ]

  check('a name only one channel has is its label', same(
    subscribedChannelLabels(subscriptions, collator).slice(0, 3),
    [{ id: B, label: 'Alpha' }, { id: A, label: 'beta' }, { id: C, label: 'Gamma' }]
  ))
  check('a shared name is told apart by the id', same(
    subscribedChannelLabels(subscriptions, collator).slice(3).map(entry => entry.label),
    [`Twins (${D})`, `twins (${E})`]
  ))
  check('a channel with a blank name has no label', subscribedChannelLabels(subscriptions).length === 5)

  const suggestions = exclusionSuggestions(subscriptions, [{ name: C }, { name: E }], collator)

  check('subscribed channels are offered in label order', same(suggestions, ['Alpha', 'beta', `Twins (${D})`]))
  check('a channel already on the list is not offered', !suggestions.includes('Gamma'))
  check('one of two sharing a name is still offered once the other is on the list', suggestions.includes(`Twins (${D})`))
  check('every offered label resolves to its channel', suggestions.every(label => resolveSubscribedChannel(subscriptions, label)?.id))
}

// Narrowing the suggestions to what has been typed
{
  const names = ['Alpha', 'Beta Alpha', 'Calphabet', 'Delta', 'alpaca', 'Gamma (Alpha)']

  check('names starting with the text come first, then word starts, then the rest', same(
    suggestionsMatching(names, 'alp'),
    ['Alpha', 'alpaca', 'Beta Alpha', 'Gamma (Alpha)', 'Calphabet']
  ))
  check('case does not matter', same(suggestionsMatching(names, 'DELTA'), ['Delta']))
  check('no more than the limit', suggestionsMatching(names, 'a', 3).length === 3)
  check('nothing typed suggests nothing', same(suggestionsMatching(names, '  '), []))
  check('every suggestion passes the input\'s own filter', suggestionsMatching(names, 'lph')
    .every(name => name.toLowerCase().includes('lph')))
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
