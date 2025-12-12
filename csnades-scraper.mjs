#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const DEFAULT_BASE_URL = "https://csnades.gg";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = value;
      i++;
    }
  }
  return args;
}

function usageAndExit(code = 1) {
  console.error(
    [
      "Usage:",
      "  node csnades-scraper.mjs --map mirage [--out mirage.cfg] [--base https://csnades.gg] [--limit 6]",
      "",
      "Outputs a .cfg/.txt with commands like:",
      "  setpos ...;setang ...",
    ].join("\n"),
  );
  process.exit(code);
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "csnades-scraper/1.0 (+personal-use)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return await res.text();
}

function decodeJsEscapedString(maybeEscaped) {
  // Value is taken from a JS-escaped string in HTML, e.g.:
  //   setpos ...;setang ...\n...
  // It may contain \" or \\n. JSON.parse is the easiest safe unescaper.
  const safe = maybeEscaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return JSON.parse(`"${safe}"`);
}

function typeToPath(type) {
  switch (type) {
    case "smoke":
      return "smokes";
    case "molotov":
      return "molotovs";
    case "flashbang":
      return "flashbangs";
    case "he":
      return "hes";
    default:
      return null;
  }
}

function extractNadesFromMapHtml(html) {
  // The HTML contains many JSON-like objects with escaped quotes, e.g.
  //   \"id\":\"nade_...\",\"slug\":\"...\", ... ,\"type\":\"smoke\", ...
  // We find each nade chunk by its unique id prefix: \"id\":\"nade_
  const idNeedle = '\\"id\\":\\"nade_';
  const starts = [];
  let idx = 0;
  while (true) {
    const found = html.indexOf(idNeedle, idx);
    if (found === -1) break;
    starts.push(found);
    idx = found + idNeedle.length;
  }

  const nades = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : html.length;
    const chunk = html.slice(start, end);

    const idMatch = chunk.match(/\\"id\\":\\"(nade_[^\\"]+)\\"/);
    const slugMatch = chunk.match(/\\"id\\":\\"nade_[^\\"]+\\",\\"slug\\":\\"([^\\"]+)\\"/);
    const typeMatch = chunk.match(/\\"type\\":\\"(smoke|molotov|flashbang|he)\\"/);
    if (!idMatch || !slugMatch || !typeMatch) continue;

    const teamMatch = chunk.match(/\\"team\\":\\"(ct|t)\\"/);
    const titleFromMatch = chunk.match(/\\"titleFrom\\":\\"([^\\"]+)\\"/);
    const titleToMatch = chunk.match(/\\"titleTo\\":\\"([^\\"]+)\\"/);

    nades.push({
      id: idMatch[1],
      slug: slugMatch[1],
      type: typeMatch[1],
      team: teamMatch?.[1] ?? null,
      titleFrom: titleFromMatch?.[1] ?? null,
      titleTo: titleToMatch?.[1] ?? null,
    });
  }

  // Deduplicate by (type, slug) (ids can vary across environments)
  const seen = new Set();
  return nades.filter((nade) => {
    const key = `${nade.type}:${nade.slug}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractConsoleFromNadeHtml(html) {
  const m = html.match(/\\"console\\":\\"(.*?)\\"/s);
  if (!m) return null;
  return decodeJsEscapedString(m[1]);
}

function pLimit(limit) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= limit) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    job()
      .catch(() => {})
      .finally(() => {
        active--;
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push(async () => {
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      });
      next();
    });
}

function sanitizeComment(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mapSlug = args.map ?? args._[0];
  if (!mapSlug || typeof mapSlug !== "string") usageAndExit(1);

  const baseUrl = (args.base ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const outPath = args.out ?? `${mapSlug}.cfg`;
  const limit = Math.max(1, Number.parseInt(args.limit ?? "6", 10) || 6);
  const max = args.max ? Math.max(1, Number.parseInt(args.max, 10) || 1) : null;

  const mapUrl = `${baseUrl}/${encodeURIComponent(mapSlug)}`;
  console.log(`Fetching map page: ${mapUrl}`);
  const mapHtml = await fetchText(mapUrl);
  const allNades = extractNadesFromMapHtml(mapHtml);
  const nades = max ? allNades.slice(0, max) : allNades;

  if (!nades.length) {
    throw new Error(
      `Could not find any nades on ${mapUrl}. The site layout may have changed.`,
    );
  }

  console.log(`Found nades: ${nades.length}${max ? ` (max=${max})` : ""}`);

  const limiter = pLimit(limit);
  let done = 0;

  const results = await Promise.all(
    nades.map((nade) =>
      limiter(async () => {
        const typePath = typeToPath(nade.type);
        if (!typePath) return { nade, console: null, error: `Unknown type: ${nade.type}` };

        const nadeUrl = `${baseUrl}/${encodeURIComponent(mapSlug)}/${typePath}/${encodeURIComponent(nade.slug)}`;
        const html = await fetchText(nadeUrl);
        const consoleText = extractConsoleFromNadeHtml(html);
        done++;
        if (done % 10 === 0 || done === nades.length) {
          console.log(`Progress: ${done}/${nades.length}`);
        }
        return { nade, console: consoleText, error: null, url: nadeUrl };
      }),
    ),
  );

  const lines = [];
  lines.push(`// Generated from ${baseUrl}/${mapSlug}`);
  lines.push(`// Total nades: ${results.length}`);
  lines.push("");

  let missing = 0;
  for (const r of results) {
    const titleFrom = sanitizeComment(r.nade.titleFrom);
    const titleTo = sanitizeComment(r.nade.titleTo);
    const team = r.nade.team ? r.nade.team.toUpperCase() : "ANY";
    const label = [r.nade.type, team, titleFrom && titleTo ? `${titleFrom} -> ${titleTo}` : r.nade.slug]
      .filter(Boolean)
      .join(" | ");

    lines.push(`// ${label}`);
    if (r.url) lines.push(`// ${r.url}`);

    if (!r.console) {
      missing++;
      lines.push(`// MISSING_CONSOLE`);
      lines.push("");
      continue;
    }

    // Keep only setpos/setang pairs if extra commands exist.
    const match = r.console.match(/setpos [^;\\r\\n]+;setang [^\\r\\n]+/i);
    lines.push(match ? match[0] : r.console.trim());
    lines.push("");
  }

  await writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote: ${outPath}`);
  if (missing) console.log(`Missing console: ${missing}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
