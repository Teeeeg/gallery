const photos = JSON.parse(document.getElementById('photo-data').textContent);
const dialog = document.getElementById('lightbox');
const image = dialog.querySelector('.lightbox__image');
const text = dialog.querySelector('.lightbox__text');
const exif = dialog.querySelector('.lightbox__exif');
const counter = dialog.querySelector('.lightbox__counter');

let current = 0;

function show(index) {
  current = (index + photos.length) % photos.length;
  const photo = photos[current];

  image.classList.remove('is-ready');
  image.removeAttribute('srcset');
  image.src = photo.src;
  image.srcset = photo.srcset;
  image.sizes = '100vw';
  image.width = photo.width;
  image.height = photo.height;
  image.alt = photo.caption || `Photograph ${current + 1}`;

  text.textContent = photo.caption;
  exif.textContent = photo.exif;
  counter.textContent = [photo.date, `${current + 1} / ${photos.length}`].filter(Boolean).join('  ·  ');

  if (image.complete) image.classList.add('is-ready');
  preload(current + 1);
  preload(current - 1);
}

function preload(index) {
  const photo = photos[(index + photos.length) % photos.length];
  const img = new Image();
  img.srcset = photo.srcset;
  img.sizes = '100vw';
  img.src = photo.src;
}

function open(index) {
  show(index);
  if (!dialog.open) dialog.showModal();
  document.body.style.overflow = 'hidden';
}

image.addEventListener('load', () => image.classList.add('is-ready'));

dialog.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'prev') show(current - 1);
  else if (action === 'next') show(current + 1);
  else if (action === 'close') dialog.close();
  else if (event.target === dialog || event.target.closest('.lightbox__figure')) dialog.close();
});

dialog.addEventListener('close', () => {
  document.body.style.overflow = '';
  document.querySelector(`.tile[data-index="${current}"] .tile__button`)?.focus();
});

dialog.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    show(current + 1);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    show(current - 1);
  }
});

let touchX = null;
dialog.addEventListener('touchstart', (event) => {
  touchX = event.changedTouches[0].clientX;
}, { passive: true });

dialog.addEventListener('touchend', (event) => {
  if (touchX === null) return;
  const delta = event.changedTouches[0].clientX - touchX;
  if (Math.abs(delta) > 60) show(current + (delta < 0 ? 1 : -1));
  touchX = null;
}, { passive: true });

const tiles = [...document.querySelectorAll('.tile')];

for (const tile of tiles) {
  tile.querySelector('.tile__button').addEventListener('click', () => {
    open(Number(tile.dataset.index));
  });
}

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px' }
  );
  for (const tile of tiles) observer.observe(tile);
} else {
  for (const tile of tiles) tile.classList.add('is-visible');
}
