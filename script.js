// Copy contract address to clipboard
const copyBtn = document.getElementById("copy-btn");
const caText = document.getElementById("ca-text");

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(caText.textContent.trim());
    copyBtn.textContent = "Copied!";
  } catch {
    copyBtn.textContent = "Failed";
  }
  setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
});

// Scroll reveal animations
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.15 }
);

document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
