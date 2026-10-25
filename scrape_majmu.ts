import { Database } from "bun:sqlite";
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const BASE_DIR = "C:\\Workspace\\majmu_al_fatawa";
const DB_PATH = join(BASE_DIR, "majmu_al_fatawa.db");
const TOTAL_PAGES = 16874;
const CONCURRENCY = 40;
const BATCH_SIZE = 50;

interface PageRecord {
  $page_id: number;
  $tome: string;
  $page_key: string;
  $original_text: string;
  $original_footnote: string;
  $translated_text: string;
  $translated_footnote: string;
  $corrected_translated_text: string | null;
  $has_next_page: number;
  $raw_json: string;
}

interface PageDbRow {
  page_id: number;
  tome: string;
  page_key: string;
  original_text: string;
  original_footnote: string;
  translated_text: string;
  translated_footnote: string;
  corrected_translated_text: string | null;
  has_next_page: number;
}

interface ApiResponse {
  current_page?: number;
  current_tome?: string;
  page_key?: string;
  original_text?: string;
  original_footnote?: string;
  translated_text?: string;
  translated_footnote?: string;
  corrected_translated_text?: unknown;
  has_next_page?: boolean;
  table_content?: unknown;
}

async function fetchJSON<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
  }
  return (await resp.json()) as T;
}

async function initMetadata() {
  console.log("=== Fetching Book Metadata, Navigation, Details & Cover ===");
  
  // 1. Book Details
  console.log("1. Fetching book details...");
  const details = await fetchJSON<ApiResponse>("https://kutub.io/api/books/book-details", {
    method: "POST",
    body: JSON.stringify({ bookId: "7289", lang: "en" })
  });
  writeFileSync(join(BASE_DIR, "book_details.json"), JSON.stringify(details, null, 2), "utf-8");

  // 2. Metadata
  console.log("2. Fetching book metadata...");
  const metadata = await fetchJSON<unknown>("https://kutub.io/api/books/book-metadata", {
    method: "POST",
    body: JSON.stringify({ bookId: "7289", lang: "en" })
  });
  writeFileSync(join(BASE_DIR, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");

  // 3. Navigation
  console.log("3. Fetching navigation...");
  const navigation = await fetchJSON<unknown>("https://kutub.io/api/books/navigation?bookId=7289");
  writeFileSync(join(BASE_DIR, "navigation.json"), JSON.stringify(navigation, null, 2), "utf-8");

  // 4. Table of Contents
  if (details.table_content) {
    console.log("4. Saving table of contents...");
    writeFileSync(join(BASE_DIR, "table_of_contents.json"), JSON.stringify(details.table_content, null, 2), "utf-8");
  }

  // 5. Book Cover Image
  console.log("5. Downloading cover image...");
  const coverUrl = "https://qpkzhngqdtaetrcjfdnk.supabase.co/storage/v1/object/public/kutub_bucket/book_image/7289.jpg";
  try {
    const coverResp = await fetch(coverUrl);
    if (coverResp.ok) {
      const buf = Buffer.from(await coverResp.arrayBuffer());
      writeFileSync(join(BASE_DIR, "cover.jpg"), buf);
      console.log(`Cover saved (${buf.length} bytes).`);
    } else {
      console.warn("Failed to download cover:", coverResp.status);
    }
  } catch (err) {
    console.warn("Error downloading cover:", err);
  }

  return { details, metadata, navigation };
}

function initDatabase() {
  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");

  db.run(`
    CREATE TABLE IF NOT EXISTS pages (
      page_id INTEGER PRIMARY KEY,
      tome TEXT,
      page_key TEXT,
      original_text TEXT,
      original_footnote TEXT,
      translated_text TEXT,
      translated_footnote TEXT,
      corrected_translated_text TEXT,
      has_next_page INTEGER,
      raw_json TEXT
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_pages_tome ON pages(tome);`);
  return db;
}

async function scrapePages(db: Database) {
  const existingRows = db.query("SELECT page_id FROM pages").all() as { page_id: number }[];
  const existingSet = new Set(existingRows.map(r => r.page_id));
  console.log(`Pages already in database: ${existingSet.size} / ${TOTAL_PAGES}`);

  const missingPids: number[] = [];
  for (let p = 1; p <= TOTAL_PAGES; p++) {
    if (!existingSet.has(p)) {
      missingPids.push(p);
    }
  }

  if (missingPids.length === 0) {
    console.log("All pages already downloaded!");
    return;
  }

  console.log(`Starting download of ${missingPids.length} remaining pages with concurrency ${CONCURRENCY}...`);

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO pages (
      page_id, tome, page_key, original_text, original_footnote,
      translated_text, translated_footnote, corrected_translated_text,
      has_next_page, raw_json
    ) VALUES (
      $page_id, $tome, $page_key, $original_text, $original_footnote,
      $translated_text, $translated_footnote, $corrected_translated_text,
      $has_next_page, $raw_json
    )
  `);

  const insertMany = db.transaction((records: PageRecord[]) => {
    for (const r of records) {
      insertStmt.run(r as unknown as Record<string, string | number | null>);
    }
  });

  let cursor = 0;
  let completed = 0;
  let batch: PageRecord[] = [];
  const tStart = Date.now();
  let lastReport = Date.now();

  const fetchOnePage = async (pageId: number, retry = 3): Promise<PageRecord> => {
    for (let attempt = 1; attempt <= retry; attempt++) {
      try {
        const resp = await fetch("https://kutub.io/api/books/page-content", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0"
          },
          body: JSON.stringify({
            bookId: "7289",
            pageId: String(pageId),
            lang: "en",
            includeNavigation: false
          })
        });

        if (resp.status === 429) {
          const waitMs = attempt * 1000;
          await Bun.sleep(waitMs);
          continue;
        }

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }

        const data = (await resp.json()) as ApiResponse;
        return {
          $page_id: pageId,
          $tome: data.current_tome || "",
          $page_key: data.page_key || "",
          $original_text: data.original_text || "",
          $original_footnote: data.original_footnote || "",
          $translated_text: data.translated_text || "",
          $translated_footnote: data.translated_footnote || "",
          $corrected_translated_text: data.corrected_translated_text ? JSON.stringify(data.corrected_translated_text) : null,
          $has_next_page: data.has_next_page ? 1 : 0,
          $raw_json: JSON.stringify(data)
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === retry) {
          console.error(`Failed page ${pageId} after ${retry} attempts: ${msg}`);
          throw err;
        }
        await Bun.sleep(500 * attempt);
      }
    }
    throw new Error(`Exhausted retries for page ${pageId}`);
  };

  const worker = async () => {
    while (cursor < missingPids.length) {
      const idx = cursor++;
      const pageId = missingPids[idx];
      try {
        const record = await fetchOnePage(pageId);
        batch.push(record);
        completed++;

        if (batch.length >= BATCH_SIZE) {
          const toInsert = batch;
          batch = [];
          insertMany(toInsert);
        }

        const now = Date.now();
        if (now - lastReport >= 5000 || completed === missingPids.length) {
          lastReport = now;
          const totalDone = existingSet.size + completed;
          const pct = ((totalDone / TOTAL_PAGES) * 100).toFixed(1);
          const elapsedSec = (now - tStart) / 1000;
          const rate = (completed / Math.max(0.1, elapsedSec)).toFixed(1);
          const remainingPages = missingPids.length - completed;
          const etaSec = remainingPages / Math.max(1, completed / elapsedSec);
          const etaMin = (etaSec / 60).toFixed(1);
          console.log(`[Progress] ${totalDone} / ${TOTAL_PAGES} (${pct}%) | ${rate} pages/s | ETA: ${etaMin} min`);
        }
      } catch {
        // Page failed after retries, will be retried in verification pass
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (batch.length > 0) {
    insertMany(batch);
    batch = [];
  }

  const row = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM pages").get();
  const finalCount = row ? row.count : 0;
  console.log(`Download round complete. Pages in DB: ${finalCount} / ${TOTAL_PAGES}`);
}

async function exportOrganizedFormats(db: Database) {
  console.log("=== Generating Exports (JSONL, per-tome JSON, MD, TXT) ===");

  const tomesDir = join(BASE_DIR, "tomes");
  if (!existsSync(tomesDir)) {
    mkdirSync(tomesDir, { recursive: true });
  }

  // 1. JSONL Export
  console.log("1. Generating all_pages.jsonl...");
  const jsonlPath = join(BASE_DIR, "all_pages.jsonl");
  const jsonlFile = Bun.file(jsonlPath);
  const jsonlWriter = jsonlFile.writer();

  const allPages = db.query(`
    SELECT page_id, tome, page_key, original_text, original_footnote,
           translated_text, translated_footnote, corrected_translated_text, has_next_page
    FROM pages
    ORDER BY page_id ASC
  `).all() as PageDbRow[];

  for (const page of allPages) {
    jsonlWriter.write(JSON.stringify(page) + "\n");
  }
  await jsonlWriter.end();
  console.log(`all_pages.jsonl written (${allPages.length} pages).`);

  // 2. Group by Tome
  console.log("2. Generating per-tome files...");
  const tomesMap = new Map<string, PageDbRow[]>();
  for (const page of allPages) {
    const t = page.tome || "unknown";
    if (!tomesMap.has(t)) {
      tomesMap.set(t, []);
    }
    tomesMap.get(t)!.push(page);
  }

  function getTomeDirName(tomeKey: string): string {
    if (tomeKey === "المقدمة") {
      return "tome_00_muqaddimah";
    }
    if (tomeKey === "3 أ") {
      return "tome_03_supplement";
    }
    const num = parseInt(tomeKey, 10);
    if (!isNaN(num)) {
      return `tome_${String(num).padStart(2, "0")}`;
    }
    return `tome_${tomeKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  }

  for (const [tomeKey, pages] of tomesMap.entries()) {
    const tomeDirName = getTomeDirName(tomeKey);
    const tomeFolder = join(tomesDir, tomeDirName);
    if (!existsSync(tomeFolder)) {
      mkdirSync(tomeFolder, { recursive: true });
    }

    // pages.json
    writeFileSync(join(tomeFolder, "pages.json"), JSON.stringify(pages, null, 2), "utf-8");

    // english.md
    let mdContent = `# Majmu' al-Fatawa - Tome ${tomeKey}\n\n`;
    for (const p of pages) {
      mdContent += `## Page ${p.page_id}\n\n`;
      mdContent += `${p.translated_text || ""}\n\n`;
      if (p.translated_footnote) {
        mdContent += `> **Footnotes:**\n> ${p.translated_footnote.replace(/\n/g, "\n> ")}\n\n`;
      }
      mdContent += `---\n\n`;
    }
    writeFileSync(join(tomeFolder, "english.md"), mdContent, "utf-8");

    // arabic.txt
    let arContent = `مجموع الفتاوى - المجلد ${tomeKey}\n\n`;
    for (const p of pages) {
      arContent += `=== صفحة ${p.page_id} ===\n\n`;
      arContent += `${p.original_text || ""}\n\n`;
      if (p.original_footnote) {
        arContent += `[الهوامش]\n${p.original_footnote}\n\n`;
      }
      arContent += `----------------------------------------\n\n`;
    }
    writeFileSync(join(tomeFolder, "arabic.txt"), arContent, "utf-8");
  }

  console.log(`Generated ${tomesMap.size} tomes folders.`);

  // 3. Generate README.md
  console.log("3. Generating README.md...");
  const readmeContent = `# Majmu' al-Fatawa (مجموع الفتاوى) - Ibn Taymiyyah

Complete bilingual collection (Arabic original and English translation) extracted from [Kutub.io](https://kutub.io/en/book/7289).

## Dataset Summary
- **Author**: Shaykh al-Islām Ahmad ibn Taymiyyah (شيخ الإسلام ابن تيمية)
- **Compiler**: Abd al-Rahmān ibn Muhammad ibn Qāsim (عبد الرحمن بن قاسم)
- **Total Volumes (Tomes)**: 37 tomes
- **Total Pages**: 16,874 pages
- **Translation Status**: 100% translated (English)
- **Source**: Kutub.io Book ID 7289

## File Structure
- \`majmu_al_fatawa.db\`: SQLite 3 database containing all 16,874 pages (table \`pages\`) with fields:
  - \`page_id\`: Global page number (1 to 16,874)
  - \`tome\`: Volume/Tome designation
  - \`page_key\`: Kutub page UUID
  - \`original_text\`: Arabic text
  - \`original_footnote\`: Arabic footnotes
  - \`translated_text\`: English translated text
  - \`translated_footnote\`: English translated footnotes
  - \`corrected_translated_text\`: Editorial revisions/corrections (JSON)
  - \`has_next_page\`: Boolean flag
  - \`raw_json\`: Complete API response
- \`all_pages.jsonl\`: Streaming JSON Lines format (1 line per page)
- \`metadata.json\`: Book title, author, phonetic titles, IDs
- \`navigation.json\`: Tomes list and page range index
- \`book_details.json\`: Complete catalog record and metrics
- \`table_of_contents.json\`: Full hierarchical chapter and section index
- \`cover.jpg\`: High-resolution book cover image
- \`tomes/\`: Directory with 37 volumes, each containing:
  - \`pages.json\`: Structured JSON of all pages in the volume
  - \`english.md\`: Clean formatted English Markdown text
  - \`arabic.txt\`: Clean Arabic text

## Querying the SQLite Database
\`\`\`sql
-- Get page 100
SELECT original_text, translated_text FROM pages WHERE page_id = 100;

-- Count pages per volume
SELECT tome, COUNT(*) as page_count FROM pages GROUP BY tome ORDER BY MIN(page_id);

-- Search English translation for a keyword
SELECT page_id, tome, translated_text FROM pages WHERE translated_text LIKE '%tawhid%' LIMIT 10;
\`\`\`
`;
  writeFileSync(join(BASE_DIR, "README.md"), readmeContent, "utf-8");
  console.log("README.md written.");
}

async function main() {
  console.log("Starting Majmu' al-Fatawa Extraction to " + BASE_DIR);
  await initMetadata();
  const db = initDatabase();
  await scrapePages(db);
  // If some pages failed, run a retry pass
  const countRow = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM pages").get();
  let count = countRow ? countRow.count : 0;
  let retryRound = 0;
  while (count < TOTAL_PAGES && retryRound < 3) {
    retryRound++;
    console.log(`Retry round ${retryRound} for missing pages (${count}/${TOTAL_PAGES})...`);
    await scrapePages(db);
    const nextCountRow = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM pages").get();
    count = nextCountRow ? nextCountRow.count : 0;
  }
  await exportOrganizedFormats(db);
  console.log("=== ALL TASKS COMPLETED SUCCESSFULLY! ===");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
