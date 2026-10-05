import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Send one file, or false if it does not exist. */
export function sendFile(res: http.ServerResponse, file: string, cache = 'no-store'): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': st.size, 'Cache-Control': cache });
    fs.createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a URL path inside a root folder; null when it would escape the root. */
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]!.split('#')[0]!);
  } catch {
    return null;
  }
  const full = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

/** A plain static file server for one folder, on its own port. */
export function serveStatic(root: string, port: number, host = '127.0.0.1'): Promise<http.Server> {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    const file = safeJoin(base, req.url ?? '/');
    if (!file) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let target = file;
    try {
      if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    } catch {
      /* handled below */
    }
    if (sendFile(res, target)) return;
    // A folder with exactly one HTML file and no index.html: serve that file at "/".
    if (file === base) {
      const html = fs.readdirSync(base).filter((f) => f.toLowerCase().endsWith('.html'));
      if (html.length >= 1 && sendFile(res, path.join(base, html[0]!))) return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
