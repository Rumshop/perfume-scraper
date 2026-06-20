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

const upload = multer({ dest: "uploads/" });

/**
 * =========================
 * SSE PROGRESS SYSTEM
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

function sendProgress(data) {
  clients.forEach(c => c.write(`data: ${JSON.stringify(data)}\n\n`));
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
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
  }
  return browser;
}

async function newPage() {
  const b = await getBrowser();
  const page = await b.newPage();

  await page.setDefaultTimeout(20000);
  await page.setDefaultNavigationTimeout(20000);

  // SPEED BOOST
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "font", "media"].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  return page;
}

/**
 * =========================
 * CLEAN ROW
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
    product: c(row.product || row.Product || row.description)
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

    const url = `https://www.heinemann-shop.com/en/global/search?q=${encodeURIComponent(query)}`;

    await page.goto(url, { waitUntil: "domcontentloaded" });

    const links = await page.$$eval("a", as =>
      as
        .map(a => ({ text: a.innerText, href: a.href }))
        .filter(a => a.href && a.href.includes("/p/") && a.text?.length > 15)
        .slice(0, 10)
    );

    if (!links.length) {
      await page.close();
      return null;
    }

    await page.goto(links[0].href, { waitUntil: "domcontentloaded" });

    const data = await page.evaluate(() => {
      const title = document.querySelector("h1")?.innerText || null;
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
      scraped_price: data.price,   // ✅ IMPORTANT COLUMN
      currency: "EUR",
      size: data.size,
      type: data.type,
      store: "Heinemann"
    };

  } catch (e) {
    await page.close();
    return null;
  }
}

/**
 * =========================
 * BATCH WITH REAL PROGRESS
 * =========================
 */
async function runBatch(rows) {
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const percent = Math.round(((i + 1) / rows.length) * 100);

    sendProgress({
      current: i + 1,
      total: rows.length,
      percent
    });

    const result = await scrape(rows[i]);

    results.push(
      result || {
        product: rows[i].product,
        scraped_price: "NA",
        currency: "NA",
        size: "NA",
        type: "NA",
        store: "NO_RESULT"
      }
    );
  }

  sendProgress({ done: true });

  return results;
}

/**
 * =========================
 * UPLOAD CSV
 * =========================
 */
app.post("/upload-csv-ui", upload.single("file"), async (req, res) => {
  const rows = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (d) => rows.push(d))
    .on("end", async () => {

      const results = await runBatch(rows);

      const outputPath = path.join(__dirname, "report.csv");

      const writer = createObjectCsvWriter({
        path: outputPath,
        header: [
          { id: "product", title: "product" },
          { id: "scraped_price", title: "scraped_price" },
          { id: "currency", title: "currency" },
          { id: "size", title: "size" },
          { id: "type", title: "type" },
          { id: "store", title: "store" }
        ]
      });

      await writer.writeRecords(results);

      fs.unlinkSync(req.file.path);

      res.json({ success: true });
    });
});

/**
 * =========================
 */
app.get("/download-report", (req, res) => {
  res.download(path.join(__dirname, "report.csv"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("RUNNING ON", PORT));