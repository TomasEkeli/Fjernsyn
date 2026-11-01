<template>
  <div>
    <FtCard class="card">
      <h2 class="visuallyHidden">
        {{ $t('Communities.Communities') }}
      </h2>
      <CommunitiesWall
        :title="$t('Communities.Communities')"
      />
    </FtCard>
  </div>
</template>

<script setup>
import CommunitiesWall from '../../components/CommunitiesWall/CommunitiesWall.vue'
import FtCard from '../../components/ft-card/ft-card.vue'

/**
 * Communities: one wall of the videos every followed source has shared, as
 * the subscriptions page is one wall of the channels followed. The wall, and
 * all it does on opening, is `components/CommunitiesWall`, which each
 * source's own page (`views/CommunitySource`) shows too, of that source's
 * videos alone. The sources are followed and unfollowed on the Sources page
 * (`views/Sources`).
 */
</script>

<style scoped src="./Communities.css" />
