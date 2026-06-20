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
 * UPLOAD
 * =========================
 */
const upload = multer({ dest: "/tmp" });

/**
 * =========================
 * PROGRESS SSE
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
 * BROWSER SINGLETON
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
 * FIXED CSV PARSER (IMPORTANT)
 * =========================
 */
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];

    fs.createReadStream(filePath)
      .pipe(csv({ strict: false }))
      .on("data", (row) => {
        const values = Object.values(row)
          .map(v => (v || "").toString().trim())
          .filter(Boolean);

        if (values.length > 0) {
          rows.push({ raw: values.join(" ") });
        }
      })
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

/**
 * =========================
 * CLEAN ROW (FIXED)
 * =========================
 */
function cleanRow(row) {
  const text = (row.raw || "").replace(/\s+/g, " ").trim();

  const parts = text.split(" ");

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

    if (!query || query.length < 3) {
      return {
        product: "INVALID",
        price: "NA",
        store: "SKIPPED"
      };
    }

    console.log("SCRAPING:", query);

    const url = `https://www.heinemann-shop.com/en/global/search?q=${encodeURIComponent(query)}`;

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const link = await page.evaluate(() => {
      const a = [...document.querySelectorAll("a")]
        .find(x => x.href && x.href.includes("/p/"));
      return a ? a.href : null;
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

      return {
        title,
        price: priceMatch ? priceMatch[0] : "NA"
      };
    });

    return {
      product: data.title || query,
      price: data.price || "NA",
      store: "Heinemann"
    };

  } catch (err) {
    console.error("SCRAPE ERROR:", err.message);

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
 * FAST PARALLEL BATCH (FIX SPEED)
 * =========================
 */
async function runBatch(rows) {
  const results = [];
  let index = 0;

  const CONCURRENCY = 5;

  async function worker() {
    while (index < rows.length) {
      const i = index++;

      const progress = Math.round((i / rows.length) * 100);
      sendProgress(progress);

      const result = await scrape(rows[i]);

      if (result) results.push(result);
    }
  }

  await Promise.all(
    Array(CONCURRENCY).fill().map(worker)
  );

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
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const rows = await parseCSV(req.file.path);

    console.log("TOTAL ROWS:", rows.length);

    const results = await runBatch(rows);

    const outputPath = path.join("/tmp", "report.csv");

    const writer = createObjectCsvWriter({
      path: outputPath,
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
      total: results.length,
      download: "/download"
    });

  } catch (err) {
    console.error("UPLOAD ERROR:", err);

    res.status(500).json({
      success: false,
      error: err.message
    });
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
  console.log("🚀 PERFUME SCRAPER READY");
  console.log("PORT:", PORT);
});