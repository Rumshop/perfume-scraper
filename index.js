const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const csv = require("csv-parser");
const { chromium } = require("playwright");
const { createObjectCsvWriter } = require("csv-writer");
const http = require("http");
const WebSocket = require("ws");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

/**
 * =========================
 * SERVER + WEBSOCKET
 * =========================
 */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let clients = [];

wss.on("connection", (ws) => {
  clients.push(ws);

  ws.on("close", () => {
    clients = clients.filter(c => c !== ws);
  });
});

function sendProgress(data) {
  clients.forEach(ws => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  });
}

/**
 * =========================
 * BROWSER (FAST + STABLE)
 * =========================
 */
let browser;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  return browser;
}

async function newPage() {
  const b = await getBrowser();
  const page = await b.newPage();

  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "font", "media"].includes(type)) return route.abort();
    route.continue();
  });

  page.setDefaultTimeout(15000);
  return page;
}

/**
 * =========================
 * CLEAN ROW (CSV FIX)
 * =========================
 */
function cleanRow(row) {
  const c = (v) =>
    (v ?? "")
      .toString()
      .replace(/\uFEFF/g, "")
      .replace(/"/g, "")
      .trim();

  return {
    brand: c(row.brand || row.Brand),
    product: c(row.product || row.Product || row.description),
    type: c(row.type),
    size: c(row.size)
  };
}

/**
 * =========================
 * SCRAPER ENGINE
 * =========================
 */
async function scrapeHeinemann(row) {
  const page = await newPage();

  try {
    const r = cleanRow(row);

    if (!r.brand && !r.product) {
      await page.close();
      return null;
    }

    const query = `${r.brand} ${r.product}`.toLowerCase();

    await page.goto(
      `https://www.heinemann-shop.com/en/global/search?q=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded" }
    );

    const candidates = await page.$$eval("a[href*='/p/']", links =>
      links.slice(0, 10).map(a => ({
        text: (a.innerText || "").trim(),
        href: a.href
      }))
    );

    if (!candidates.length) {
      await page.close();
      return null;
    }

    const best = candidates[0];

    await page.goto(best.href, { waitUntil: "domcontentloaded" });

    const data = await page.evaluate(() => {
      const title = document.querySelector("h1")?.innerText?.trim() || null;
      const text = document.body.innerText;

      const priceMatch = text.match(/€\s?\d{1,4}[.,]\d{2}/);

      const price = priceMatch
        ? parseFloat(priceMatch[0].replace("€", "").replace(",", "."))
        : null;

      const size = text.match(/(\d+)\s?ml/i)?.[1] || "NA";

      const type =
        text.toLowerCase().includes("eau de parfum") ? "edp" :
        text.toLowerCase().includes("eau de toilette") ? "edt" :
        "NA";

      return { title, price, size, type };
    });

    await page.close();

    if (!data.title || !data.price) return null;

    return {
      product: data.title,
      heinemann_price: data.price,
      scraped_price: data.price,
      currency: "EUR",
      size: data.size,
      type: data.type,
      cheapest_store: "Heinemann",
      cheapest_price: data.price
    };

  } catch (e) {
    await page.close();
    return null;
  }
}

/**
 * =========================
 * BATCH + LIVE PROGRESS
 * =========================
 */
async function runBatch(rows) {
  const results = new Array(rows.length);
  let index = 0;
  const WORKERS = 4;

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= rows.length) break;

      sendProgress({
        current: i + 1,
        total: rows.length,
        percent: Math.round(((i + 1) / rows.length) * 100)
      });

      const result = await scrapeHeinemann(rows[i]);
      const r = cleanRow(rows[i]);

      results[i] = result || {
        product: `${r.brand} ${r.product}`.trim(),
        heinemann_price: "NA",
        scraped_price: "NA",
        currency: "NA",
        size: "NA",
        type: "NA",
        cheapest_store: "NO_RESULT",
        cheapest_price: "NA"
      };
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, worker));

  sendProgress({ done: true });

  return results;
}

/**
 * =========================
 * UPLOAD CSV API
 * =========================
 */
app.post("/upload-csv-ui", upload.single("file"), async (req, res) => {
  const rows = [];

  fs.createReadStream(req.file.path)
    .pipe(csv({ separator: /[\t,;]/ }))
    .on("data", (row) => rows.push(row))
    .on("end", async () => {

      const results = await runBatch(rows);

      const outputPath = path.join(__dirname, "report.csv");

      const writer = createObjectCsvWriter({
        path: outputPath,
        header: [
          { id: "product", title: "product" },
          { id: "heinemann_price", title: "heinemann_price" },
          { id: "scraped_price", title: "scraped_price" },
          { id: "currency", title: "currency" },
          { id: "size", title: "size" },
          { id: "type", title: "type" },
          { id: "cheapest_store", title: "cheapest_store" },
          { id: "cheapest_price", title: "cheapest_price" }
        ]
      });

      await writer.writeRecords(results);

      fs.unlinkSync(req.file.path);

      res.json({
        success: true,
        download: "/download-report"
      });
    });
});

/**
 * =========================
 * DOWNLOAD REPORT
 * =========================
 */
app.get("/download-report", (req, res) => {
  res.download(path.join(__dirname, "report.csv"));
});

/**
 * =========================
 * RAILWAY SAFE START
 * =========================
 */
const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 SCRAPER RUNNING ON PORT:", PORT);
});