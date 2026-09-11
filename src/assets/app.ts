interface LightboxPhoto {
  slug: string;
  topic: string;
  src: string;
  srcset: string;
  width: number;
  height: number;
  caption: string;
  date: string;
  exif: string;
}

const photos = JSON.parse(
  document.getElementById("photo-data")?.textContent ?? "[]",
) as LightboxPhoto[];

const dialog = document.getElementById("lightbox") as HTMLDialogElement;
const image = dialog.querySelector(".lightbox__image") as HTMLImageElement;
const text = dialog.querySelector(".lightbox__text") as HTMLElement;
const exif = dialog.querySelector(".lightbox__exif") as HTMLElement;
const counter = dialog.querySelector(".lightbox__counter") as HTMLElement;

/** Indices of the photos the current topic exposes; the lightbox walks this list. */
let order = photos.map((_, index) => index);
let cursor = 0;

function show(position: number): void {
  if (order.length === 0) return;
  cursor = (position + order.length) % order.length;
  const photo = photos[order[cursor]];

  image.classList.remove("is-ready");
  image.removeAttribute("srcset");
  image.src = photo.src;
  image.srcset = photo.srcset;
  image.sizes = "100vw";
  image.width = photo.width;
  image.height = photo.height;
  image.alt = photo.caption || `Photograph ${cursor + 1}`;

  text.textContent = photo.caption;
  exif.textContent = photo.exif;
  counter.textContent = [photo.date, `${cursor + 1} / ${order.length}`]
    .filter(Boolean)
    .join("  ·  ");

  if (image.complete) image.classList.add("is-ready");
  preload(cursor + 1);
  preload(cursor - 1);
}

function preload(position: number): void {
  const photo = photos[order[(position + order.length) % order.length]];
  const img = new Image();
  img.srcset = photo.srcset;
  img.sizes = "100vw";
  img.src = photo.src;
}

function openLightbox(index: number): void {
  const position = order.indexOf(index);
  if (position === -1) return;
  show(position);
  if (!dialog.open) dialog.showModal();
  document.body.style.overflow = "hidden";
}

image.addEventListener("load", () => image.classList.add("is-ready"));

dialog.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const action = target?.closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "prev") show(cursor - 1);
  else if (action === "next") show(cursor + 1);
  else if (action === "close") dialog.close();
  else if (event.target === dialog || target?.closest(".lightbox__figure"))
    dialog.close();
});

dialog.addEventListener("close", () => {
  document.body.style.overflow = "";
  document
    .querySelector<HTMLElement>(
      `.tile[data-index="${order[cursor]}"] .tile__button`,
    )
    ?.focus();
});

dialog.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") {
    event.preventDefault();
    show(cursor + 1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    show(cursor - 1);
  }
});

let touchX: number | null = null;
dialog.addEventListener(
  "touchstart",
  (event) => {
    touchX = event.changedTouches[0].clientX;
  },
  { passive: true },
);

dialog.addEventListener(
  "touchend",
  (event) => {
    if (touchX === null) return;
    const delta = event.changedTouches[0].clientX - touchX;
    if (Math.abs(delta) > 60) show(cursor + (delta < 0 ? 1 : -1));
    touchX = null;
  },
  { passive: true },
);

const sections = [...document.querySelectorAll<HTMLElement>(".chapter")];
const filters = [
  ...document.querySelectorAll<HTMLButtonElement>(".topics__button"),
];
const count = document.querySelector<HTMLElement>(".masthead__count");

function setTopic(topic: string): void {
  for (const button of filters) {
    button.setAttribute(
      "aria-pressed",
      String((button.dataset.topic ?? "") === topic),
    );
  }
  for (const section of sections) {
    section.hidden = topic !== "" && section.dataset.topic !== topic;
  }

  order = photos
    .map((_, index) => index)
    .filter((index) => !topic || photos[index].topic === topic);
  cursor = 0;

  if (count) {
    count.textContent = `${order.length} ${order.length === 1 ? "photograph" : "photographs"}`;
  }
}

for (const button of filters) {
  button.addEventListener("click", () => setTopic(button.dataset.topic ?? ""));
}

const tiles = [...document.querySelectorAll<HTMLElement>(".tile")];

for (const tile of tiles) {
  tile.querySelector(".tile__button")?.addEventListener("click", () => {
    openLightbox(Number(tile.dataset.index));
  });
}

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
  for (const tile of tiles) observer.observe(tile);
} else {
  for (const tile of tiles) tile.classList.add("is-visible");
}
