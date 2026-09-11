import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import exifReader from "exif-reader";
import sharp, { type Sharp } from "sharp";

interface SiteConfig {
  title: string;
  subtitle?: string;
  author?: string;
  description: string;
  lang?: string;
  topicTitles?: Record<string, string>;
  captions?: Record<string, string>;
}

interface Source {
  topic: string;
  file: string;
  abs: string;
}

interface ExifInfo {
  taken?: string | null;
  camera?: string | null;
  lens?: string | null;
  focal?: string | null;
  aperture?: string | null;
  shutter?: string | null;
  iso?: number | null;
}

interface Photo extends ExifInfo {
  key: string;
  slug: string;
  topic: string;
  width: number;
  height: number;
  caption: string;
  placeholder: string;
  mtime: string;
}

interface SizedPhoto extends Photo {
  widths: number[];
}

interface IndexedPhoto extends SizedPhoto {
  index: number;
}

interface CacheEntry {
  stamp: string;
  width: number;
  height: number;
  photo: Photo;
}

type Cache = Record<string, CacheEntry>;

/** Raw EXIF tag bags; values are only as trustworthy as the camera that wrote them. */
type TagBag = Record<string, unknown>;

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const photoDir = path.join(root, "photo");
const outDir = path.join(root, "dist");
const mediaDir = path.join(outDir, "media");
const compiledAssetDir = path.join(root, ".compiled", "assets");
const cacheFile = path.join(root, ".cache", "photos.json");

const SOURCE_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".tif",
  ".tiff",
  ".avif",
]);
const GRID_WIDTHS = [640, 1280];
const FULL_WIDTHS = [1600, 2560];
const WEBP = { quality: 80, effort: 5 } as const;

/** Bump to invalidate cached metadata when the EXIF formatting changes. */
const EXIF_VERSION = 3;

const site = JSON.parse(
  await readFile(path.join(root, "site.config.json"), "utf8"),
) as SiteConfig;

/** Every media filename this build expects to exist; anything else is pruned. */
const rendered = new Set<string>();

async function collectSources(): Promise<Source[]> {
  const out: Source[] = [];
  const topics = (await readdir(photoDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();

  for (const topic of topics) {
    const dir = path.join(photoDir, topic);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      out.push({ topic, file: entry.name, abs: path.join(dir, entry.name) });
    }
  }
  return out;
}

async function loadCache(): Promise<Cache> {
  try {
    return JSON.parse(await readFile(cacheFile, "utf8")) as Cache;
  } catch {
    return {};
  }
}

function slugify(topic: string, file: string): string {
  const base = path
    .basename(file, path.extname(file))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const hash = createHash("sha1")
    .update(`${topic}/${file}`)
    .digest("hex")
    .slice(0, 6);
  return `${base.replace(/^-|-$/g, "") || "photo"}-${hash}`;
}

const topicId = (topic: string): string =>
  topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "topic";

const topicTitle = (topic: string): string =>
  site.topicTitles?.[topic] ?? topic;

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const asDate = (value: unknown): Date | null =>
  value instanceof Date && !Number.isNaN(value.valueOf()) ? value : null;

/** Makers often repeat the brand in the model ("NIKON" + "NIKON D850"); keep only the model. */
function stripBrand(value: string | null, make: string | null): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const brand = make?.replace(/\s+/g, " ").trim().split(" ")[0];
  if (brand && cleaned.toLowerCase().startsWith(`${brand.toLowerCase()} `)) {
    return cleaned.slice(brand.length).trim() || null;
  }
  return cleaned;
}

function readExif(buffer?: Buffer): ExifInfo {
  if (!buffer) return {};
  try {
    const tags = exifReader(buffer) as { Image?: TagBag; Photo?: TagBag };
    const image = tags.Image ?? {};
    const photo = tags.Photo ?? {};
    const taken = asDate(
      photo.DateTimeOriginal ?? photo.CreateDate ?? image.DateTime,
    );
    const focal = asNumber(photo.FocalLength);
    const aperture = asNumber(photo.FNumber);
    const iso = Array.isArray(photo.ISOSpeedRatings)
      ? photo.ISOSpeedRatings[0]
      : photo.ISOSpeedRatings;
    const make = asString(image.Make);
    return {
      taken: taken?.toISOString() ?? null,
      camera: stripBrand(asString(image.Model), make),
      lens: stripBrand(asString(photo.LensModel), make),
      focal: focal === null ? null : `${Math.round(focal)}mm`,
      aperture:
        aperture === null ? null : `\u0192/${Number(aperture.toFixed(1))}`,
      shutter: formatShutter(asNumber(photo.ExposureTime)),
      iso: asNumber(iso),
    };
  } catch {
    return {};
  }
}

function formatShutter(seconds: number | null): string | null {
  if (!seconds) return null;
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}s`;
  return `1/${Math.round(1 / seconds)}s`;
}

async function renderVariants(
  image: Sharp,
  slug: string,
  width: number,
): Promise<number[]> {
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
    await image
      .clone()
      .resize({ width: w, withoutEnlargement: true })
      .webp(WEBP)
      .toFile(dest);
  }
  return widths;
}

function pickWidths(available: number[], wanted: number[]): number[] {
  const picked = wanted.filter((w) => available.includes(w));
  return picked.length ? picked : [available[available.length - 1]];
}

async function buildPhoto(source: Source, cache: Cache): Promise<SizedPhoto> {
  const info = await stat(source.abs);
  const key = `${source.topic}/${source.file}`;
  const stamp = `${EXIF_VERSION}:${info.mtimeMs}:${info.size}`;
  const slug = slugify(source.topic, source.file);
  const cached = cache[key];

  if (cached?.stamp === stamp) {
    const widths = await renderVariants(
      sharp(source.abs).rotate(),
      slug,
      cached.width,
    );
    return { ...cached.photo, widths };
  }

  const image = sharp(source.abs).rotate();
  const meta = await image.metadata();
  if (meta.width === undefined || meta.height === undefined) {
    throw new Error(`Unable to read dimensions for ${key}`);
  }
  const rotated = meta.orientation !== undefined && meta.orientation >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;

  const placeholder = await image
    .clone()
    .resize({ width: 20 })
    .blur(1)
    .webp({ quality: 30, alphaQuality: 1 })
    .toBuffer();

  const widths = await renderVariants(image, slug, width);

  const photo: Photo = {
    key,
    slug,
    topic: source.topic,
    width,
    height,
    caption: site.captions?.[key] ?? "",
    placeholder: `data:image/webp;base64,${placeholder.toString("base64")}`,
    ...readExif(meta.exif),
    mtime: info.mtime.toISOString(),
  };

  cache[key] = { stamp, width, height, photo };
  return { ...photo, widths };
}

const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const srcset = (photo: SizedPhoto, widths: number[]): string =>
  widths.map((w) => `media/${photo.slug}-${w}.webp ${w}w`).join(", ");

function exifLine(photo: Photo): string {
  return [
    photo.camera,
    photo.lens,
    photo.focal,
    photo.aperture,
    photo.shutter,
    photo.iso && `ISO ${photo.iso}`,
  ]
    .filter(Boolean)
    .join("  \u00b7  ");
}

function displayDate(photo: Photo): string {
  const iso = photo.taken ?? photo.mtime;
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(site.lang || "en", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function figureHtml(photo: IndexedPhoto): string {
  const index = photo.index;
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

function renderHtml(
  groups: Array<[string, IndexedPhoto[]]>,
  photos: IndexedPhoto[],
): string {
  const total = photos.length;
  const lightboxData = photos.map((photo) => ({
    slug: photo.slug,
    topic: photo.topic,
    src: `media/${photo.slug}-${pickWidths(photo.widths, FULL_WIDTHS)[0]}.webp`,
    srcset: srcset(photo, pickWidths(photo.widths, FULL_WIDTHS)),
    width: photo.width,
    height: photo.height,
    caption: photo.caption,
    date: displayDate(photo),
    exif: exifLine(photo),
  }));

  const topics = [
    `      <button class="topics__button" type="button" data-topic="" aria-pressed="true">All</button>`,
    ...groups.map(
      ([topic]) =>
        `      <button class="topics__button" type="button" data-topic="${escapeHtml(topic)}" aria-pressed="false">${escapeHtml(topicTitle(topic))}</button>`,
    ),
  ].join("\n");

  const sections = groups
    .map(
      ([
        topic,
        items,
      ]) => `      <section class="chapter" id="topic-${topicId(topic)}" data-topic="${escapeHtml(topic)}">
        <header class="chapter__header">
          <h2 class="chapter__title">${escapeHtml(topicTitle(topic))}</h2>
          <p class="chapter__meta">${items.length} ${items.length === 1 ? "photograph" : "photographs"}</p>
        </header>
        <div class="grid">
${items.map((photo) => figureHtml(photo)).join("\n")}
        </div>
      </section>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="${escapeHtml(site.lang || "en")}">
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
    ${site.subtitle ? `<p class="masthead__subtitle">${escapeHtml(site.subtitle)}</p>` : ""}
    <p class="masthead__count">${total} ${total === 1 ? "photograph" : "photographs"}</p>
    <nav class="topics" aria-label="Topics">
${topics}
    </nav>
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

  <script type="application/json" id="photo-data">${JSON.stringify(lightboxData).replace(/</g, "\\u003c")}</script>
  <script src="assets/app.js" defer></script>
</body>
</html>
`;
}

async function main(): Promise<void> {
  const started = Date.now();
  await rm(path.join(outDir, "assets"), { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(path.join(outDir, "assets"), { recursive: true });
  await mkdir(path.dirname(cacheFile), { recursive: true });

  const sources = await collectSources();
  if (sources.length === 0) {
    throw new Error(
      `No images found under ${path.relative(root, photoDir)}/<topic>/`,
    );
  }

  const cache = await loadCache();
  const built: SizedPhoto[] = [];
  for (const source of sources) {
    built.push(await buildPhoto(source, cache));
    process.stdout.write(`\r  processed ${built.length}/${sources.length}`);
  }
  process.stdout.write("\n");

  built.sort((a, b) => {
    if (a.topic !== b.topic) return b.topic.localeCompare(a.topic);
    return (b.taken ?? b.mtime).localeCompare(a.taken ?? a.mtime);
  });
  const photos: IndexedPhoto[] = built.map((photo, index) => ({
    ...photo,
    index,
  }));

  const groups: Array<[string, IndexedPhoto[]]> = [];
  for (const photo of photos) {
    const last = groups.at(-1);
    if (last && last[0] === photo.topic) last[1].push(photo);
    else groups.push([photo.topic, [photo]]);
  }

  await writeFile(path.join(outDir, "index.html"), renderHtml(groups, photos));
  await writeFile(
    path.join(outDir, "assets", "style.css"),
    await readFile(path.join(root, "src", "assets", "style.css")),
  );
  await writeFile(
    path.join(outDir, "assets", "app.js"),
    await readFile(path.join(compiledAssetDir, "app.js")),
  );
  await writeFile(path.join(outDir, ".nojekyll"), "");
  await writeFile(cacheFile, JSON.stringify(cache));

  for (const stale of await readdir(mediaDir)) {
    if (!rendered.has(stale))
      await rm(path.join(mediaDir, stale), { force: true });
  }

  console.log(
    `  ${photos.length} photographs \u2192 ${path.relative(root, outDir)} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

await main();
