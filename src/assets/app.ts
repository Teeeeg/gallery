import PhotoSwipeLightbox from "photoswipe/lightbox";

const lightbox = new PhotoSwipeLightbox({
  gallery: ".grid",
  children: "a.tile__link",
  pswpModule: () => import("photoswipe"),
  bgOpacity: 1,
  wheelToZoom: true,
  padding: { top: 32, bottom: 104, left: 24, right: 24 },
});

lightbox.on("uiRegister", () => {
  lightbox.pswp?.ui?.registerElement({
    name: "caption",
    order: 9,
    isButton: false,
    appendTo: "root",
    onInit: (el, pswp) => {
      el.className = "pswp__caption";
      const parts = ["text", "exif", "meta"].map((name) => {
        const span = document.createElement("span");
        span.className = `pswp__caption-${name}`;
        el.append(span);
        return span;
      });

      pswp.on("change", () => {
        const anchor = pswp.currSlide?.data.element;
        const [text, exif, meta] = parts;
        text.textContent = anchor?.dataset.caption ?? "";
        exif.textContent = anchor?.dataset.exif ?? "";
        meta.textContent = anchor?.dataset.date ?? "";
      });
    },
  });
});

lightbox.init();

const chapters = document.querySelector<HTMLDetailsElement>(".chapters__menu");

if (chapters) {
  document.addEventListener("click", (event) => {
    if (chapters.open && !chapters.contains(event.target as Node)) {
      chapters.open = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") chapters.open = false;
  });
}

const revealed = [...document.querySelectorAll<HTMLElement>(".tile, .entry")];

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const element of revealed) observer.observe(element);
} else {
  for (const element of revealed) element.classList.add("is-visible");
}
