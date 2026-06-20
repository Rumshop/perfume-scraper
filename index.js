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

const PORT = process.env.PORT || 8080;

const upload = multer({ dest: "/tmp/uploads/" });

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
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
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
 * CLEAN ROW
 * =========================
 */
function cleanRow(row) {
  return {
    brand: row.brand || row.Brand || "",
    product: row.product || row.Product || row.description || ""
  };
}

/**
 * =========================
 * SCRAPER (FIXED + RELIABLE)
 * =========================
 */
async function scrapeHeinemann(row) {
  const page = await newPage();

  try {
    const r = cleanRow(row);
    const query = `${r.brand} ${r.product}`.trim();

    if (!query) {
      await page.close();
      return null;
    }

    const url =
      `https://www.heinemann-shop.com/en/global/search?q=${encodeURIComponent(query)}`;

    await page.goto(url, { waitUntil: "domcontentloaded" });

    await page.waitForTimeout(2000);

    /**
     * BETTER PRODUCT DETECTION (FIX NO RESULT)
     */
    const productLink = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));

      for (const a of links) {
        const href = a.href || "";
        const text = (a.innerText || "").toLowerCase();

        if (!href.includes("/p/")) continue;
        if (text.length < 8) continue;

        // loose matching (IMPORTANT FIX)
        if (
          text.includes("eau") ||
          text.includes("parfum") ||
          text.includes("ml") ||
          text.includes("edt") ||
          text.includes("edp")
        ) {
          return href;
        }
      }

      return null;
    });

    if (!productLink) {
      await page.close();
      return {
        product: query,
        scraped_price: "NO_RESULT",
        currency: "NA",
        cheapest_store: "FAILED",
        cheapest_price: "NA"
      };
    }

    await page.goto(productLink, { waitUntil: "domcontentloaded" });

    await page.waitForTimeout(1500);

    /**
     * EXTRACT DATA
     */
    const data = await page.evaluate(() => {
      const title =
        document.querySelector("h1")?.innerText?.trim() || "NA";

      const text = document.body.innerText;

      const priceMatch = text.match(/€\s?\d{1,4}(?:[.,]\d{2})/);

      const price = priceMatch
        ? parseFloat(priceMatch[0].replace("€", "").replace(",", "."))
        : null;

      return {
        title,
        price
      };
    });

    await page.close();

    return {
      product: data.title || query,
      scraped_price: data.price || "NA",   // ✅ YOUR REQUIRED COLUMN
      currency: "EUR",
      cheapest_store: "Heinemann",
      cheapest_price: data.price || "NA"
    };

  } catch (e) {
    await page.close();
    return {
      product: "ERROR",
      scraped_price: "NA",
      currency: "NA",
      cheapest_store: "ERROR",
      cheapest_price: "NA"
    };
  }
}

/**
 * =========================
 * FAST PARALLEL BATCH (FIXED SPEED)
 * =========================
 */
async function runBatch(rows) {
  const results = [];

  const CONCURRENCY = 4; // ⚡ SPEED BOOST

  let index = 0;

  async function worker() {
    while (index < rows.length) {
      const i = index++;
      const result = await scrapeHeinemann(rows[i]);
      results.push(result);
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }).map(worker)
  );

  return results;
}

/**
 * =========================
 * CSV PARSER
 * =========================
 */
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

/**
 * =========================
 * UPLOAD API
 * =========================
 */
app.post("/upload-csv-ui", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });

    const rows = await parseCSV(req.file.path);

    console.log("TOTAL ROWS:", rows.length);

    const results = await runBatch(rows);

    const outputPath = path.join("/tmp", "report.csv");

    const writer = createObjectCsvWriter({
      path: outputPath,
      header: [
        { id: "product", title: "product" },
        { id: "scraped_price", title: "scraped_price" }, // ✅ NEW COLUMN
        { id: "currency", title: "currency" },
        { id: "cheapest_store", title: "cheapest_store" },
        { id: "cheapest_price", title: "cheapest_price" }
      ]
    });

    await writer.writeRecords(results);

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      total: results.length,
      download: "/download-report"
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
app.get("/download-report", (req, res) => {
  res.download(path.join("/tmp", "report.csv"));
});

/**
 * =========================
 * START
 * =========================
 */
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 PERFUME ENGINE FINAL FAST VERSION");
  console.log("PORT:", PORT);
});