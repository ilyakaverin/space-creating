<script lang="ts">
import featureImage from "./assets/favicon/favicon-32x32.png";
import PasskeyLogin from "./lib/PasskeyLogin.svelte";
</script>

<main>
  <img src={featureImage} alt="creating space logo" />
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
