<script lang="ts">
import { base } from "$app/paths";
import PasskeyLogin from "$lib/PasskeyLogin.svelte";
</script>

<svelte:head>
  <title>creating space</title>
</svelte:head>

<main>
  <img src="{base}/favicon/favicon-32x32.png" alt="creating space logo" />
  <PasskeyLogin />
</main>

<style>
main {
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 1px solid transparent;
  min-height: calc(100% - 20px);
  margin: 1vw;
}

img {
  animation: scaleUp 1s ease-in-out infinite;
}

@keyframes scaleUp {
  from {
    transform: scale(1);
  }
  to {
    transform: scale(1.2);
  }
}
</style>
