const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { chromium } = require("playwright");
const { createObjectCsvWriter } = require("csv-writer");
const fastcsv = require("fast-csv");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

/**
 * =========================
 * PROGRESS
 * =========================
 */
let progress = { total: 0, done: 0, running: false };

app.get("/progress", (req, res) => {
  res.json(progress);
});

/**
 * =========================
 * BROWSER
 * =========================
 */
let browser;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function newPage() {
  const b = await getBrowser();
  return await b.newPage();
}

/**
 * =========================
 * CLEAN ROW
 * =========================
 */
function cleanRow(row) {
  const c = (v) =>
    (v ?? "").toString().replace(/\uFEFF/g, "").replace(/"/g, "").trim();

  return {
    brand: c(row.brand || row.Brand),
    product: c(row.product || row.Product || row.description),
    type: c(row.type),
    size: c(row.size),
  };
}

/**
 * =========================
 * SCRAPER
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

    const query = `${r.brand} ${r.product}`.trim();

    const url = `https://www.heinemann-shop.com/en/global/search?q=${encodeURIComponent(query)}`;

    await page.goto(url, { waitUntil: "domcontentloaded" });

    const candidates = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a"))
        .map(a => ({
          text: a.innerText || "",
          href: a.href || ""
        }))
        .filter(x => x.href.includes("/p/") && x.text.length > 20)
        .slice(0, 15);
    });

    if (!candidates.length) {
      await page.close();
      return null;
    }

    await page.goto(candidates[0].href, { waitUntil: "domcontentloaded" });

    const data = await page.evaluate(() => {
      const title = document.querySelector("h1")?.innerText || null;
      const text = document.body.innerText;

      const priceMatch = text.match(/€\s?\d+[.,]\d{2}/);
      const price = priceMatch
        ? parseFloat(priceMatch[0].replace("€", "").replace(",", "."))
        : null;

      const size = text.match(/(\d+)\s?ml/i)?.[1] || "NA";

      return { title, price, size };
    });

    await page.close();

    if (!data.title || !data.price) return null;

    return {
      product: data.title,
      scraped_price: data.price,
      currency: "EUR",
      size: data.size,
      store: "Heinemann",
    };

  } catch (e) {
    await page.close();
    return null;
  }
}

/**
 * =========================
 * BATCH
 * =========================
 */
async function runBatch(rows) {
  progress.total = rows.length;
  progress.done = 0;
  progress.running = true;

  const results = [];
  let index = 0;

  async function worker() {
    while (index < rows.length) {
      const i = index++;

      const result = await scrapeHeinemann(rows[i]);

      const r = cleanRow(rows[i]);

      results.push(
        result || {
          product: `${r.brand} ${r.product}`,
          scraped_price: "NA",
          currency: "NA",
          size: "NA",
          store: "NO_RESULT",
        }
      );

      progress.done++;
    }
  }

  await Promise.all([worker(), worker(), worker()]);

  progress.running = false;
  return results;
}

/**
 * =========================
 * UPLOAD (FIXED CSV PARSER)
 * =========================
 */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });

    const rows = [];

    fs.createReadStream(req.file.path)
      .pipe(fastcsv.parse({ headers: true, delimiter: /[\t,;]/ }))
      .on("data", (row) => rows.push(row))
      .on("end", async () => {

        const results = await runBatch(rows);

        const file = path.join(__dirname, "report.csv");

        const writer = createObjectCsvWriter({
          path: file,
          header: [
            { id: "product", title: "product" },
            { id: "scraped_price", title: "scraped_price" },
            { id: "currency", title: "currency" },
            { id: "size", title: "size" },
            { id: "store", title: "store" },
          ],
        });

        await writer.writeRecords(results);

        fs.unlinkSync(req.file.path);

        res.json({
          success: true,
          download: "/download",
        });
      });

  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "Server crash" });
  }
});

/**
 * =========================
 * DOWNLOAD
 * =========================
 */
app.get("/download", (req, res) => {
  res.download(path.join(__dirname, "report.csv"));
});

/**
 * =========================
 * START
 * =========================
 */
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 FIXED SCRAPER RUNNING");
  console.log("POST /upload");
  console.log("GET /download");
  console.log("GET /progress");
});