<template>
  <div>
    <FtCard class="card">
      <CollectionsWall
        v-if="source"
        :key="source._id"
        :source-id="source._id"
        :title="source.name"
      >
        <template #header>
          <h2 class="sourceName">
            {{ source.name }}
          </h2>
          <p class="sourceAbout">
            <span>{{ kindLabel }}</span>
            <a
              v-if="instance !== ''"
              :href="source.url"
            >{{ instance }}</a>
          </p>
          <I18nT
            v-if="isHackerTube"
            keypath="Collections.HackerTube Credit"
            tag="p"
            class="credit"
            scope="global"
          >
            <template
              v-for="link in CREDIT_LINKS"
              :key="link.slot"
              #[link.slot]
            >
              <a :href="link.href">{{ link.name }}</a>
            </template>
          </I18nT>
        </template>
      </CollectionsWall>
      <FtLoader
        v-else-if="!ready"
      />
      <p
        v-else-if="grabFailed"
        class="message"
      >
        {{ $t('Sources.Read Failed') }}
      </p>
      <I18nT
        v-else
        keypath="Sources.Not Followed"
        tag="p"
        class="message"
        scope="global"
      >
        <template #sources>
          <RouterLink to="/sources">
            {{ $t('Sources.Sources') }}
          </RouterLink>
        </template>
      </I18nT>
    </FtCard>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Translation as I18nT, useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

import CollectionsWall from '../../components/CollectionsWall/CollectionsWall.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'

import store from '../../store/index'

import { HACKERTUBE_SOURCE_ID } from '../../helpers/collections/hackertube'
import { sourceInstance, sourceKindLabel } from '../../helpers/collections/sourceLabels'

/**
 * A source's own page, at `/sources/<source id>`: Collections' wall
 * (`components/CollectionsWall`), of this source's videos alone, ordered by
 * its own votes and dates, under its name, what kind of place it is, and the
 * instance it is on. HackerTube's page carries the credit its data's licence
 * asks for. A source not followed, as one unfollowed in another window, has
 * no page, and says so.
 */

const { t } = useI18n()
const route = useRoute()

/**
 * What HackerTube's licence (ODC-By 1.0) asks to be credited, by the names
 * they go by, which are not translated
 */
const CREDIT_LINKS = [
  { slot: 'hackertube', name: 'HackerTube', href: 'https://hackertube.org' },
  { slot: 'dataset', name: 'open-index/hacker-news', href: 'https://huggingface.co/datasets/open-index/hacker-news' },
  { slot: 'licence', name: 'ODC-By 1.0', href: 'https://opendatacommons.org/licenses/by/1-0/' },
]

/** @type {import('vue').ComputedRef<boolean>} */
const ready = computed(() => store.getters.getCollectionsReady)

/** @type {import('vue').ComputedRef<boolean>} */
const grabFailed = computed(() => store.getters.getCollectionsGrabFailed)

/** @type {import('vue').ComputedRef<import('../../helpers/collections/shares').Source | undefined>} */
const source = computed(() => {
  const id = route.params.sourceId
  return store.getters.getCollectionSources.find(followed => followed._id === id)
})

/** @type {import('vue').ComputedRef<boolean>} */
const isHackerTube = computed(() => source.value?._id === HACKERTUBE_SOURCE_ID)

/** @type {import('vue').ComputedRef<string>} */
const kindLabel = computed(() => source.value ? sourceKindLabel(source.value.kind, t) : '')

/** @type {import('vue').ComputedRef<string>} */
const instance = computed(() => source.value ? sourceInstance(source.value) : '')
</script>

<style scoped src="./CollectionSource.css" />
