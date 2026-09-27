/**
 * Checks the rules behind profile suggestions on the Channels page: what is
 * remembered about a channel, what category it is given, how profiles are
 * understood from their members, and which channels are proposed where.
 *
 * The page only draws what these functions return, and a suggestion that is
 * slightly wrong looks just as plausible as one that is right, so the rules
 * are pinned down here, input to output.
 *
 * Run with `pnpm run check-profile-suggestions`.
 */

import {
  addKeep,
  channelCategory,
  channelFit,
  channelsToProbe,
  channelTagsChanged,
  FIT_THRESHOLD,
  hasCharacter,
  isKept,
  knownChannel,
  MIN_KNOWN,
  MIN_TAG_GROUP,
  MOVE_MARGIN,
  MOVE_THRESHOLD,
  needsVideoSamples,
  normaliseChannelTags,
  profileCharacter,
  proposeProfiles,
  pruneKeeps,
  sharedVideoTags,
  TAG_LIMIT,
  UNASSIGNED,
  videoSample,
  watchedCategories,
} from '../src/renderer/helpers/profileSuggestions.js'
import { channelMemberships } from '../src/renderer/helpers/channelsOverview.js'
import { MAIN_PROFILE_ID } from '../src/constants.js'

let failures = 0

function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    console.log(`FAIL ${name}`)
    failures++
  }
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Normalising a channel page's tags
{
  check('the page tags are preferred over the keywords', same(
    normaliseChannelTags({ tags: ['Lo-Fi', 'Study'], keywords: 'ignored words' }, 'Chill Beats').tags,
    ['lo-fi', 'study']
  ))
  check('with no page tags, the keywords are used', same(
    normaliseChannelTags({ tags: [], keywords: 'lofi chill' }, 'Chill Beats').tags,
    ['lofi', 'chill']
  ))
  check('a quoted keyword stays whole', same(
    normaliseChannelTags({ keywords: 'gaming "let\'s play" "retro  games" speedrun' }).tags,
    ['gaming', "let's play", 'retro games', 'speedrun']
  ))
  check('a quote left open is not part of the keyword', same(
    normaliseChannelTags({ keywords: 'music "live sessions' }).tags,
    ['music', 'live', 'sessions']
  ))
  check('lower-cased, trimmed, and inner space collapsed', same(
    normaliseChannelTags({ tags: ['  Science   AND  Tech ', 'SPACE'] }).tags,
    ['science and tech', 'space']
  ))
  check('composed the same way whatever the input', same(
    normaliseChannelTags({ tags: ['cafe\u0301'] }).tags,
    ['caf\u00e9']
  ))
  check('empty tags, single characters and bare numbers are dropped', same(
    normaliseChannelTags({ tags: ['', '   ', 'a', '2024', '42', 'b2', 'ok'] }).tags,
    ['b2', 'ok']
  ))
  check('the channel\'s own name is dropped', same(
    normaliseChannelTags({ tags: ['Chill  Beats', 'lofi'] }, 'chill beats').tags,
    ['lofi']
  ))
  check('repeats are dropped, first seen order kept', same(
    normaliseChannelTags({ tags: ['Music', 'jazz', 'MUSIC', 'Jazz', 'blues'] }).tags,
    ['music', 'jazz', 'blues']
  ))

  const many = Array.from({ length: 50 }, (_, i) => `tag${i}`)
  const capped = normaliseChannelTags({ tags: many }).tags
  check('capped, keeping the first', capped.length === TAG_LIMIT && capped[0] === 'tag0' && capped[TAG_LIMIT - 1] === `tag${TAG_LIMIT - 1}`)

  check('an artist channel is flagged', normaliseChannelTags({ music_artist_name: 'Someone' }).musicArtist === true)
  check('an empty artist name is not an artist', normaliseChannelTags({ music_artist_name: '' }).musicArtist === false)
  check('no metadata gives nothing', same(normaliseChannelTags(undefined, 'x'), { tags: [], musicArtist: false }))
  check('tags that are not strings are skipped', same(normaliseChannelTags({ tags: [null, 3, 'fine'] }).tags, ['fine']))
}

// Whether newly seen tags need writing
{
  const stored = { tags: ['a1', 'b1'], musicArtist: false, seenAt: 1 }

  check('the same tags, order and flag need no write', !channelTagsChanged(stored, { tags: ['a1', 'b1'], musicArtist: false }))
  check('a tag added needs a write', channelTagsChanged(stored, { tags: ['a1', 'b1', 'c1'], musicArtist: false }))
  check('a tag removed needs a write', channelTagsChanged(stored, { tags: ['a1'], musicArtist: false }))
  check('reordered tags need a write', channelTagsChanged(stored, { tags: ['b1', 'a1'], musicArtist: false }))
  check('a changed artist flag needs a write', channelTagsChanged(stored, { tags: ['a1', 'b1'], musicArtist: true }))
  check('nothing stored and something new needs a write', channelTagsChanged(undefined, { tags: ['a1'], musicArtist: false }))
  check('nothing stored and only the flag needs a write', channelTagsChanged(null, { tags: [], musicArtist: true }))
  check('nothing stored and nothing new needs no write', !channelTagsChanged(undefined, { tags: [], musicArtist: false }))
  check('a stored record without a tag list takes a write for new tags', channelTagsChanged({ musicArtist: false }, { tags: ['a1'], musicArtist: false }))
}

// Watched categories
{
  const history = [
    { videoId: 'v1', authorId: 'a', category: 'Music', timeWatched: 100 },
    { videoId: 'v2', authorId: 'a', category: 'Music', timeWatched: 300 },
    { videoId: 'v3', authorId: 'a', category: 'Gaming', timeWatched: 200 },
    { videoId: 'v4', authorId: 'b', category: 'Comedy', timeWatched: 50 },
    { videoId: 'v5', authorId: 'b', timeWatched: 400 },
    { videoId: 'v6', authorId: 'b', category: '', timeWatched: 500 },
    { videoId: 'v7', category: 'Music', timeWatched: 600 },
    { videoId: 'v8', authorId: '', category: 'Music', timeWatched: 700 }
  ]

  const watched = watchedCategories(history)

  check('counts each category per channel', watched.get('a').get('Music').count === 2 && watched.get('a').get('Gaming').count === 1)
  check('keeps the most recent watch per category', watched.get('a').get('Music').lastWatched === 300)
  check('an entry with no category is ignored', watched.get('b').size === 1 && watched.get('b').get('Comedy').count === 1)
  check('an entry with no channel is ignored', watched.size === 2)
  check('no history gives nothing', watchedCategories([]).size === 0)
}

// A channel's category
{
  const watched = (...entries) => new Map(entries.map(([name, count, lastWatched]) => [name, { count, lastWatched }]))

  check('a Topic channel is Music', channelCategory({ id: 't', name: 'Someone - Topic' })?.name === 'Music')
  check('a Topic channel\'s evidence says so', channelCategory({ id: 't', name: 'Someone - Topic' })?.evidence.type === 'artist')
  check('a name merely containing Topic is not', channelCategory({ id: 't', name: 'Topic Talks' }) === null)
  check('nor one ending in Topic without the dash', channelCategory({ id: 't', name: 'Hot Topic' }) === null)
  check('the artist flag is Music', channelCategory({ id: 'a', name: 'Band' }, { tags: [], musicArtist: true })?.name === 'Music')
  check('the artist flag beats what was watched', channelCategory({ id: 'a', name: 'Band' }, { tags: [], musicArtist: true }, watched(['Comedy', 5, 1]))?.name === 'Music')
  check('the most watched category wins', channelCategory({ id: 'c', name: 'C' }, null, watched(['Comedy', 1, 900], ['Gaming', 3, 100]))?.name === 'Gaming')
  check('a tie goes to the most recently watched', channelCategory({ id: 'c', name: 'C' }, null, watched(['Comedy', 2, 100], ['Gaming', 2, 900]))?.name === 'Gaming')
  check('the evidence counts the watched videos', JSON.stringify(channelCategory({ id: 'c', name: 'C' }, null, watched(['Gaming', 3, 1]))?.evidence) === JSON.stringify({ type: 'watched', category: 'Gaming', count: 3 }))
  check('nothing known gives no category', channelCategory({ id: 'c', name: 'C' }, null, undefined) === null)
}

// Profile character and fit
{
  const n = MIN_KNOWN
  const member = (id, category, tags = []) => ({
    channel: { id, name: id },
    category: category === null ? null : { name: category, evidence: { type: 'watched', category, count: 1 } },
    tags
  })
  const many = (prefix, count, category, tags) => Array.from({ length: count }, (_, i) => member(`${prefix}${i}`, category, tags))

  const few = profileCharacter(many('a', n - 1, 'Music'))
  check(`below ${n} known members there is no character`, !hasCharacter(few))
  check('nothing fits a profile without character', channelFit(few, member('x', 'Music'), 'p', false) === null)

  const music = profileCharacter([...many('m', n, 'Music'), member('g', 'Gaming')])
  check('enough known members is a character', hasCharacter(music))
  check('the category share is the fit', channelFit(music, member('x', 'Music'), 'p', false).fit === n / (n + 1))
  check('the evidence names the category share', channelFit(music, member('x', 'Music'), 'p', false).evidence.type === 'categoryShare')
  check('a member is left out of its own profile', channelFit(music, member('m0', 'Music'), 'p', true).fit === (n - 1) / n)
  check('left out, the odd one out fits not at all, but is judged', channelFit(music, member('g', 'Gaming'), 'p', true).fit === 0)
  const exactly = profileCharacter(many('m', n, 'Music'))
  check(`left out, ${n} known is too few`, channelFit(exactly, member('m0', 'Music'), 'p', true) === null)

  const tagged = profileCharacter([
    ...many('l', n - 1, null, ['lofi', 'study']),
    member('c', null, ['lofi', 'chill']),
    member('s', null, ['chill', 'solo'])
  ])
  check('the tag share is the fit', channelFit(tagged, member('x', null, ['lofi']), 'p', false).fit === n / (n + 1))
  check('the largest tag share counts', channelFit(tagged, member('x', null, ['chill', 'lofi']), 'p', false).evidence.tag === 'lofi')
  check('a tag carried by one member does not count', channelFit(tagged, member('x', null, ['solo']), 'p', false).fit === 0)
  check('nor does one carried by none', channelFit(tagged, member('x', null, ['metal']), 'p', false).evidence === null)
  check('the tag evidence counts members', (() => {
    const { evidence } = channelFit(tagged, member('x', null, ['lofi']), 'p', false)
    return evidence.count === n && evidence.total === n + 1 && evidence.profileId === 'p'
  })())
  check('tags are left out for a member too', channelFit(tagged, member('l0', null, ['lofi', 'study']), 'p', true).fit === (n - 1) / n)

  // Stop-list tags never reach the counts: knownChannel drops them
  const stopped = knownChannel({ id: 's', name: 'S' }, { tags: ['youtube', 'video', 'lofi'], musicArtist: false })
  check('stop-list tags are dropped before counting', JSON.stringify(stopped.tags) === JSON.stringify(['lofi']))
  const allStopped = profileCharacter(Array.from({ length: n + 1 }, (_, i) => knownChannel({ id: `s${i}`, name: `s${i}` }, { tags: ['youtube', 'official'], musicArtist: false })))
  check('members with only stop-list tags are not tagged members', allStopped.tagged === 0 && !hasCharacter(allStopped))

  const both = profileCharacter([...many('m', n, 'Music', ['lofi']), ...many('g', n, 'Gaming', ['lofi'])])
  const fit = channelFit(both, member('x', 'Music', ['lofi']), 'p', false)
  check('the fit is the larger signal', fit.fit === 1)
  check('and its evidence is the one that decided', fit.evidence.type === 'tagShare')
  const catWins = channelFit(both, member('x', 'Music', ['other']), 'p', false)
  check('the category decides when it is larger', catWins.fit === 0.5 && catWins.evidence.type === 'categoryShare')
  const even = profileCharacter([...many('m', n, 'Music', ['lofi']), ...many('g', n, 'Gaming', ['jazz'])])
  const tie = channelFit(even, member('x', 'Music', ['lofi']), 'p', false)
  check('a tie between the two goes to the category', tie.fit === 0.5 && tie.evidence.type === 'categoryShare')
}

// Proposals
{
  const ch = (id, name = `Channel ${id}`) => ({ id, name, thumbnail: '' })
  const profile = (_id, name, channels) => ({ _id, name, bgColor: '#000000', textColor: '#FFFFFF', subscriptions: channels })
  const primary = (...channels) => profile(MAIN_PROFILE_ID, 'All Channels', channels)
  const watchedAs = (pairs) => watchedCategories(pairs.flatMap(([authorId, category, times = 1]) => {
    return Array.from({ length: times }, (_, i) => ({ authorId, category, timeWatched: i + 1 }))
  }))
  const tagsFor = (entries) => Object.fromEntries(entries.map(([id, tags, musicArtist = false]) => [id, { tags, musicArtist, seenAt: 1 }]))
  const keysOf = result => result.proposals.map(found => found.key).join(',')
  const idsIn = (result, key) => result.proposals.find(found => found.key === key)?.channels.map(suggested => suggested.channel.id).join(',')
  const remainderIds = result => result.remainder.map(channel => channel.id).join(',')

  // Category groups for the pool
  {
    const channels = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ch(id))
    const profileList = [
      primary(...channels, ch('t', 'Band - Topic')),
      profile('p1', ' music ', [channels[5]])
    ]
    const watched = watchedAs([['a', 'Comedy'], ['b', 'Comedy'], ['c', 'Gaming'], ['d', 'Music'], ['f', 'Gaming']])
    const result = proposeProfiles({ profileList, watched, collator })

    check('pool channels are grouped by category', idsIn(result, 'category:Comedy') === 'a,b' && idsIn(result, 'category:Gaming') === 'c')
    check('a channel in a profile is not grouped', !result.proposals.some(found => found.channels.some(suggested => suggested.channel.id === 'f')))
    check('a category named as a profile goes to it, across case and spaces', idsIn(result, 'profile:p1') === 't,d')
    check('a Topic channel goes with Music', idsIn(result, 'profile:p1').includes('t'))
    check('profile proposals first, then categories by size', keysOf(result) === 'profile:p1,category:Comedy,category:Gaming')
    check('the remainder is what no proposal took', remainderIds(result) === 'e')
    check('every pool channel comes from the pool', result.proposals.every(found => found.channels.every(suggested => suggested.sourceProfileId === null)))
    check('a profile proposal names its profile', result.proposals[0].kind === 'profile' && result.proposals[0].profileId === 'p1')

    const dismissed = proposeProfiles({ profileList, watched, collator, dismissed: new Set(['category:Comedy']) })
    check('a dismissed group is gone', !keysOf(dismissed).includes('Comedy'))
    check('and its channels are back in the pool', remainderIds(dismissed) === 'a,b,e')
  }

  {
    const composed = ch('a')
    const profileList = [primary(composed, ch('b')), profile('p1', 'Caf\u00e9', [ch('b')])]
    const watched = watchedAs([['a', 'Cafe\u0301']])
    const result = proposeProfiles({ profileList, watched, collator })
    check('a category matches a profile whatever its Unicode composition', idsIn(result, 'profile:p1') === 'a')
  }

  {
    const profileList = [{ ...primary(ch('a')), name: 'Music' }]
    const result = proposeProfiles({ profileList, watched: watchedAs([['a', 'Music']]), collator })
    check('the primary profile is never matched by name', keysOf(result) === 'category:Music')
  }

  {
    const channels = ['a', 'b', 'c', 'd', 'e'].map(id => ch(id))
    const profileList = [primary(...channels)]
    const watched = watchedAs([['a', 'Sports'], ['b', 'Comedy'], ['c', 'Comedy'], ['d', 'Autos'], ['e', 'Travel']])
    const result = proposeProfiles({ profileList, watched, collator })
    check('same-size groups are in name order', keysOf(result) === 'category:Comedy,category:Autos,category:Sports,category:Travel')
  }

  // Tags
  {
    const channels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'].map(id => ch(id))
    const profileList = [primary(...channels), profile('p1', 'Gaming', []), profile('p2', 'Science', [])]
    const watched = watchedAs([['a', 'Music'], ['k', 'Science']])
    const channelTags = tagsFor([
      ['b', ['retro', 'gaming']], // names a profile, by its second tag
      ['c', ['music', 'gaming']], // music names only a category group, and profiles come first
      ['d', ['piano', 'music']], // joins the Music category group
      ['e', ['lofi', 'chill', 'youtube']],
      ['f', ['lofi', 'chill', 'youtube']],
      ['g', ['chill', 'lofi', 'youtube']],
      ['h', ['chill', 'ambient', 'youtube']],
      ['i', ['ambient', 'youtube']],
      ['j', ['youtube', 'video', 'ambient']],
      ['l', [], true] // an artist channel with no tags
    ])
    const result = proposeProfiles({ profileList, watched, channelTags, collator })

    check('a tag naming a profile suggests it for that profile', idsIn(result, 'profile:p1') === 'b,c')
    check('even for a profile with no character', result.proposals[0].key === 'profile:p1')
    check('the evidence is the naming tag', result.proposals[0].channels[0].evidence.type === 'tagged' && result.proposals[0].channels[0].evidence.tag === 'gaming')
    check('a watched category naming a profile joins that proposal too', idsIn(result, 'profile:p2') === 'k')
    check('the artist flag gives Music', idsIn(result, 'category:Music').includes('l'))
    check('a tag naming a category group joins it', idsIn(result, 'category:Music') === 'a,d,l')
    check('the tag shared most is grouped first, a tie by name', idsIn(result, 'tag:chill') === 'e,f,g,h')
    check('a channel is in one group only', idsIn(result, 'tag:lofi') === undefined)
    check(`a group needs ${MIN_TAG_GROUP} channels`, idsIn(result, 'tag:ambient') === undefined)
    check('stop-list tags never group', idsIn(result, 'tag:youtube') === undefined)
    check('what is left stays in the pool', remainderIds(result) === 'i,j,m')
    check('order: profiles, categories, tags', keysOf(result) === 'profile:p1,profile:p2,category:Music,tag:chill')
    check('a tag group\'s evidence leads with its tag', JSON.stringify(result.proposals[3].channels[0].evidence.tags) === JSON.stringify(['chill', 'lofi']))

    const existing = proposeProfiles({
      profileList,
      watched: watchedAs([['a', 'Music'], ['m', 'Gaming']]),
      channelTags,
      collator
    })
    check('a tag naming a profile joins its existing proposal', idsIn(existing, 'profile:p1') === 'b,c,m')

    const dismissed = proposeProfiles({ profileList, watched, channelTags, collator, dismissed: new Set(['tag:chill']) })
    check('a dismissed tag group\'s channels stay in the pool', remainderIds(dismissed) === 'e,f,g,h,i,j,m')
    check('and its tag is not used again', !keysOf(dismissed).includes('tag:'))

    const dismissedProfile = proposeProfiles({ profileList, watched, channelTags, collator, dismissed: new Set(['profile:p1']) })
    check('a dismissed profile proposal\'s channels go to the pool, not elsewhere', remainderIds(dismissedProfile) === 'b,c,i,j,m')
  }

  {
    const channels = ['a', 'b', 'c', 'd', 'e'].map(id => ch(id))
    const profileList = [primary(...channels), profile('p1', 'Chess', []), profile('p2', 'Puzzles', [])]
    const channelTags = new Map([
      ['a', { tags: ['puzzles', 'chess'], musicArtist: false }],
      ['b', { tags: ['chess', 'puzzles'], musicArtist: false }]
    ])
    const result = proposeProfiles({ profileList, channelTags, collator })
    check('channel tags can come as a Map', idsIn(result, 'profile:p1') === 'b')
    check('of two tags naming profiles, the first decides', idsIn(result, 'profile:p2') === 'a')

    const watched = watchedAs([['c', 'Music'], ['d', ' music'], ['e', 'MUSIC']])
    const merged = proposeProfiles({ profileList, watched, collator })
    check('categories that differ only in case or spacing are one group', keysOf(merged) === 'category:Music' && idsIn(merged, 'category:Music') === 'c,d,e')
  }

  {
    // A dismissed category group's channels share a tag that could group them
    const channels = ['a', 'b', 'c', 'd'].map(id => ch(id))
    const watched = watchedAs([['a', 'Comedy'], ['b', 'Comedy'], ['c', 'Comedy']])
    const channelTags = tagsFor([['a', ['sketch']], ['b', ['sketch']], ['c', ['sketch']], ['d', ['sketch']]])
    const shown = proposeProfiles({ profileList: [primary(...channels)], watched, channelTags, collator })
    check('channels grouped by category are not grouped by tag too', keysOf(shown) === 'category:Comedy')
    const dismissed = proposeProfiles({ profileList: [primary(...channels)], watched, channelTags, collator, dismissed: new Set(['category:Comedy']) })
    check('a dismissed category group is not regrouped by a tag', keysOf(dismissed) === '' && remainderIds(dismissed) === 'a,b,c,d')
  }

  {
    // Two tags tied on count, the collator deciding
    const channels = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ch(id))
    const channelTags = tagsFor([
      ['a', ['zeta']], ['b', ['zeta']], ['c', ['zeta']],
      ['d', ['alpha']], ['e', ['alpha']], ['f', ['alpha']]
    ])
    const result = proposeProfiles({ profileList: [primary(...channels)], channelTags, collator })
    check('tag groups of one size are in name order', keysOf(result) === 'tag:alpha,tag:zeta')
  }

  // Fit against profile characters
  {
    const size = MIN_KNOWN + 1
    const members = (prefix, count) => Array.from({ length: count }, (_, i) => ch(`${prefix}${i}`))
    const games = members('g', size)
    // Sized so that the share of Education is exactly the threshold
    const learning = members('s', 20)
    const educational = Math.round(FIT_THRESHOLD * learning.length)
    const pool = [ch('x'), ch('y'), ch('z'), ch('w')]
    const both = ch('dup')
    const profileList = [
      primary(...games, ...learning, ...pool, both),
      profile('p1', 'Games', [...games, both]),
      profile('p2', 'Learning', [...learning, both])
    ]
    const watched = watchedAs([
      ...games.map(c => [c.id, 'Gaming']),
      ...learning.slice(0, educational).map(c => [c.id, 'Education']),
      ...learning.slice(educational).map(c => [c.id, 'Science & Technology']),
      ['x', 'Gaming'],
      ['y', 'Education'],
      ['z', 'Comedy'],
      ['dup', 'Gaming', 5]
    ])
    const result = proposeProfiles({ profileList, watched, collator })

    check('a pool channel fitting a profile is suggested for it', idsIn(result, 'profile:p1') === 'x')
    check('with the share as its evidence', result.proposals[0].channels[0].evidence.type === 'categoryShare' && result.proposals[0].channels[0].evidence.share === 1)
    check(`a fit of exactly ${FIT_THRESHOLD} is enough`, educational / learning.length === FIT_THRESHOLD && idsIn(result, 'profile:p2') === 'y')
    check('below the threshold a channel moves on to the later steps', idsIn(result, 'category:Comedy') === 'z')
    check('a channel in two profiles never appears', !result.proposals.some(found => found.channels.some(suggested => suggested.channel.id === 'dup')))
    check('nor in the remainder', remainderIds(result) === 'w')
    check('and does not count as a member', (() => {
      // Were it counted, Learning would have a Gaming member, and x a share of it
      const character = profileCharacter(learning.map(c => knownChannel(c, undefined, watched.get(c.id))))
      return character.categorised === learning.length && !character.categories.has('Gaming')
    })())
    check('coverage counts channels known', result.coverage.known === games.length + learning.length + 4 && result.coverage.total === games.length + learning.length + 5)
    check('coverage counts profiles with a character', result.coverage.profiles === 2 && result.coverage.profileCount === 2)

    const alike = members('h', size)
    const tie = proposeProfiles({
      profileList: [
        primary(...games, ...alike, ch('x')),
        profile('p1', 'Games', games),
        profile('p2', 'More games', alike)
      ],
      watched: watchedAs([...games.map(c => [c.id, 'Gaming']), ...alike.map(c => [c.id, 'Gaming']), ['x', 'Gaming']]),
      collator
    })
    check('a tie goes to the earlier profile', idsIn(tie, 'profile:p1') === 'x' && idsIn(tie, 'profile:p2') === undefined)

    const fewer = games.slice(0, MIN_KNOWN - 1)
    const few = proposeProfiles({
      profileList: [primary(...fewer, ch('x')), profile('p1', 'Games', fewer)],
      watched: watchedAs([...fewer.map(c => [c.id, 'Gaming']), ['x', 'Gaming']]),
      collator
    })
    check('a profile with too few known members attracts nothing by fit', idsIn(few, 'profile:p1') === undefined && idsIn(few, 'category:Gaming') === 'x')
    check('and has no character in the coverage', few.coverage.profiles === 0)
  }

  // Suggested moves
  {
    const size = MIN_KNOWN + 1
    const members = (prefix, count) => Array.from({ length: count }, (_, i) => ch(`${prefix}${i}`))
    const games = members('g', size)
    const music = members('m', size)
    const stray = ch('stray')
    const profileList = [
      primary(...games, ...music, stray),
      profile('p1', 'Games', [...games, stray]),
      profile('p2', 'Tunes', music)
    ]
    const watched = watchedAs([
      ...games.map(c => [c.id, 'Gaming']),
      ...music.map(c => [c.id, 'Music']),
      ['stray', 'Music', 3]
    ])
    const result = proposeProfiles({ profileList, watched, collator })

    check('a channel fitting another profile clearly better is a suggested move', idsIn(result, 'profile:p2') === 'stray')
    check('its source is the profile it is in', result.proposals[0].channels[0].sourceProfileId === 'p1')
    check('it stays out of the remainder', remainderIds(result) === '')
    check('channels that fit where they are stay', result.proposals.length === 1)

    const memberships = channelMemberships(profileList)
    const keeps = addKeep({}, memberships, 'stray', 'p1')
    check('a keep applies while the channel is where it was kept', isKept(keeps, memberships, 'stray'))
    check('a keep for its current profile suppresses the move', proposeProfiles({ profileList, watched, keeps, collator }).proposals.length === 0)

    const stale = { stray: 'p2' }
    check('a stale keep does not apply', !isKept(stale, memberships, 'stray'))
    check('and does not suppress the move', idsIn(proposeProfiles({ profileList, watched, keeps: stale, collator }), 'profile:p2') === 'stray')
    check('adding a keep drops the stale ones', JSON.stringify(addKeep({ other: 'p2', m0: 'p2' }, memberships, 'stray', 'p1')) === JSON.stringify({ m0: 'p2', stray: 'p1' }))
    check('pruning keeps that all apply changes nothing', pruneKeeps(keeps, memberships) === keeps)

    // Moved away, the keep lapses, and moving back does not bring it back
    const movedAway = [primary(...games, ...music, stray), profile('p1', 'Games', games), profile('p2', 'Tunes', [...music, stray])]
    const pruned = pruneKeeps(keeps, channelMemberships(movedAway))
    check('a keep lapses once the channel is moved', JSON.stringify(pruned) === '{}')
    check('and once lapsed, moving back is suggested again', idsIn(proposeProfiles({ profileList, watched, keeps: pruned, collator }), 'profile:p2') === 'stray')

    const dismissed = proposeProfiles({ profileList, watched, collator, dismissed: new Set(['profile:p2']) })
    check('a dismissed profile proposal drops its moves', dismissed.proposals.length === 0 && remainderIds(dismissed) === '')

    // The margin: Games is six parts Music to two of Gaming, so its own fit is
    // 0.75, against Tunes' 1 when all Music, or less when not
    const mixed = members('x', 8)
    const margin = (tunes) => proposeProfiles({
      profileList: [
        primary(...mixed, ...music, stray),
        profile('p1', 'Games', [...mixed, stray]),
        profile('p2', 'Tunes', music)
      ],
      watched: watchedAs([
        ...mixed.map((c, i) => [c.id, i < 2 ? 'Gaming' : 'Music']),
        ...music.map((c, i) => [c.id, tunes(i)]),
        ['stray', 'Music']
      ]),
      collator
    })
    check(`a move with exactly the margin of ${MOVE_MARGIN} is suggested`, idsIn(margin(() => 'Music'), 'profile:p2')?.split(',').includes('stray'))
    check('a move with less than the margin is not', !(idsIn(margin(i => i === 0 ? 'Comedy' : 'Music'), 'profile:p2') ?? '').split(',').includes('stray'))

    // Its own profile unknown: never moved out of it
    const unknownHome = proposeProfiles({
      profileList,
      watched: watchedAs([...music.map(c => [c.id, 'Music']), ['stray', 'Music']]),
      collator
    })
    check('no move out of a profile with no character', unknownHome.proposals.length === 0)

    // Its own profile known, but only by what the channel has none of
    const otherSignal = proposeProfiles({
      profileList,
      watched: watchedAs([...music.map(c => [c.id, 'Music'])]),
      channelTags: tagsFor([...games.map(c => [c.id, ['speedrun', 'retro']]), ...music.map(c => [c.id, ['jazz']]), ['stray', ['jazz']]]),
      collator
    })
    check('a move is judged by what the channel has against its own profile', idsIn(otherSignal, 'profile:p2') === 'stray')

    // Tunes only three parts in eight Music: enough for the pool, not for a move
    const newcomer = ch('new')
    const eight = members('e', 8)
    const weak = proposeProfiles({
      profileList: [
        primary(...games, ...eight, stray, newcomer),
        profile('p1', 'Games', [...games, stray]),
        profile('p2', 'Tunes', eight)
      ],
      watched: watchedAs([
        ...games.map(c => [c.id, 'Gaming']),
        ...eight.map((c, i) => [c.id, i < 3 ? 'Music' : 'Comedy']),
        ['stray', 'Music'],
        ['new', 'Music']
      ]),
      collator
    })
    check(`${FIT_THRESHOLD} is enough for a pool channel`, 3 / 8 >= FIT_THRESHOLD && idsIn(weak, 'profile:p2') === 'new')
    check(`but a move needs ${MOVE_THRESHOLD}`, 3 / 8 < MOVE_THRESHOLD && !idsIn(weak, 'profile:p2')?.includes('stray'))

    // Half of Tunes Music: exactly the threshold for a move
    const half = proposeProfiles({
      profileList: [
        primary(...games, ...eight, stray),
        profile('p1', 'Games', [...games, stray]),
        profile('p2', 'Tunes', eight)
      ],
      watched: watchedAs([
        ...games.map(c => [c.id, 'Gaming']),
        ...eight.map((c, i) => [c.id, i < 4 ? 'Music' : 'Comedy']),
        ['stray', 'Music']
      ]),
      collator
    })
    check(`a move at exactly ${MOVE_THRESHOLD} is suggested`, 4 / 8 === MOVE_THRESHOLD && idsIn(half, 'profile:p2') === 'stray')
  }
}

// Rejecting and placing by hand
{
  const ch = (id, name = `Channel ${id}`) => ({ id, name, thumbnail: '' })
  const profile = (_id, name, channels) => ({ _id, name, bgColor: '#000000', textColor: '#FFFFFF', subscriptions: channels })
  const idsIn = (result, key) => result.proposals.find(found => found.key === key)?.channels.map(suggested => suggested.channel.id).join(',')
  const keysOf = result => result.proposals.map(found => found.key).join(',')
  const remainderIds = result => result.remainder.map(channel => channel.id).join(',')
  const watchedAs = pairs => watchedCategories(pairs.map(([authorId, category]) => ({ authorId, category, timeWatched: 1 })))

  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(id => ch(id))
  const profileList = [
    profile(MAIN_PROFILE_ID, 'All Channels', [a, b, c, d, e]),
    profile('p1', 'Games', [c]),
    profile('p2', 'Science', [d]),
    profile('p3', 'Both', [d, e]),
    profile('p4', 'Music', [])
  ]
  const memberships = channelMemberships(profileList)
  const watched = watchedAs([['a', 'Music'], ['b', 'Comedy']])

  // Rejecting a pool channel's suggestion keeps it in the pool
  const keeps = { a: UNASSIGNED }
  check('a keep in the pool applies while the channel is unassigned', isKept(keeps, memberships, 'a'))
  const rejected = proposeProfiles({ profileList, watched, keeps, collator })
  check('a rejected pool channel is suggested nowhere', idsIn(rejected, 'profile:p4') === undefined && remainderIds(rejected) === 'a')
  check('once filed, a keep in the pool lapses', !isKept(keeps, channelMemberships([...profileList.slice(0, 4), profile('p4', 'Music', [a])]), 'a'))

  // Placing by hand
  const placements = {
    b: { key: 'profile:p1', from: UNASSIGNED }, // a pool channel into a profile's suggestion
    c: { key: 'tag:retro', from: 'p1' }, // one in Games into a new group
    d: { key: 'profile:p1', from: 'p2' } // one in two profiles: left alone
  }
  const placed = proposeProfiles({ profileList, watched, placements, collator })
  check('a channel placed by hand goes where it was put', idsIn(placed, 'profile:p1') === 'b')
  check('with that as its evidence', placed.proposals[0].channels[0].evidence.type === 'placed')
  check('and nowhere else', idsIn(placed, 'category:Comedy') === undefined)
  check('a channel placed from a profile is a move out of it', idsIn(placed, 'tag:retro') === 'c' && placed.proposals.find(found => found.key === 'tag:retro').channels[0].sourceProfileId === 'p1')
  check('a channel in two profiles is never placed', !keysOf(placed).includes('p1') || !idsIn(placed, 'profile:p1').includes('d'))

  const moved = proposeProfiles({ profileList, watched, placements: { b: { key: 'profile:p1', from: 'p2' } }, collator })
  check('a placement lapses once the channel is somewhere else', idsIn(moved, 'category:Comedy') === 'b')
  check('placing a channel in its own profile does nothing', idsIn(proposeProfiles({ profileList, placements: { c: { key: 'profile:p1', from: 'p1' } }, collator }), 'profile:p1') === undefined)
  check('a placement wins over a keep', idsIn(proposeProfiles({ profileList, keeps: { b: UNASSIGNED }, placements: { b: { key: 'profile:p1', from: UNASSIGNED } }, collator }), 'profile:p1') === 'b')
  check('a group named as a profile by now is that profile\'s', idsIn(proposeProfiles({ profileList, placements: new Map([['b', { key: 'category:Music', from: UNASSIGNED }]]), collator }), 'profile:p4') === 'b')
  check('a placement into a profile that is gone is ignored', idsIn(proposeProfiles({ profileList, watched, placements: { b: { key: 'profile:gone', from: UNASSIGNED } }, collator }), 'category:Comedy') === 'b')
}

// Probing a channel's recent videos
{
  const samples = (...videos) => ({ sampledAt: 1, videos: videos.map(([category, keywords = []], i) => ({ videoId: `v${i}`, category, keywords })) })
  const plain = { id: 'c', name: 'Some Channel' }

  check('a sampled video keeps its category trimmed and its tags normalised', JSON.stringify(videoSample('v', ' Gaming ', ['Retro Games', 'Some Channel', 'x', 'retro games'], 'Some Channel')) === JSON.stringify({ videoId: 'v', category: 'Gaming', keywords: ['retro games'] }))
  check('a sample with no category keeps an empty one', videoSample('v', undefined, undefined).category === '' && videoSample('v', undefined, undefined).keywords.length === 0)

  check('the most common sampled category is the channel\'s', channelCategory(plain, null, null, samples(['Comedy'], ['Gaming'], ['Gaming']))?.name === 'Gaming')
  check('a tie goes to the newest video', channelCategory(plain, null, null, samples(['Comedy'], ['Gaming']))?.name === 'Comedy')
  check('the evidence counts the sampled videos', JSON.stringify(channelCategory(plain, null, null, samples(['Gaming'], ['Gaming'], ['']))?.evidence) === JSON.stringify({ type: 'sampled', category: 'Gaming', count: 2, total: 2 }))
  const watched = new Map([['Education', { count: 1, lastWatched: 1 }]])
  check('what was watched comes before what was sampled', channelCategory(plain, null, watched, samples(['Gaming'], ['Gaming']))?.name === 'Education')
  check('samples with no category give none', channelCategory(plain, null, null, samples([''], [''])) === null)

  check('a channel not looked at needs samples', needsVideoSamples(plain, null, undefined))
  check('one looked at does not, even with no videos found', !needsVideoSamples(plain, null, { sampledAt: 1, videos: [] }))
  check('a Topic channel does not', !needsVideoSamples({ id: 't', name: 'Band - Topic' }, null, undefined))
  check('an artist channel does not', !needsVideoSamples(plain, { tags: [], musicArtist: true }, undefined))
  const peerTube = { id: 'blender@video.blender.org', name: 'Blender', thumbnail: '', platform: 'peertube', host: 'video.blender.org' }
  check('a PeerTube channel does not: its videos are not YouTube\'s to sample', !needsVideoSamples(peerTube, null, undefined))
  check('a channel marked YouTube still does', needsVideoSamples({ ...plain, platform: 'youtube' }, null, undefined))

  const shared = samples(['', ['lofi', 'study', 'rain']], ['', ['study', 'lofi']], ['', ['lofi', 'jazz']])
  check('video tags on enough of the videos are shared, most shared first', JSON.stringify(sharedVideoTags(shared)) === JSON.stringify(['lofi', 'study']))
  check('a tag repeated on one video counts once', sharedVideoTags(samples(['', ['solo', 'solo']])).length === 0)
  check('shared video tags stand in when the channel has none', JSON.stringify(knownChannel(plain, { tags: [], musicArtist: false }, null, shared).tags) === JSON.stringify(['lofi', 'study']))
  check('but never over the channel\'s own', JSON.stringify(knownChannel(plain, { tags: ['chill'], musicArtist: false }, null, shared).tags) === JSON.stringify(['chill']))

  const ch = (id, name = `Channel ${id}`) => ({ id, name, thumbnail: '' })
  const profile = (_id, name, channels) => ({ _id, name, bgColor: '#000000', textColor: '#FFFFFF', subscriptions: channels })
  const [a, b, c, d, e] = [ch('a', 'Zed'), ch('b', 'Alpha'), ch('c'), ch('d'), ch('e', 'Band - Topic')]
  const profileList = [
    profile(MAIN_PROFILE_ID, 'All Channels', [a, b, c, d, e]),
    profile('p1', 'One', [c, d]),
    profile('p2', 'Two', [d])
  ]
  const learn = channelsToProbe(profileList, {}, { a: { sampledAt: 1, videos: [] } }, collator)
  check('probing takes the pool first, then channels in one profile, skipping the rest', learn.map(channel => channel.id).join(',') === 'b,c')
  const peerTubeChannel = { id: 'blender@video.blender.org', name: 'Blender', thumbnail: '', platform: 'peertube', host: 'video.blender.org' }
  const withPeerTube = [profile(MAIN_PROFILE_ID, 'All Channels', [a, b, peerTubeChannel]), profile('p1', 'One', [peerTubeChannel])]
  check('probing never takes a PeerTube channel', channelsToProbe(withPeerTube, {}, {}, collator).map(channel => channel.id).join(',') === 'b,a')

  const result = proposeProfiles({
    profileList: [profile(MAIN_PROFILE_ID, 'All Channels', [a, b])],
    videoSamples: new Map([['a', samples(['Gaming'])], ['b', samples(['Gaming'], ['Comedy'])]]),
    collator
  })
  check('sampled categories group channels as watched ones do', result.proposals[0]?.key === 'category:Gaming' && result.proposals[0].channels.length === 2)
  check('and count towards what is known', result.coverage.known === 2)
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
