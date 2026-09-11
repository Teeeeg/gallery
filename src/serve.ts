import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "dist",
);
const port = Number(process.env.PORT ?? 4173);

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webp": "image/webp",
  ".json": "application/json",
};

http
  .createServer(async (req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const target = path.join(
      dist,
      url.endsWith("/") ? `${url}index.html` : url,
    );

    if (!target.startsWith(dist)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    try {
      const info = await stat(target);
      if (info.isDirectory()) throw new Error("directory");
      res.writeHead(200, {
        "content-type":
          types[path.extname(target)] ?? "application/octet-stream",
      });
      createReadStream(target).pipe(res);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    }
  })
  .listen(port, () => console.log(`  preview  http://localhost:${port}`));
