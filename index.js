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
 * ROW NORMALIZER (IMPORTANT FIX)
 * =========================
 */
function cleanRow(row) {
  const raw = Object.values(row).join(" ");

  const parts = raw
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");

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
      const a = [...document.querySelectorAll("a")];
      const found = a.find(el => el.href.includes("/p/"));
      return found ? found.href : null;
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
      const price = priceMatch
        ? priceMatch[0].replace("€", "").trim()
        : "NA";

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
 * BATCH (FASTER)
 * =========================
 */
async function runBatch(rows) {
  const results = [];

  let i = 0;
  const workers = 4;

  async function worker() {
    while (i < rows.length) {
      const index = i++;
      console.log(`Processing ${index + 1}/${rows.length}`);

      const result = await scrape(rows[index]);
      results.push(result);
    }
  }

  await Promise.all(Array.from({ length: workers }).map(worker));

  return results;
}

/**
 * =========================
 * CSV PARSER (FIXED - NO REGEX BUG)
 * =========================
 */
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];

    fs.createReadStream(filePath)
      .pipe(csv()) // ❌ NO separator REGEX (FIXED CRASH)
      .on("data", (data) => rows.push(data))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

/**
 * =========================
 * UPLOAD API
 * =========================
 */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const rows = await parseCSV(req.file.path);

    console.log("ROWS:", rows.length);

    const results = await runBatch(rows);

    const file = path.join("/tmp", "report.csv");

    const writer = createObjectCsvWriter({
      path: file,
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

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
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
 * ROOT
 * =========================
 */
app.get("/", (req, res) => {
  res.send("Perfume Scraper Running 🚀");
});

/**
 * =========================
 * START
 * =========================
 */
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 SCRAPER RUNNING ON PORT", PORT);
});