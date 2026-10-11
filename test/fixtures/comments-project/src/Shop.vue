<template>
  <!-- <button @click="rs.track('vue_template_comment')">Buy</button> -->
  <button @click="rs.track('vue_template_click')">Buy</button>
</template>

<script setup lang="ts">
// rs.track("vue_script_comment")
/**
 * rs.track("vue_jsdoc")
 */
function buy() {
  rs.track('vue_script_call');
}
</script>

<style>
/* rs.track("vue_style_comment") */
.buy { color: red; }
</style>
