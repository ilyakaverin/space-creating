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
  color: var(--light)
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
