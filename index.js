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

/**
 * =========================
 * RAILWAY PORT FIX
 * =========================
 */
const PORT = process.env.PORT || 8080;

/**
 * =========================
 * UPLOAD CONFIG (RAILWAY SAFE)
 * =========================
 */
const upload = multer({ dest: "/tmp/uploads/" });

/**
 * =========================
 * BROWSER INSTANCE (FIXED)
 * =========================
 */
let browser;

async function getBrowser() {
  if (!browser) {
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage"
        ]
      });
    } catch (err) {
      console.error("BROWSER LAUNCH ERROR:", err);
      throw err;
    }
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
 * SAFE CSV PARSER
 * =========================
 */
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        if (row && Object.keys(row).length > 0) {
          rows.push(row);
        }
      })
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

/**
 * =========================
 * CLEAN INPUT
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
 * SCRAPER CORE (SAFE)
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

    const url = `https://www.heinemann-shop.com/en/global/search?q=${encodeURIComponent(query)}`;

    await page.goto(url, { waitUntil: "domcontentloaded" });

    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a"))
        .map(a => ({
          text: a.innerText,
          href: a.href
        }))
        .filter(a =>
          a.href.includes("/p/") &&
          a.text &&
          a.text.length > 10
        )
        .slice(0, 10);
    });

    if (!links.length) {
      await page.close();
      return null;
    }

    await page.goto(links[0].href, { waitUntil: "domcontentloaded" });

    const data = await page.evaluate(() => {
      const text = document.body.innerText;

      const priceMatch = text.match(/€\s?\d+[.,]\d{2}/);

      const price = priceMatch
        ? parseFloat(priceMatch[0].replace("€", "").replace(",", "."))
        : null;

      const title = document.querySelector("h1")?.innerText || "NA";

      return {
        title,
        price
      };
    });

    await page.close();

    return {
      product: data.title,
      heinemann_price: data.price || "NA",
      currency: "EUR",
      cheapest_store: "Heinemann",
      cheapest_price: data.price || "NA"
    };

  } catch (err) {
    await page.close();
    console.error("SCRAPER ERROR:", err);
    return null;
  }
}

/**
 * =========================
 * BATCH ENGINE
 * =========================
 */
async function runBatch(rows) {
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    console.log(`PROCESSING ${i + 1}/${rows.length}`);

    try {
      const result = await scrapeHeinemann(rows[i]);
      const clean = cleanRow(rows[i]);

      results.push(
        result || {
          product: clean.product || "UNKNOWN",
          heinemann_price: "NA",
          currency: "NA",
          cheapest_store: "NO_RESULT",
          cheapest_price: "NA"
        }
      );
    } catch (err) {
      console.error("ROW ERROR:", err);
    }
  }

  return results;
}

/**
 * =========================
 * HOME PAGE
 * =========================
 */
app.get("/", (req, res) => {
  res.send("🚀 PERFUME ENGINE RUNNING");
});

/**
 * =========================
 * TEST API
 * =========================
 */
app.get("/compare", async (req, res) => {
  try {
    const q = req.query.q;

    const result = await scrapeHeinemann({
      brand: "",
      product: q
    });

    res.json({
      success: true,
      result
    });

  } catch (err) {
    console.error("COMPARE ERROR:", err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * =========================
 * CSV UPLOAD
 * =========================
 */
app.post("/upload-csv-ui", upload.single("file"), async (req, res) => {
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
        { id: "heinemann_price", title: "heinemann_price" },
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
 * DOWNLOAD REPORT
 * =========================
 */
app.get("/download-report", (req, res) => {
  const file = path.join("/tmp", "report.csv");
  res.download(file);
});

/**
 * =========================
 * START SERVER (CRITICAL FOR RAILWAY)
 * =========================
 */
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 PERFUME ENGINE LIVE");
  console.log("PORT:", PORT);
});