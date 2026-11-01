<template>
  <div>
    <FtCard class="card">
      <h2 class="visuallyHidden">
        {{ $t('Collections.Collections') }}
      </h2>
      <CollectionsWall
        :title="$t('Collections.Collections')"
      />
    </FtCard>
  </div>
</template>

<script setup>
import CollectionsWall from '../../components/CollectionsWall/CollectionsWall.vue'
import FtCard from '../../components/ft-card/ft-card.vue'

/**
 * Collections: one wall of the videos every followed source has shared, as
 * the subscriptions page is one wall of the channels followed. The wall, and
 * all it does on opening, is `components/CollectionsWall`, which each
 * source's own page (`views/CollectionSource`) shows too, of that source's
 * videos alone. The sources are followed and unfollowed on the Sources page
 * (`views/Sources`).
 */
</script>

<style scoped src="./Collections.css" />
