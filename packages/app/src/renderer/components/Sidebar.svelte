<!--
  Sidebar.svelte re-export in components directory for compatibility.
-->
<script lang="ts">
  import Sidebar from '../Sidebar.svelte';
  import type { ComponentProps } from 'svelte';

  let props: ComponentProps<typeof Sidebar> = $props();
</script>

<Sidebar {...props} />
