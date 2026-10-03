<template>
  <div class="aboutPage">
    <TestCard
      :name="PRODUCT_NAME"
      :version="versionNumber"
      :name-url="REPOSITORY_URL"
      :version-url="releaseUrl"
      :build-stamp="buildStamp"
    />
  </div>
</template>

<script setup>
/*
 * The test card and nothing else. Its name box leads to the repository, whose
 * README says where Fjernsyn comes from and credits FreeTube; its version box
 * leads to the release this build is, when it is one.
 */
import TestCard from '../../components/TestCard/TestCard.vue'

import packageDetails from '../../../../package.json'

const PRODUCT_NAME = packageDetails.productName

const REPOSITORY_URL = 'https://github.com/TomasEkeli/Fjernsyn'

const versionNumber = `v${packageDetails.version}`

/**
 * Every push to main is released, and the build workflow bakes the release's
 * tag in (see .github/workflows/build.yml). Any other build, a branch's or a
 * local one, is no release and has no page to lead to.
 */
const releaseUrl = process.env.RELEASE_TAG
  ? `${REPOSITORY_URL}/releases/tag/${process.env.RELEASE_TAG}`
  : null

/**
 * Which build this is, as opposed to which version. Every build of a version is
 * otherwise indistinguishable, so there is no way to tell whether the one you
 * are running contains a given change. Baked in at build time; empty when it
 * could not be worked out, in which case there is no tooltip.
 */
const buildStamp = process.env.BUILD_STAMP || null
</script>

<style scoped src="./About.css" />
