const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { createObjectCsvWriter } = require("csv-writer");

const connection = new IORedis({
  host: "127.0.0.1",
  port: 6379,
  maxRetriesPerRequest: null
});

async function scrapeHeinemann(query) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    const url = `https://www.heinemann-shop.com/en/global/search?q=${encodeURIComponent(query)}`;
    await page.goto(url);

    const productUrl = await page.evaluate((q) => {
      const links = [...document.querySelectorAll("a")];

      const scored = links
        .map(a => {
          const text = (a.innerText || "").toLowerCase();
          const href = a.href;

          if (!href.includes("/p/")) return null;

          let score = 0;
          for (const w of q.split(" ")) {
            if (text.includes(w)) score += 2;
          }

          return { href, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

      return scored[0]?.href || null;
    }, query);

    if (!productUrl) {
      await browser.close();
      return null;
    }

    await page.goto(productUrl);

    const data = await page.evaluate(() => {
      const name = document.querySelector("h1")?.innerText;
      const text = document.body.innerText;

      const match = text.match(/€\s?(\d+[\.,]?\d*)/);

      return {
        product: name,
        price: match ? parseFloat(match[1]) : null
      };
    });

    await browser.close();

    return data.price ? data : null;

  } catch (e) {
    await browser.close();
    return null;
  }
}

new Worker(
  "scrapeQueue",
  async (job) => {

    const { jobId, products } = job.data;

    const results = [];

    for (let i = 0; i < products.length; i++) {

      const res = await scrapeHeinemann(products[i]);

      results.push({
        product: products[i],
        heinemann_price: res?.price || "NA",
        currency: "EUR",
        cheapest_store: res ? "Heinemann" : "NO_RESULT",
        cheapest_price: res?.price || "NA"
      });
    }

    const filePath = path.join(__dirname, `report-${jobId}.csv`);

    const writer = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: "product", title: "product" },
        { id: "heinemann_price", title: "heinemann_price" },
        { id: "currency", title: "currency" },
        { id: "cheapest_store", title: "cheapest_store" },
        { id: "cheapest_price", title: "cheapest_price" }
      ]
    });

    await writer.writeRecords(results);

    console.log("✅ Report created:", filePath);
  },
  { connection }
);

console.log("🚀 Worker running...");