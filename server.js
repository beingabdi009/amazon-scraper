const express = require("express");
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

const app = express();
const DOWNLOADS_DIR = path.join(__dirname, "downloads");
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(DOWNLOADS_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".mp4") || filePath.endsWith(".ts")) {
      res.setHeader("Content-Type", "video/mp4");
    }
  },
}));

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://www.amazon.in/",
  "Accept": "*/*",
};

// Strip Amazon size token to get original full-res image
function toOriginalRes(url) {
  if (!url || !url.startsWith("http")) return null;
  return url.replace(/\._[A-Za-z0-9,_]+_\./, ".");
}

function isValidImageUrl(url) {
  if (!url || !url.startsWith("http") || url.startsWith("blob:")) return false;
  const u = url.toLowerCase();
  const hasImageExt = u.includes(".jpg") || u.includes(".jpeg") || u.includes(".png") || u.includes(".webp");
  const notTracker = !u.includes("fls-") && !u.includes("uedata") && !u.includes("beacon") && !u.includes("analytics") && !u.includes(".gif");
  return hasImageExt && notTracker;
}

// Fetch a URL and return text body
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// Download a single file to disk, reject if too small
function downloadFile(url, dest, minBytes = 5000) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest, minBytes).then(resolve);
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        if (size < minBytes) { try { fs.unlinkSync(dest); } catch {} return resolve(false); }
        resolve(true);
      });
      file.on("error", () => resolve(false));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(20000, () => { req.destroy(); resolve(false); });
  });
}

// Download HLS stream by fetching all .ts segments and concatenating
async function downloadHLS(m3u8Url, dest) {
  try {
    const text = await fetchText(m3u8Url);
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

    // Master playlist → find highest-bandwidth variant
    if (text.includes("#EXT-X-STREAM-INF")) {
      const lines = text.split("\n");
      let bestBW = 0, bestVariantUrl = null;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("#EXT-X-STREAM-INF")) {
          const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
          const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
          const seg = lines[i + 1]?.trim();
          if (seg && !seg.startsWith("#") && bw > bestBW) {
            bestBW = bw;
            bestVariantUrl = seg.startsWith("http") ? seg : baseUrl + seg;
          }
        }
      }
      if (bestVariantUrl) return downloadHLS(bestVariantUrl, dest);
      return false;
    }

    // Variant playlist → collect segment URLs
    const segments = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => (l.startsWith("http") ? l : baseUrl + l));

    if (!segments.length) return false;

    console.log(`Downloading ${segments.length} HLS segments…`);
    const writeStream = fs.createWriteStream(dest);

    for (const segUrl of segments) {
      await new Promise((resolve, reject) => {
        const lib = segUrl.startsWith("https") ? https : http;
        const req = lib.get(segUrl, { headers: HEADERS }, (res) => {
          res.on("data", (chunk) => writeStream.write(chunk));
          res.on("end", resolve);
          res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error("segment timeout")); });
      });
    }

    await new Promise((resolve) => writeStream.end(resolve));
    const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    console.log(`Video saved: ${(size / 1024 / 1024).toFixed(1)} MB`);
    return size > 100000;
  } catch (err) {
    console.error("HLS download error:", err.message);
    return false;
  }
}

async function scrape(url) {
  const sessionId = Date.now().toString();
  const sessionDir = path.join(DOWNLOADS_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const isAmazon = url.includes("amazon");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: HEADERS["User-Agent"], locale: "en-IN" });

  // Capture m3u8 URLs from network (Amazon uses HLS, not direct mp4)
  const m3u8Urls = [];
  context.on("request", (req) => {
    const u = req.url();
    if (!u.startsWith("blob:") && u.includes(".m3u8")) {
      if (!m3u8Urls.includes(u)) m3u8Urls.push(u);
    }
  });

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(1500);
    // Click video thumbnail to trigger HLS load
    await page.locator("#main-video-thumbnail, .videoBlock img, [class*='video'] img").first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // ── Name ──────────────────────────────────────────────────────────────
    let name = null;
    if (isAmazon) {
      // Read only direct text nodes inside #productTitle — skips hidden
      // keyboard-shortcut <span> children that pollute innerText/textContent
      name = await page.evaluate(() => {
        const el = document.querySelector("#productTitle");
        if (!el) return null;
        return Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent.trim())
          .filter(Boolean)
          .join(" ") || el.querySelector("span")?.textContent?.trim() || null;
      });
    }
    if (!name) name = await page.locator("h1").first().innerText().catch(() => null);
    name = name?.trim() ?? null;

    // ── Price ─────────────────────────────────────────────────────────────
    let price = null;
    if (isAmazon) {
      const whole = await page.locator(".a-price-whole").first().textContent().catch(() => null);
      const frac = await page.locator(".a-price-fraction").first().textContent().catch(() => "00");
      if (whole) price = `₹${whole.replace(/[^\d]/g, "")}.${(frac ?? "00").replace(/[^\d]/g, "")}`;
    }
    if (!price) price = (await page.locator('[class*="price"],[id*="price"]').first().textContent().catch(() => null))?.trim() ?? null;

    // ── Description ──────────────────────────────────────────────────────
    let description = null;
    if (isAmazon) {
      const bullets = await page.locator("#feature-bullets li span").allTextContents().catch(() => []);
      if (bullets.length) description = bullets.map((b) => b.trim()).filter(Boolean).join("\n");
    }
    if (!description) description = (await page.locator('meta[name="description"]').getAttribute("content").catch(() => null))?.trim() ?? null;

    // ── Rating ────────────────────────────────────────────────────────────
    let rating = null;
    if (isAmazon) {
      const rt = await page.locator(".a-icon-alt").first().textContent().catch(() => null);
      rating = rt?.match(/[\d.]+/)?.[0] ?? null;
    }

    // ── Images ─────────────────────────────────────────────────────────────
    let imageUrls = [];

    // 1. colorImages JSON in script tags
    if (isAmazon) {
      imageUrls = await page.evaluate(() => {
        for (const s of document.querySelectorAll("script")) {
          const m = s.textContent && s.textContent.match(/'colorImages'[^}]*'initial':\s*(\[[\s\S]*?\])\s*[,}]/);
          if (m) {
            try { return JSON.parse(m[1]).map((i) => i.hiRes || i.large).filter(Boolean).slice(0, 15); } catch {}
          }
        }
        return [];
      });
    }

    // 2. data-a-dynamic-image on the main product image (has URL→dimensions map)
    if (!imageUrls.length && isAmazon) {
      const dynAttr = await page.locator("#landingImage, #imgBlkFront").first().getAttribute("data-a-dynamic-image").catch(() => null);
      if (dynAttr) {
        try {
          const map = JSON.parse(dynAttr);
          // Sort descending by image width, take highest-res URLs
          imageUrls = Object.entries(map)
            .sort((a, b) => b[1][0] - a[1][0])
            .map(([u]) => u)
            .slice(0, 15);
        } catch {}
      }
    }

    // 3. Alt image strip thumbnails → reconstruct hi-res URL
    if (!imageUrls.length && isAmazon) {
      imageUrls = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#altImages img[src]"))
          .map((img) => img.src)
          .filter((s) => s.includes("media-amazon"))
          .slice(0, 15)
      );
    }

    // 4. Generic CDN fallback
    if (!imageUrls.length) {
      imageUrls = await page.evaluate(() =>
        Array.from(document.querySelectorAll("img[src]"))
          .map((i) => i.src)
          .filter((s) => s.startsWith("https") && (s.includes("media-amazon") || s.includes("ssl-images-amazon")))
          .slice(0, 15)
      );
    }

    // Strip size suffix → original full-res upload, deduplicate
    imageUrls = [...new Set(imageUrls.map(toOriginalRes).filter(isValidImageUrl))];

    // Sanitize product name for use as filename
    const safeName = (name || "product")
      .replace(/[<>:"/\\|?*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 80);

    // Download images
    const images = [];
    for (let i = 0; i < Math.min(imageUrls.length, 12); i++) {
      const filename = `${safeName} ${i + 1}.jpg`;
      const dest = path.join(sessionDir, filename);
      const ok = await downloadFile(imageUrls[i], dest, 8000);
      if (ok) images.push(`/downloads/${sessionId}/${encodeURIComponent(filename)}`);
    }

    // ── Video (HLS) ──────────────────────────────────────────────────────
    // Prefer 720p, fall back to any variant
    let selectedM3u8 = m3u8Urls.find((u) => u.includes("hls720")) ||
                       m3u8Urls.find((u) => u.includes("hls.m3u8") && !u.includes("360")) ||
                       m3u8Urls[0] || null;

    // Also check script tags for m3u8 URLs we may have missed
    if (!selectedM3u8) {
      selectedM3u8 = await page.evaluate(() => {
        for (const s of document.querySelectorAll("script")) {
          const m = (s.textContent || "").match(/https:[^"'\s\\]+\.m3u8/);
          if (m) return m[0].replace(/\\/g, "");
        }
        return null;
      });
    }

    let video = null;
    if (selectedM3u8) {
      console.log("Downloading HLS:", selectedM3u8);
      const dest = path.join(sessionDir, "video.mp4");
      const ok = await downloadHLS(selectedM3u8, dest);
      if (ok) video = `/downloads/${sessionId}/video.mp4`;
    }

    return { name, price, description, images, video, rating };
  } finally {
    await browser.close();
  }
}

app.post("/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith("http")) return res.status(400).json({ error: "Please provide a valid URL." });
  try {
    const data = await scrape(url);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 4000;
app.listen(PORT, () => console.log(`Scraper running → http://localhost:${PORT}`));
