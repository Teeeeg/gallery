import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import exifReader from 'exif-reader';
import sharp from 'sharp';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const photoDir = path.join(root, 'photo');
const outDir = path.join(root, 'dist');
const mediaDir = path.join(outDir, 'media');
const cacheFile = path.join(root, '.cache', 'photos.json');

const SOURCE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif']);
const GRID_WIDTHS = [640, 1280];
const FULL_WIDTHS = [1600, 2560];
const WEBP = { quality: 80, effort: 5 };

const site = JSON.parse(await readFile(path.join(root, 'site.config.json'), 'utf8'));

/** Every media filename this build expects to exist; anything else is pruned. */
const rendered = new Set();

/** @returns {Promise<Array<{year: string, file: string, abs: string}>>} */
async function collectSources() {
  const out = [];
  const years = (await readdir(photoDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();

  for (const year of years) {
    const dir = path.join(photoDir, year);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      out.push({ year, file: entry.name, abs: path.join(dir, entry.name) });
    }
  }
  return out;
}

async function loadCache() {
  try {
    return JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {
    return {};
  }
}

function slugify(year, file) {
  const base = path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const hash = createHash('sha1').update(`${year}/${file}`).digest('hex').slice(0, 6);
  return `${base.replace(/^-|-$/g, '') || 'photo'}-${hash}`;
}

function readExif(buffer) {
  if (!buffer) return {};
  try {
    const tags = exifReader(buffer);
    const image = tags.Image ?? {};
    const photo = tags.Photo ?? {};
    const taken = photo.DateTimeOriginal ?? photo.CreateDate ?? image.DateTime;
    return {
      taken: taken instanceof Date && !Number.isNaN(taken.valueOf()) ? taken.toISOString() : null,
      camera: [image.Make, image.Model].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || null,
      lens: photo.LensModel?.trim() || null,
      focal: photo.FocalLength ? `${Math.round(photo.FocalLength)}mm` : null,
      aperture: photo.FNumber ? `\u0192/${Number(photo.FNumber.toFixed(1))}` : null,
      shutter: formatShutter(photo.ExposureTime),
      iso: Array.isArray(photo.ISOSpeedRatings) ? photo.ISOSpeedRatings[0] : photo.ISOSpeedRatings ?? null
    };
  } catch {
    return {};
  }
}

function formatShutter(seconds) {
  if (!seconds) return null;
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}s`;
  return `1/${Math.round(1 / seconds)}s`;
}

async function renderVariants(image, slug, width) {
  const targets = [...GRID_WIDTHS, ...FULL_WIDTHS].filter((w) => w < width);
  if (width < Math.max(...GRID_WIDTHS, ...FULL_WIDTHS)) targets.push(width);
  const widths = [...new Set(targets)].sort((a, b) => a - b);

  for (const w of widths) {
    const dest = path.join(mediaDir, `${slug}-${w}.webp`);
    rendered.add(path.basename(dest));
    try {
      await stat(dest);
      continue;
    } catch {
      /* not rendered yet */
    }
    await image.clone().resize({ width: w, withoutEnlargement: true }).webp(WEBP).toFile(dest);
  }
  return widths;
}

function pickWidths(available, wanted) {
  const picked = wanted.filter((w) => available.includes(w));
  return picked.length ? picked : [available.at(-1)];
}

async function buildPhoto(source, cache) {
  const info = await stat(source.abs);
  const key = `${source.year}/${source.file}`;
  const stamp = `${info.mtimeMs}:${info.size}`;
  const slug = slugify(source.year, source.file);
  const cached = cache[key];

  if (cached?.stamp === stamp) {
    const widths = await renderVariants(sharp(source.abs).rotate(), slug, cached.width);
    return { ...cached.photo, widths };
  }

  const image = sharp(source.abs).rotate();
  const meta = await image.metadata();
  const rotated = meta.orientation && meta.orientation >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;

  const placeholder = await image
    .clone()
    .resize({ width: 20 })
    .blur(1)
    .webp({ quality: 30, alphaQuality: 1 })
    .toBuffer();

  const widths = await renderVariants(image, slug, width);

  const photo = {
    key,
    slug,
    year: source.year,
    width,
    height,
    caption: site.captions?.[key] ?? '',
    placeholder: `data:image/webp;base64,${placeholder.toString('base64')}`,
    ...readExif(meta.exif),
    mtime: info.mtime.toISOString()
  };

  cache[key] = { stamp, width, height, photo };
  return { ...photo, widths };
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const srcset = (photo, widths) =>
  widths.map((w) => `media/${photo.slug}-${w}.webp ${w}w`).join(', ');

function exifLine(photo) {
  return [photo.camera, photo.lens, photo.focal, photo.aperture, photo.shutter, photo.iso && `ISO ${photo.iso}`]
    .filter(Boolean)
    .join('  \u00b7  ');
}

function displayDate(photo) {
  const iso = photo.taken ?? photo.mtime;
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(site.lang || 'en', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function figureHtml(photo, index) {
  const gridWidths = pickWidths(photo.widths, GRID_WIDTHS);
  return `        <figure class="tile" data-index="${index}" style="--ratio:${photo.width} / ${photo.height}">
          <button class="tile__button" type="button" aria-label="Open photo ${index + 1}">
            <img
              class="tile__image"
              src="media/${photo.slug}-${gridWidths[0]}.webp"
              srcset="${srcset(photo, gridWidths)}"
              sizes="(max-width: 700px) 92vw, (max-width: 1180px) 44vw, 30vw"
              width="${photo.width}"
              height="${photo.height}"
              loading="lazy"
              decoding="async"
              alt="${escapeHtml(photo.caption || `Photograph ${index + 1}`)}"
              style="background-image:url(${photo.placeholder})" />
          </button>
        </figure>`;
}

function renderHtml(groups, photos) {
  const total = photos.length;
  const lightboxData = photos.map((photo) => ({
    slug: photo.slug,
    src: `media/${photo.slug}-${pickWidths(photo.widths, FULL_WIDTHS)[0]}.webp`,
    srcset: srcset(photo, pickWidths(photo.widths, FULL_WIDTHS)),
    width: photo.width,
    height: photo.height,
    caption: photo.caption,
    date: displayDate(photo),
    exif: exifLine(photo)
  }));

  const sections = groups
    .map(
      ([year, items]) => `      <section class="chapter" id="year-${escapeHtml(year)}">
        <header class="chapter__header">
          <h2 class="chapter__title">${escapeHtml(site.yearTitles?.[year] ?? year)}</h2>
          <p class="chapter__meta">${items.length} ${items.length === 1 ? 'photograph' : 'photographs'}</p>
        </header>
        <div class="grid">
${items.map((photo) => figureHtml(photo, photo.index)).join('\n')}
        </div>
      </section>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="${escapeHtml(site.lang || 'en')}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(site.title)}</title>
  <meta name="description" content="${escapeHtml(site.description)}" />
  <meta name="color-scheme" content="light" />
  <meta property="og:title" content="${escapeHtml(site.title)}" />
  <meta property="og:description" content="${escapeHtml(site.description)}" />
  <meta property="og:type" content="website" />
  <link rel="stylesheet" href="assets/style.css" />
</head>
<body>
  <a class="skip" href="#book">Skip to photographs</a>

  <header class="masthead">
    <h1 class="masthead__title">${escapeHtml(site.title)}</h1>
    ${site.subtitle ? `<p class="masthead__subtitle">${escapeHtml(site.subtitle)}</p>` : ''}
    <p class="masthead__count">${total} ${total === 1 ? 'photograph' : 'photographs'}</p>
  </header>

  <main id="book" class="book">
${sections}
  </main>

  <footer class="colophon">
    <p>${escapeHtml(site.author ? `\u00a9 ${new Date().getFullYear()} ${site.author}` : `\u00a9 ${new Date().getFullYear()}`)}</p>
  </footer>

  <dialog class="lightbox" id="lightbox" aria-label="Photo viewer">
    <button class="lightbox__close" type="button" data-action="close" aria-label="Close">&#215;</button>
    <button class="lightbox__nav lightbox__nav--prev" type="button" data-action="prev" aria-label="Previous photo">&#8249;</button>
    <button class="lightbox__nav lightbox__nav--next" type="button" data-action="next" aria-label="Next photo">&#8250;</button>
    <figure class="lightbox__figure">
      <img class="lightbox__image" alt="" />
      <figcaption class="lightbox__caption">
        <span class="lightbox__text"></span>
        <span class="lightbox__exif"></span>
        <span class="lightbox__counter"></span>
      </figcaption>
    </figure>
  </dialog>

  <script type="application/json" id="photo-data">${JSON.stringify(lightboxData).replace(/</g, '\\u003c')}</script>
  <script src="assets/app.js" defer></script>
</body>
</html>
`;
}

async function main() {
  const started = Date.now();
  await rm(path.join(outDir, 'assets'), { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(path.join(outDir, 'assets'), { recursive: true });
  await mkdir(path.dirname(cacheFile), { recursive: true });

  const sources = await collectSources();
  if (sources.length === 0) {
    throw new Error(`No images found under ${path.relative(root, photoDir)}/<year>/`);
  }

  const cache = await loadCache();
  const photos = [];
  for (const source of sources) {
    photos.push(await buildPhoto(source, cache));
    process.stdout.write(`\r  processed ${photos.length}/${sources.length}`);
  }
  process.stdout.write('\n');

  photos.sort((a, b) => {
    if (a.year !== b.year) return b.year.localeCompare(a.year);
    return (b.taken ?? b.mtime).localeCompare(a.taken ?? a.mtime);
  });
  photos.forEach((photo, index) => {
    photo.index = index;
  });

  const groups = [];
  for (const photo of photos) {
    const last = groups.at(-1);
    if (last && last[0] === photo.year) last[1].push(photo);
    else groups.push([photo.year, [photo]]);
  }

  await writeFile(path.join(outDir, 'index.html'), renderHtml(groups, photos));
  for (const asset of ['style.css', 'app.js']) {
    await writeFile(
      path.join(outDir, 'assets', asset),
      await readFile(path.join(root, 'src', 'assets', asset))
    );
  }
  await writeFile(path.join(outDir, '.nojekyll'), '');
  await writeFile(cacheFile, JSON.stringify(cache));

  for (const stale of await readdir(mediaDir)) {
    if (!rendered.has(stale)) await rm(path.join(mediaDir, stale), { force: true });
  }

  console.log(
    `  ${photos.length} photographs \u2192 ${path.relative(root, outDir)} in ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
}

await main();
