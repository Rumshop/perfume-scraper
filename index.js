const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const csv = require("csv-parser");
const { chromium } = require("playwright");
const { createObjectCsvWriter } = require("csv-writer");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

/**
 * =========================
 * FILE UPLOAD
 * =========================
 */
const upload = multer({ dest: "/tmp" });

/**
 * =========================
 * GLOBAL PROGRESS (SSE)
 * =========================
 */
let clients = [];

app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  clients.push(res);

  req.on("close", () => {
    clients = clients.filter(c => c !== res);
  });
});

function sendProgress(value) {
  clients.forEach(res => {
    res.write(`data: ${JSON.stringify({ progress: value })}\n\n`);
  });
}

/**
 * =========================
 * BROWSER
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
  page.setDefaultTimeout(30000);
  return page;
}

/**
 * =========================
 * FIXED CSV PARSER
 * =========================
 */
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        const text = Object.values(row).join(" ").trim();
        if (text) rows.push({ raw: text });
      })
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

/**
 * =========================
 * ROW CLEANER (IMPORTANT FIX)
 * =========================
 */
function cleanRow(row) {
  const parts = (row.raw || "").split(" ");

  return {
    brand: parts.slice(0, 2).join(" "),
    product: parts.slice(2).join(" ")
  };
}

/**
 * =========================
 * SCRAPER
 * =========================
 */
async function scrape(row) {
  const page = await newPage();

  try {
    const r = cleanRow(row);
    const query = `${r.brand} ${r.product}`.trim();

    if (!query) return null;

    const url = `https://www.heinemann-shop.com/en/global/search?q=${encodeURIComponent(query)}`;

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const link = await page.evaluate(() => {
      return [...document.querySelectorAll("a")]
        .find(a => a.href.includes("/p/"))?.href || null;
    });

    if (!link) {
      return {
        product: query,
        price: "NO_RESULT",
        store: "Heinemann"
      };
    }

    await page.goto(link, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    const data = await page.evaluate(() => {
      const title = document.querySelector("h1")?.innerText || "NA";
      const text = document.body.innerText;

      const priceMatch = text.match(/€\s?\d+[\.,]\d{2}/);
      const price = priceMatch ? priceMatch[0] : "NA";

      return { title, price };
    });

    return {
      product: data.title,
      price: data.price,
      store: "Heinemann"
    };

  } catch (e) {
    return {
      product: "ERROR",
      price: "NA",
      store: "ERROR"
    };
  } finally {
    await page.close();
  }
}

/**
 * =========================
 * BATCH SCRAPER + PROGRESS
 * =========================
 */
async function runBatch(rows) {
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const progress = Math.round((i / rows.length) * 100);
    sendProgress(progress);

    const result = await scrape(rows[i]);
    results.push(result);
  }

  sendProgress(100);

  return results;
}

/**
 * =========================
 * UPLOAD ROUTE
 * =========================
 */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const rows = await parseCSV(req.file.path);

    console.log("ROWS:", rows.length);

    const results = await runBatch(rows);

    const filePath = path.join("/tmp", "report.csv");

    const writer = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: "product", title: "product" },
        { id: "price", title: "scraped_price" },
        { id: "store", title: "store" }
      ]
    });

    await writer.writeRecords(results);

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      download: "/download"
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * =========================
 * DOWNLOAD
 * =========================
 */
app.get("/download", (req, res) => {
  res.download(path.join("/tmp", "report.csv"));
});

/**
 * =========================
 * START SERVER
 * =========================
 */
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 PERFUME SCRAPER RUNNING");
  console.log("PORT:", PORT);
});