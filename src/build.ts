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
  topicNotes?: Record<string, string>;
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

/** One topic: its folder name, the url segment it is published under, and its photographs. */
interface Group {
  topic: string;
  id: string;
  items: SizedPhoto[];
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

const PHOTOSWIPE_ASSETS: Array<[string, string]> = [
  ["photoswipe.esm.min.js", "photoswipe.esm.js"],
  ["photoswipe-lightbox.esm.min.js", "photoswipe-lightbox.esm.js"],
  ["photoswipe.css", "photoswipe.css"],
];

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

const srcset = (photo: SizedPhoto, widths: number[], prefix: string): string =>
  widths.map((w) => `${prefix}media/${photo.slug}-${w}.webp ${w}w`).join(", ");

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

function figureHtml(
  photo: SizedPhoto,
  position: number,
  prefix: string,
): string {
  const gridWidths = pickWidths(photo.widths, GRID_WIDTHS);
  const fullWidths = pickWidths(photo.widths, FULL_WIDTHS);
  const fullWidth = fullWidths[fullWidths.length - 1];
  const fullHeight = Math.round((photo.height * fullWidth) / photo.width);
  return `        <figure class="tile" style="--ratio:${photo.width} / ${photo.height}">
          <a
            class="tile__link"
            href="${prefix}media/${photo.slug}-${fullWidth}.webp"
            data-pswp-width="${fullWidth}"
            data-pswp-height="${fullHeight}"
            data-pswp-srcset="${srcset(photo, fullWidths, prefix)}"
            data-caption="${escapeHtml(photo.caption)}"
            data-date="${escapeHtml(displayDate(photo))}"
            data-exif="${escapeHtml(exifLine(photo))}"
            target="_blank"
            rel="noreferrer"
            aria-label="Open photograph ${position + 1}">
            <img
              class="tile__image"
              src="${prefix}media/${photo.slug}-${gridWidths[0]}.webp"
              srcset="${srcset(photo, gridWidths, prefix)}"
              sizes="(max-width: 700px) 92vw, (max-width: 1180px) 44vw, 30vw"
              width="${photo.width}"
              height="${photo.height}"
              loading="lazy"
              decoding="async"
              alt="${escapeHtml(photo.caption || `Photograph ${position + 1}`)}"
              style="background-image:url(${photo.placeholder})" />
          </a>
        </figure>`;
}

/** Month, or span of months, the photographs of a topic were taken in. */
function topicRange(items: SizedPhoto[]): string {
  const dates = items
    .map((photo) => photo.taken ?? photo.mtime)
    .filter(Boolean)
    .sort();
  if (dates.length === 0) return "";
  const label = (iso: string): string =>
    new Date(iso).toLocaleDateString(site.lang || "en", {
      year: "numeric",
      month: "long",
    });
  const first = label(dates[0]);
  const last = label(dates[dates.length - 1]);
  return first === last ? first : `${first} \u2013 ${last}`;
}

const photographs = (n: number): string =>
  `${n} ${n === 1 ? "photograph" : "photographs"}`;

function chaptersMenu(
  groups: Group[],
  prefix: string,
  active: string | null,
): string {
  const items = groups.map(({ topic, id, items: photos }) => {
    const cover = photos[0];
    const thumb = pickWidths(cover.widths, GRID_WIDTHS)[0];
    return `        <li>
          <a class="chapters__item" href="${prefix}${id}/"${active === topic ? ' aria-current="page"' : ""}>
            <img class="chapters__thumb" src="${prefix}media/${cover.slug}-${thumb}.webp" alt="" width="56" height="56" loading="lazy" decoding="async" />
            <span>
              <span class="chapters__name">${escapeHtml(topicTitle(topic))}</span>
              <span class="chapters__count">${photographs(photos.length)}</span>
            </span>
          </a>
        </li>`;
  });

  return `  <nav class="chapters" aria-label="Chapters">
    <details class="chapters__menu">
      <summary class="chapters__summary">Chapters</summary>
      <ul class="chapters__list">
        <li>
          <a class="chapters__all" href="${prefix || "./"}"${active === null ? ' aria-current="page"' : ""}>All chapters</a>
        </li>
${items.join("\n")}
      </ul>
    </details>
  </nav>`;
}

function documentHtml(options: {
  prefix: string;
  title: string;
  description: string;
  body: string;
}): string {
  const { prefix, title, description, body } = options;
  const base = prefix || "./";
  return `<!DOCTYPE html>
<html lang="${escapeHtml(site.lang || "en")}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="color-scheme" content="light" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  <link rel="stylesheet" href="${prefix}assets/photoswipe.css" />
  <link rel="stylesheet" href="${prefix}assets/style.css" />
  <script type="importmap">
    {
      "imports": {
        "photoswipe": "${base}assets/photoswipe.esm.js",
        "photoswipe/lightbox": "${base}assets/photoswipe-lightbox.esm.js"
      }
    }
  </script>
</head>
<body>
  <a class="skip" href="#book">Skip to photographs</a>

${body}

  <script type="module" src="${prefix}assets/app.js"></script>
</body>
</html>
`;
}

function entryHtml(group: Group): string {
  const { topic, id, items } = group;
  const cover = items[0];
  const coverWidths = pickWidths(cover.widths, GRID_WIDTHS);
  const note = site.topicNotes?.[topic];
  return `      <article class="entry">
        <a class="entry__link" href="${id}/">
          <div class="entry__cover" style="--ratio:${cover.width} / ${cover.height}">
            <img
              src="media/${cover.slug}-${coverWidths[0]}.webp"
              srcset="${srcset(cover, coverWidths, "")}"
              sizes="(max-width: 700px) 92vw, 44vw"
              width="${cover.width}"
              height="${cover.height}"
              loading="lazy"
              decoding="async"
              alt=""
              style="background-image:url(${cover.placeholder})" />
          </div>
          <div class="entry__body">
            <h2 class="entry__title">${escapeHtml(topicTitle(topic))}</h2>
            <p class="entry__meta">${[photographs(items.length), topicRange(items)].filter(Boolean).join("  \u00b7  ")}</p>
            ${note ? `<p class="entry__note">${escapeHtml(note)}</p>` : ""}
          </div>
        </a>
      </article>`;
}

function homeHtml(groups: Group[], total: number): string {
  const body = `${chaptersMenu(groups, "", null)}

  <header class="masthead">
    <h1 class="masthead__title">${escapeHtml(site.title)}</h1>
    ${site.subtitle ? `<p class="masthead__subtitle">${escapeHtml(site.subtitle)}</p>` : ""}
    <p class="masthead__count">${groups.length} ${groups.length === 1 ? "chapter" : "chapters"}  \u00b7  ${photographs(total)}</p>
  </header>

  <main id="book" class="entries">
${groups.map((group) => entryHtml(group)).join("\n")}
  </main>`;

  return documentHtml({
    prefix: "",
    title: site.title,
    description: site.description,
    body,
  });
}

function topicPageHtml(group: Group, groups: Group[]): string {
  const { topic, items } = group;
  const title = topicTitle(topic);
  const note = site.topicNotes?.[topic];
  const body = `  <a class="back" href="../">
    <span class="back__arrow" aria-hidden="true">\u2190</span>${escapeHtml(site.title)}
  </a>

${chaptersMenu(groups, "../", topic)}

  <header class="masthead masthead--topic">
    <h1 class="masthead__title">${escapeHtml(title)}</h1>
    ${note ? `<p class="masthead__subtitle">${escapeHtml(note)}</p>` : ""}
    <p class="masthead__count">${[photographs(items.length), topicRange(items)].filter(Boolean).join("  \u00b7  ")}</p>
  </header>

  <main id="book" class="book">
    <div class="grid">
${items.map((photo, position) => figureHtml(photo, position, "../")).join("\n")}
    </div>
  </main>`;

  return documentHtml({
    prefix: "../",
    title: `${title} \u00b7 ${site.title}`,
    description: note ?? site.description,
    body,
  });
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
  const photos: SizedPhoto[] = [];
  for (const source of sources) {
    photos.push(await buildPhoto(source, cache));
    process.stdout.write(`\r  processed ${photos.length}/${sources.length}`);
  }
  process.stdout.write("\n");

  photos.sort((a, b) => {
    if (a.topic !== b.topic) return b.topic.localeCompare(a.topic);
    return (b.taken ?? b.mtime).localeCompare(a.taken ?? a.mtime);
  });

  const groups: Group[] = [];
  for (const photo of photos) {
    const last = groups.at(-1);
    if (last && last.topic === photo.topic) last.items.push(photo);
    else
      groups.push({
        topic: photo.topic,
        id: topicId(photo.topic),
        items: [photo],
      });
  }

  await writeFile(
    path.join(outDir, "index.html"),
    homeHtml(groups, photos.length),
  );
  for (const group of groups) {
    await mkdir(path.join(outDir, group.id), { recursive: true });
    await writeFile(
      path.join(outDir, group.id, "index.html"),
      topicPageHtml(group, groups),
    );
  }

  await writeFile(
    path.join(outDir, "assets", "style.css"),
    await readFile(path.join(root, "src", "assets", "style.css")),
  );
  await writeFile(
    path.join(outDir, "assets", "app.js"),
    await readFile(path.join(compiledAssetDir, "app.js")),
  );
  for (const [source, dest] of PHOTOSWIPE_ASSETS) {
    await writeFile(
      path.join(outDir, "assets", dest),
      await readFile(
        path.join(root, "node_modules", "photoswipe", "dist", source),
      ),
    );
  }
  await writeFile(path.join(outDir, ".nojekyll"), "");
  await writeFile(cacheFile, JSON.stringify(cache));

  for (const stale of await readdir(mediaDir)) {
    if (!rendered.has(stale))
      await rm(path.join(mediaDir, stale), { force: true });
  }

  const keep = new Set(["assets", "media", ...groups.map((g) => g.id)]);
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !keep.has(entry.name)) {
      await rm(path.join(outDir, entry.name), { recursive: true, force: true });
    }
  }

  console.log(
    `  ${photos.length} photographs in ${groups.length} ${groups.length === 1 ? "chapter" : "chapters"} \u2192 ${path.relative(root, outDir)} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

await main();
