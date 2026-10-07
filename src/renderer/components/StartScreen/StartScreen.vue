<template>
  <div class="startScreen">
    <TestCard
      :name="PRODUCT_NAME"
      :version="VERSION"
    />
  </div>
</template>

<script setup>
/*
 * What the window shows while the app starts: the test card, with the name and
 * version the About page gives it, filling the window. No links: nothing has
 * loaded yet, including the setting for how external links open.
 */
import TestCard from '../TestCard/TestCard.vue'

import packageDetails from '../../../../package.json'

const PRODUCT_NAME = packageDetails.productName

const VERSION = `v${packageDetails.version}`
</script>

<style scoped src="./StartScreen.css" />
