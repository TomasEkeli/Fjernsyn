import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'

import store from '../store/index'

import {
  enabledSubscriptionFeeds,
  subscriptionChannelIsFetched,
  subscriptionFeedDescriptor,
  SUBSCRIPTION_FEEDS
} from '../helpers/subscriptionFeeds'
import {
  cancelSubscriptionRefresh,
  refreshAllSubscriptionFeeds,
  refreshSubscriptionFeeds,
  subscriptionFeedState
} from '../helpers/subscriptionRefresh'
import { unavailableChannels } from '../helpers/subscriptionFetchStatus'
import {
  backfillDetailsForVisibleVideos,
  detailBackfillRevision
} from '../helpers/subscriptionDetailBackfill'
import { debounce } from '../helpers/utils'
import { mergeSubscriptionFeedEntries, splitUpcomingEntries } from '../../subscriptionFeedMerge'

/**
 * The subscriptions feed: every kind the user has switched on, in one stream.
 *
 * This was one feed's tab, instantiated once per tab, and before that it owned
 * the refresh as well. The refresh moved out because it outlives any component;
 * the four feeds have now been merged for the same sort of reason, one level up.
 * Four tabs meant the reader had to know which kind a thing was before they
 * could look for it, and had to visit four places to find out what had happened
 * since yesterday. There is one thing to read, so there is one list.
 *
 * What is still per kind is fetching, caching and the per-kind filters, and all
 * of that is left where it is: each feed's `postProcess` runs over its own
 * entries, and the merge only does the part that needs every kind at once —
 * one sort field, newest first. The per-channel cap keeps working because it
 * still sees a list; that it now counts across kinds rather than within one is
 * a detail nobody using it would notice.
 *
 * One list, but two: what is scheduled and has not happened yet comes out of
 * the stream at the end of assembly and is handed over separately, for the
 * shelf above it. Everything before that point is common, which is what keeps
 * the two answering to the same chips and the same settings.
 *
 * The cache remains the record of what has been fetched, each feed's revision
 * says when that record changed, and this rebuilds the stream from the cache
 * whenever any of them does — so a refresh that finishes while this page is
 * elsewhere is picked up whenever it comes back.
 */
export function useSubscriptionFeed() {
  /**
   * The kinds the user has switched on, in stream-assembly order.
   *
   * What is shown, and only that. Every kind is fetched whether or not it is in
   * here — see `fetchedSubscriptionFeeds` — so nothing in this file may narrow
   * a fetch down to this list: that is what made a kind switched off go stale.
   *
   * Reactive because deciding it reads the chips out of the store, and doing
   * that inside a computed is what subscribes to them: a chip pressed is a
   * setting written, which lands here, which rebuilds the stream.
   *
   * @type {import('vue').ComputedRef<string[]>}
   */
  const feeds = computed(() => enabledSubscriptionFeeds())

  /** There is nothing to look at yet. A refresh behind an existing stream is not this. */
  const isLoading = ref(true)

  const entryList = shallowRef([])

  /**
   * What is scheduled and has not happened yet, soonest first.
   *
   * Assembled from the same cache, by the same rules, and split out at the last
   * moment — so a chip switched off empties this of that kind exactly as it
   * empties the stream, and the hide-premieres setting empties it of premieres,
   * without either of them being mentioned twice.
   *
   * @type {import('vue').ShallowRef<any[]>}
   */
  const upcomingList = shallowRef([])

  /**
   * Which kind each entry in the stream came from.
   *
   * Once the four lists are one, an entry no longer says what fetched it, and
   * two things still need to know: the detail back-fill asks a channel's videos
   * tab or its live tab, and asking the wrong one wastes the request and then
   * records the channel as done. A weak map rather than a field on the entry,
   * because these objects are the cached ones and anything written onto them
   * ends up on disk.
   *
   * @type {WeakMap<object, string>}
   */
  let entryFeeds = new WeakMap()

  let alreadyLoadedRemotely = false

  /** Whether the page this is for has gone away. See the back-fill watch. */
  let disposed = false

  onScopeDispose(() => { disposed = true })

  /** @type {import('vue').ComputedRef<boolean>} */
  const subscriptionCacheReady = computed(() => store.getters.getSubscriptionCacheReady)

  /** @type {import('vue').ComputedRef<boolean>} */
  const fetchSubscriptionsAutomatically = computed(() => store.getters.getFetchSubscriptionsAutomatically)

  const activeSubscriptionList = computed(() => store.getters.getActiveProfile.subscriptions)

  /**
   * The channels a refresh of one kind asks about: all of them, less the
   * PeerTube ones while PeerTube is off or for a kind PeerTube has nothing in
   * (shorts, posts). Those still show what the cache holds for them, but a
   * kind cannot be waiting on a channel nobody is going to fetch, or one never
   * fetched would leave it incomplete for good and every visit here would
   * refresh every other channel to fill the gap.
   *
   * @param {string} feed
   * @returns {object[]}
   */
  function fetchedSubscriptionsFor(feed) {
    return activeSubscriptionList.value.filter(channel => subscriptionChannelIsFetched(channel, feed))
  }

  /**
   * A refresh is in flight for at least one of the kinds on screen.
   *
   * Any rather than all, because the stream is one thing: a refresh that is
   * still fetching posts is still a refresh of what is being read.
   *
   * The kinds on screen, though, and not every kind the refresh covers. This is
   * what the widget spins on and what the loader waits for, and both are about
   * the stream: once every kind in it is fetched, nothing more is going to
   * appear, and spinning through another half minute of a kind the reader
   * switched off would be announcing work they asked not to see. The progress
   * bar counts the whole cycle and still says the machine is busy. Switching
   * that kind on mid-refresh brings this back to true, which is the honest
   * answer to a stream that is about to grow.
   *
   * @type {import('vue').ComputedRef<boolean>}
   */
  const isRefreshing = computed(() => {
    return feeds.value.some(feed => subscriptionFeedState(feed).isRefreshing.value)
  })

  /** @type {import('vue').ComputedRef<boolean>} */
  const attemptedFetch = computed(() => {
    return feeds.value.some(feed => subscriptionFeedState(feed).attemptedFetch.value)
  })

  /**
   * Every feed's commit signal, added together.
   *
   * Deliberately over every feed rather than the enabled ones: a refresh
   * committing is worth rebuilding for whether or not the settings changed while
   * it was in flight, and the sum changes exactly when one of them does.
   *
   * @type {import('vue').ComputedRef<number>}
   */
  const feedRevisions = computed(() => {
    return SUBSCRIPTION_FEEDS.reduce((sum, feed) => sum + subscriptionFeedState(feed).revision.value, 0)
  })

  /** Channels that are gone rather than unreachable, so they can be unsubscribed from. */
  const errorChannels = computed(() => {
    /** @type {Map<string, object>} */
    const byId = new Map()

    for (const feed of feeds.value) {
      for (const channel of unavailableChannels(feed)) {
        // One dead channel found by three feeds is one dead channel
        if (!byId.has(channel.id)) {
          byId.set(channel.id, channel)
        }
      }
    }

    return Array.from(byId.values())
  })

  /**
   * The active profile's cache entries, per kind.
   *
   * Every kind, not only the ones on screen. A refresh fetches all four, so the
   * questions asked of this — whether that kind is complete, when it was last
   * fetched — are asked about kinds nobody is looking at as well. Assembly
   * picks the shown ones out of it.
   *
   * @type {import('vue').ComputedRef<Map<string, object[]>>}
   */
  const cacheEntriesByFeed = computed(() => {
    /** @type {Map<string, object[]>} */
    const byFeed = new Map()

    for (const feed of SUBSCRIPTION_FEEDS) {
      const cache = store.getters[subscriptionFeedDescriptor(feed).cacheGetter]
      const entries = []

      activeSubscriptionList.value.forEach((channel) => {
        const cacheEntry = cache[channel.id]

        if (cacheEntry != null) {
          entries.push(cacheEntry)
        }
      })

      byFeed.set(feed, entries)
    }

    return byFeed
  })

  /**
   * Whether the cache can supply one kind for the whole active profile.
   *
   * False for a kind nobody has fetched, and false again when a fetch left any
   * channel out, so it answers whether that kind is complete rather than
   * whether anyone has tried. Asked of the channels a refresh of that kind
   * fetches (`fetchedSubscriptionsFor`), which is every channel of a profile
   * with no PeerTube ones in it.
   *
   * A kind with nothing to fetch for a profile that has channels (PeerTube
   * ones only, and PeerTube off or the kind one PeerTube has nothing in) is
   * complete as it stands: no refresh could add to it. A profile with no
   * channels at all is not, as it never was.
   *
   * @param {string} feed
   * @returns {boolean}
   */
  function feedIsComplete(feed) {
    const channels = fetchedSubscriptionsFor(feed)

    if (channels.length === 0) {
      return activeSubscriptionList.value.length > 0
    }

    const { cacheGetter, entriesKey } = subscriptionFeedDescriptor(feed)
    const cache = store.getters[cacheGetter]

    return channels.every(channel => cache[channel.id]?.[entriesKey] != null)
  }

  /**
   * Whether the cache holds anything of one kind for the active profile.
   *
   * The looser neighbour of `feedIsComplete`: a fetch that reached 597 of 600
   * channels leaves that kind incomplete for good, and those 597 channels'
   * posts are still posts.
   *
   * An empty array is a real answer and counts, which is how a profile whose
   * channels have posted nothing is told from one nobody has fetched.
   *
   * @param {string} feed
   * @returns {boolean}
   */
  function feedHasAnyEntries(feed) {
    const { entriesKey } = subscriptionFeedDescriptor(feed)

    return (cacheEntriesByFeed.value.get(feed) ?? []).some(cacheEntry => cacheEntry[entriesKey] != null)
  }

  /**
   * The kinds the cache cannot supply in full for this profile.
   *
   * Every kind, again, not the shown ones: this is what a fetch is decided
   * from, and a kind is no less missing for being hidden. A chip that narrowed
   * this would be a chip that stopped a fetch.
   */
  const incompleteFeeds = computed(() => SUBSCRIPTION_FEEDS.filter(feed => !feedIsComplete(feed)))

  /**
   * Which kinds the cache holds anything of, as one string.
   *
   * Per kind rather than a single "anything at all", which is what it was when
   * there was one of these per tab. Merged into a boolean it would be true from
   * the first videos cache entry onwards and never change again, and the watcher
   * below — the one that lets a second window notice the first window's fetch —
   * would fire exactly never.
   *
   * A string rather than an array because a computed array is a new array every
   * time it recomputes, and this recomputes on every one of six hundred channel
   * writes. Watching that would rebuild the stream six hundred times.
   *
   * @type {import('vue').ComputedRef<string>}
   */
  const feedsWithAnyEntries = computed(() => feeds.value.filter(feedHasAnyEntries).join())

  /**
   * How old the stream is, as the oldest of the kinds in it.
   *
   * The oldest rather than the newest on purpose: with one kind fetched a minute
   * ago and another three days ago there is no true answer, and of the two
   * available lies the older one cannot make anything look fresher than it is.
   *
   * Raw rather than worded: how long ago that was is a question for whoever
   * shows it, against a clock that keeps moving after this is computed.
   *
   * @type {import('vue').ComputedRef<number | null>}
   */
  const lastRefreshAt = computed(() => {
    let oldest = null

    for (const feed of feeds.value) {
      const at = lastRefreshOfFeed(feed)

      if (at != null && (oldest == null || at < oldest)) {
        oldest = at
      }
    }

    return oldest
  })

  /**
   * When one kind was last brought up to date, or null when nothing says.
   *
   * @param {string} feed
   * @returns {number | null}
   */
  function lastRefreshOfFeed(feed) {
    // Cache is not ready when data is just loaded from remote
    const lastSuccessAt = subscriptionFeedState(feed).lastSuccessAt.value

    if (lastSuccessAt) { return lastSuccessAt }

    if (!feedIsComplete(feed)) { return null }

    let minTimestamp = null

    for (const cacheEntry of cacheEntriesByFeed.value.get(feed) ?? []) {
      if (minTimestamp == null || cacheEntry.timestamp.getTime() < minTimestamp) {
        minTimestamp = cacheEntry.timestamp.getTime()
      }
    }

    return minTimestamp
  }

  /**
   * Put what the cache holds on screen.
   *
   * This is the only thing that ever fills the stream. A refresh commits by
   * writing the cache and bumping the revision, which lands here; so does the
   * recovery, the detail back-fill, and anything else that changes what is
   * known.
   */
  function rebuildFromCache() {
    const nextEntryFeeds = new WeakMap()

    const lists = feeds.value.map((feed) => {
      const { entriesKey, postProcess } = subscriptionFeedDescriptor(feed)

      const entries = (cacheEntriesByFeed.value.get(feed) ?? []).flatMap((cacheEntry) => {
        return cacheEntry[entriesKey] ?? []
      })

      // Each kind is filtered, capped and sorted by its own rules first; the
      // merge below is only ever about putting them in one order
      const processed = postProcess(entries)

      for (const entry of processed) {
        nextEntryFeeds.set(entry, feed)
      }

      return processed
    })

    entryFeeds = nextEntryFeeds

    // The future comes out of the stream here, at the end, rather than in each
    // kind's `postProcess`: premieres and scheduled live streams arrive from
    // two different feeds and are one shelf, so the split belongs where the
    // kinds have already met.
    const { stream, upcoming } = splitUpcomingEntries(mergeSubscriptionFeedEntries(lists))

    entryList.value = stream
    upcomingList.value = upcoming

    // An empty stream with a refresh still running is not an answer yet, and
    // saying "your channels have published nothing" for the half minute six
    // hundred channels take would be a confident lie. Everything else — cache
    // complete, cache partial, nothing coming — is answered by what is here.
    if (!nothingToShow() || !isRefreshing.value) {
      isLoading.value = false
    }
  }

  /**
   * Whether the page has nothing on it at all.
   *
   * The shelf counts. A profile whose channels have published nothing this week
   * but have four premieres scheduled has something to read, and holding a
   * spinner over it until a refresh finishes would be hiding the only answer
   * there is.
   *
   * @returns {boolean}
   */
  function nothingToShow() {
    return entryList.value.length === 0 && upcomingList.value.length === 0
  }

  /** @returns {boolean} whether there was anything worth showing */
  function showCacheIfPresent() {
    if (!subscriptionCacheReady.value) { return false }
    if (incompleteFeeds.value.length > 0) { return false }

    rebuildFromCache()

    return true
  }

  /**
   * @param {object} options
   * @param {'profile' | 'cache-miss'} options.reason why this is being asked,
   *   which decides how much gets fetched if anything must be
   */
  function loadFromCacheSometimes({ reason }) {
    // Can only load reliably when cache ready
    if (!subscriptionCacheReady.value) { return }

    if (showCacheIfPresent()) { return }

    // The stream is rebuilt from the cache first, whatever happens next.
    //
    // The per-kind version cleared the list here instead, and was right to: the
    // list on screen belonged to whichever profile had just been left, and
    // leaving it up would have been showing the wrong feed. Rebuilding answers
    // that objection better than clearing does, because it reads the profile
    // that is current now — and merging four kinds turned "the cache cannot
    // supply this" from an exception into the ordinary case, since one kind
    // short of one channel is enough to say it. Blanking six hundred readable
    // entries over that is not a trade anyone would ask for.
    rebuildFromCache()

    if (isRefreshing.value) {
      // A refresh started before this page was mounted, or from another window's
      // doing, is already fetching. Wait for it rather than asking again.
      showLoaderIfEmpty()
      return
    }

    if (!fetchSubscriptionsAutomatically.value) {
      // Automatic fetching is off and the cache cannot supply every kind. What
      // it can supply is already on screen, and nothing else is coming until
      // the refresh button is pressed.
      //
      // The per-kind version also reset `attemptedFetch` here, so that a stream
      // nobody had fetched said "refresh to see them" rather than "your
      // channels have published nothing". That belongs to switching profile,
      // and `cancelSubscriptionRefresh` already does it there. Doing it again
      // on every visit would erase the record of a refresh that really did run
      // and really did find nothing.
      return
    }

    // A profile switch invalidates every kind, so every kind is fetched. A cache
    // that merely cannot supply one of them is about that one: starting a whole
    // cycle for it would mean navigating back to the subscriptions page could
    // re-fetch six hundred channels three times over.
    //
    // The kinds asked for here are the incomplete ones whether or not they are
    // being shown — a kind is fetched so that switching it on shows something
    // current, which it cannot do if being switched off is what kept it out of
    // the fetch.
    if (reason === 'profile') {
      refreshBehindLoader(() => refreshAllSubscriptionFeeds({ reason }))
    } else {
      refreshBehindLoader(() => refreshSubscriptionFeeds(incompleteFeeds.value, { reason }))
    }
  }

  function loadFromRemoteFirstPerWindowSometimes() {
    if (
      !fetchSubscriptionsAutomatically.value ||
      // Only auto fetch once per window
      store.getters.getSubscriptionsFirstAutoFetchRun
    ) {
      loadFromCacheSometimes({ reason: 'cache-miss' })
      return
    }

    alreadyLoadedRemotely = true

    // Put the cached stream up first if there is one. It is a few seconds old at
    // worst and entirely readable, where the alternative is half a minute of
    // empty page before anything appears at all. The refresh then runs behind it
    // and replaces it in one go, rather than growing the list underneath whoever
    // is reading it.
    if (!showCacheIfPresent() && subscriptionCacheReady.value) {
      // Not every kind is complete — a few channels failed last time, or a kind
      // has never been fetched at all — but incomplete is not unreadable, and
      // merging four kinds makes "one of them is short of a channel" four times
      // as likely as it was per tab. Put up what there is.
      rebuildFromCache()
    }

    // A cache that is merely still loading is the other reason
    // `showCacheIfPresent` says no, and then the loader is honest: the watch on
    // `subscriptionCacheReady` settles it once there is something to settle
    // with.

    store.commit('setSubscriptionsFirstAutoFetchRun')

    return refreshBehindLoader(() => refreshAllSubscriptionFeeds({ reason: 'auto' }))
  }

  /**
   * Put the spinner up before a fetch, but only when there is nothing behind
   * it.
   *
   * The stream already on screen is for this same profile and is still perfectly
   * readable, so it stays up while the refresh runs behind it, exactly as it
   * does on startup. Replacing it with a spinner for the half minute that six
   * hundred channels take hides the thing being read in order to announce that
   * it is being brought up to date.
   */
  function showLoaderIfEmpty() {
    if (nothingToShow()) {
      isLoading.value = true
    }
  }

  /**
   * Start a refresh with the loader over an empty stream, and be certain to take
   * it down again.
   *
   * The loader normally comes down when `isRefreshing` falls. A refresh that
   * fetches nothing at all never raises it, so that fall never happens, and the
   * spinner stays up over a page that is never going to change. Now that every
   * kind is fetched every time, the case left is a profile with no channels in
   * it: there is nothing to ask anyone for, so each kind finishes before it
   * starts.
   *
   * So the promise is the signal instead. It resolves when the refresh is over,
   * including when the refresh was nothing at all, and there is no longer any
   * honest reason to be showing a spinner.
   *
   * @param {() => Promise<void>} start
   * @returns {Promise<void>}
   */
  function refreshBehindLoader(start) {
    showLoaderIfEmpty()

    return start().finally(() => {
      if (!isRefreshing.value) {
        isLoading.value = false
      }
    })
  }

  /**
   * Refresh because someone asked for one, from the widget over the stream.
   *
   * Every kind, including the ones switched off, and including when automatic
   * fetching is off. This is the whole stream's button and names no kind; a
   * kind hidden now is one a chip can reveal a moment later, and fetching only
   * what happens to be on screen is what made that reveal show yesterday.
   *
   * Takes no arguments deliberately: it is bound to a template event, and a
   * payload arriving as an options object would quietly change what it does.
   */
  function refresh() {
    return refreshBehindLoader(() => refreshAllSubscriptionFeeds({ reason: 'button' }))
  }

  /**
   * Offer the part of the stream actually on screen for detail back-filling.
   *
   * Split by kind on the way, because the back-fill fetches a channel's videos
   * tab or its live tab and has no way to tell which an entry wants now that
   * they share a list. Entries whose kind is unknown — a slice held over from
   * before the last rebuild — are left out; the next slice carries them again.
   *
   * @param {any[]} visibleEntries
   */
  function noteVisibleEntries(visibleEntries) {
    if (isLoading.value) { return }

    /** @type {Map<string, any[]>} */
    const byFeed = new Map()

    for (const entry of visibleEntries) {
      const feed = entryFeeds.get(entry)

      if (feed == null) { continue }

      const forFeed = byFeed.get(feed)

      if (forFeed == null) {
        byFeed.set(feed, [entry])
      } else {
        forFeed.push(entry)
      }
    }

    for (const [feed, entries] of byFeed) {
      if (!subscriptionFeedDescriptor(feed).followsDetailBackfill) { continue }

      backfillDetailsForVisibleVideos(entries, feed)
    }
  }

  watch(feedRevisions, rebuildFromCache)

  /**
   * A cache write from an other window arrives here as a store mutation, with
   * none of the revision bump that the same write in this window would have
   * carried, so nothing rebuilds: this window goes on showing a stream with no
   * posts in it while the cache in front of it holds some.
   *
   * Rebuilding when a kind the cache had nothing of stops being empty puts the
   * two back together. It does not follow every later write: one window's
   * stream lagging another's is how this has always worked, and rebuilding on
   * each of six hundred channels would be a poor way to fix it.
   *
   * Not while this window is refreshing, because then the revision bump is
   * already coming, and it is what replaces the stream in one go rather than
   * growing it underneath whoever is reading.
   */
  watch(feedsWithAnyEntries, (current, previous) => {
    if (isRefreshing.value) { return }

    const before = new Set(previous.split(','))
    const gained = current.split(',').some(feed => feed !== '' && !before.has(feed))

    if (!gained) { return }

    rebuildFromCache()
  })

  watch(isRefreshing, (refreshing) => {
    // A refresh that ends without committing — cancelled, or superseded by a
    // profile switch — still has to take the spinner down with it
    if (!refreshing && isLoading.value) {
      isLoading.value = false
    }
  })

  /**
   * A chip pressed changes the stream, and it changes it now.
   *
   * Rebuilt, and never fetched: that a kind was switched off is no reason not
   * to have fetched it, so what switching it on reveals is as current as the
   * rest of the stream and is already in the cache. Switching a kind on used to
   * start a refresh of it, which is the coupling this is written against — the
   * fetch belongs to the refresh cycle, and asking for one here would put the
   * decision back in the hands of what is being shown, which is what made a
   * chip cost half a minute and a spinner.
   */
  watch(feeds, rebuildFromCache)

  /**
   * The back-fill writes straight into the entry objects this stream already
   * holds, and a shallowRef says nothing about that. Rebuilding from the cache
   * is what makes the new details appear: it triggers the ref, and the entries
   * that changed now carry a different key, so those items are rebuilt and read
   * their props again. Order does not change, because the merge leaves the
   * publish time alone.
   *
   * Debounced, which the per-kind version did not need to be. It bumps once per
   * channel filled in, so a first pass over six hundred channels asks for six
   * hundred rebuilds, and a rebuild now reassembles four kinds instead of one.
   * A background improvement to something already readable is not worth a
   * second of the main thread; it is worth one rebuild a second.
   *
   * A timer, unlike a watcher, is not stopped when the view goes away, so it
   * asks first.
   */
  const rebuildAfterBackfill = debounce(() => {
    if (disposed) { return }

    rebuildFromCache()
  }, 1000)

  watch(detailBackfillRevision, () => {
    if (nothingToShow()) { return }

    rebuildAfterBackfill()
  })

  /**
   * Which channels this profile holds, as one string.
   *
   * Deliberately not the list itself, deeply watched, as it used to be. A
   * refresh writes back the channel names and avatars it learned, which replaces
   * the profile object; watching the list therefore meant every finishing feed
   * announced itself as a profile change, and a profile change cancels the
   * refresh. The first feed to finish would have cancelled the other two.
   *
   * What is actually being watched for is the set of channels changing:
   * switching profile, subscribing, unsubscribing.
   */
  const activeProfileChannelIds = computed(() => {
    return activeSubscriptionList.value.map(channel => channel.id).join()
  })

  watch(activeProfileChannelIds, () => {
    // Everything queued is for channels nobody is looking at any more
    cancelSubscriptionRefresh()

    isLoading.value = true
    loadFromCacheSometimes({ reason: 'profile' })
  })

  if (!subscriptionCacheReady.value) {
    watch(subscriptionCacheReady, () => {
      if (!alreadyLoadedRemotely) {
        loadFromCacheSometimes({ reason: 'cache-miss' })
        return
      }

      // The cache finishes loading after this view is mounted, so the automatic
      // refresh on startup begins before there is anything to show. As soon as
      // there is, put it up: waiting for the refresh means half a minute of
      // empty page while holding a perfectly readable copy. A cache that turns
      // out to hold nothing leaves the loader up, and whichever refresh is
      // running takes it down when it finishes.
      if (nothingToShow()) {
        rebuildFromCache()
      }
    })
  }

  onMounted(() => {
    loadFromRemoteFirstPerWindowSometimes()
  })

  return {
    isLoading,
    isRefreshing,
    entryList,
    upcomingList,
    errorChannels,
    attemptedFetch,
    lastRefreshAt,
    noteVisibleEntries,
    refresh
  }
}
