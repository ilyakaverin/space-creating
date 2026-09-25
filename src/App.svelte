<script>
import featureImage from "./assets/favicon/favicon-32x32.png";
</script>

<main>
  <h1>creating space</h1>
  <img src={featureImage} alt="creating space logo" />
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

h1 {
  color: var(--light);
  font-size: clamp(1.75rem, 1.25rem + 4vw, 4rem);
  line-height: 1.1;
  margin-block: 0.5em;
  max-width: 20ch;
  text-align: center;
  text-wrap: balance;
  overflow-wrap: break-word;
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
