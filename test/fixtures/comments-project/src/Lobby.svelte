<script>
  /* rs.track("svelte_block_comment") */
  // rs.track("svelte_line_comment")
  function join() {
    rs.track('svelte_script_call');
  }
</script>

<!-- <button on:click={() => rs.track('svelte_markup_comment')}>Join</button> -->
<button on:click={() => rs.track('svelte_markup_click')}>Join</button>
