#!/usr/bin/env node
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const buildersData = JSON.parse(readFileSync('scripts/builders-data.json', 'utf8')).builders;
const BUILDERS = Object.values(buildersData);

const CITY_MAP = {
  '四日市': 'yokkaichi', '桑名': 'kuwana', '鈴鹿': 'suzuka',
  'いなべ': 'inabe', '亀山': 'kameyama', '菰野': 'komono', '東員': 'toin'
};

function detectCity(text) {
  for (const [key, val] of Object.entries(CITY_MAP)) {
    if (text.includes(key)) return val;
  }
  return null;
}

function detectCityLabel(text) {
  for (const [key] of Object.entries(CITY_MAP)) {
    if (text.includes(key)) return key;
  }
  return '';
}

function detectType(text) {
  if (text.includes('見学会') || text.includes('オープンハウス')) return 'open-house';
  if (text.includes('モデルハウス')) return 'model-home';
  if (text.includes('セミナー') || text.includes('勉強会')) return 'seminar';
  if (text.includes('キャンペーン') || text.includes('フェア') || text.includes('特典')) return 'campaign';
  if (text.includes('相談会') || text.includes('相談')) return 'consultation';
  return 'other';
}

function parseJpDates(text) {
  // "3/20(金)～4/30(木)" or "3.20-4.30" patterns
  const year = new Date().getFullYear();
  
  // Range: "3/20～4/30" or "3.20-4.30" or "3/20(金)〜4/30(木)"
  const rangeMatch = text.match(/(\d{1,2})[/.．](\d{1,2})[\s\S]*?[～〜\-\–][\s\S]*?(\d{1,2})[/.．](\d{1,2})/);
  if (rangeMatch) {
    const start = `${year}-${rangeMatch[1].padStart(2,'0')}-${rangeMatch[2].padStart(2,'0')}`;
    const end = `${year}-${rangeMatch[3].padStart(2,'0')}-${rangeMatch[4].padStart(2,'0')}`;
    return { startDate: start, endDate: end };
  }
  
  // Single date: "3/20"
  const single = text.match(/(\d{1,2})[/.．](\d{1,2})/);
  if (single) {
    const d = `${year}-${single[1].padStart(2,'0')}-${single[2].padStart(2,'0')}`;
    return { startDate: d, endDate: d };
  }
  
  return null;
}

function slugify(text) {
  return text.replace(/[^a-zA-Z0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '-').substring(0, 40).toLowerCase();
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// ============== Per-builder scrapers ==============

async function scrapeHouseCraft(page, builder) {
  await page.goto('https://www.house-craft.jp/events/', { waitUntil: 'networkidle2', timeout: 30000 });
  await wait(2000);
  
  return await page.evaluate(() => {
    const events = [];
    // House Craft lists events as cards with links
    const articles = document.querySelectorAll('article, .event-item, .post-item, a[href*="event"]');
    const seen = new Set();
    
    // Get all links that look like individual event pages
    document.querySelectorAll('a[href*="/events/"]').forEach(a => {
      const href = a.href;
      if (seen.has(href) || href === window.location.href) return;
      seen.add(href);
      
      const card = a.closest('article, .card, li, div') || a;
      const title = (a.querySelector('h2, h3, .title')?.textContent || a.textContent || '').trim();
      const meta = card.textContent || '';
      
      if (title.length > 5 && title.length < 200) {
        events.push({ title, meta: meta.substring(0, 500), sourceUrl: href });
      }
    });
    
    // Fallback: grab main page content for event info
    if (events.length === 0) {
      const bodyText = document.body.innerText;
      events.push({ title: 'PAGE_CONTENT', meta: bodyText.substring(0, 3000), sourceUrl: window.location.href });
    }
    
    return events;
  });
}

async function scrapeSatisHome(page, builder) {
  await page.goto('https://satishome.com/event/', { waitUntil: 'networkidle2', timeout: 30000 });
  await wait(2000);
  
  return await page.evaluate(() => {
    const events = [];
    // Satis Home event page has event cards
    const cards = document.querySelectorAll('.event-card, article, .post, [class*="event"]');
    
    cards.forEach(card => {
      const title = (card.querySelector('h2, h3, .event-title, .title')?.textContent || '').trim();
      const meta = card.textContent || '';
      const link = card.querySelector('a[href]')?.href || card.closest('a')?.href || '';
      
      if (title.length > 3) {
        events.push({ title, meta: meta.substring(0, 500), sourceUrl: link || window.location.href });
      }
    });
    
    if (events.length === 0) {
      events.push({ title: 'PAGE_CONTENT', meta: document.body.innerText.substring(0, 3000), sourceUrl: window.location.href });
    }
    
    return events;
  });
}

async function scrapeGeneric(page, builder) {
  if (!builder.eventsPageUrl) return [];
  
  try {
    await page.goto(builder.eventsPageUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await wait(2000);
    
    return await page.evaluate((builderName) => {
      const events = [];
      const seen = new Set();
      
      // Strategy 1: Find event links
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        const text = (a.textContent || '').trim();
        if (seen.has(href) || text.length < 10 || text.length > 300) return;
        
        const combined = text.toLowerCase();
        const isEvent = combined.includes('見学') || combined.includes('相談') || 
                       combined.includes('セミナー') || combined.includes('フェア') ||
                       combined.includes('キャンペーン') || combined.includes('イベント') ||
                       combined.includes('オープン') || combined.includes('モデル');
        
        if (isEvent) {
          seen.add(href);
          const card = a.closest('article, li, .card, div') || a;
          events.push({
            title: text.substring(0, 150),
            meta: (card.textContent || '').substring(0, 500),
            sourceUrl: href
          });
        }
      });
      
      // Strategy 2: page body text
      if (events.length === 0) {
        events.push({
          title: 'PAGE_CONTENT',
          meta: document.body.innerText.substring(0, 4000),
          sourceUrl: window.location.href
        });
      }
      
      return events;
    }, builder.name);
  } catch (e) {
    console.log(`  Error: ${e.message.substring(0, 60)}`);
    return [];
  }
}

// ============== Main ==============

async function main() {
  console.log('=== イベントスクレイピング開始 ===\n');
  
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
  await page.setViewport({ width: 1400, height: 900 });
  
  const allEvents = [];
  const today = new Date().toISOString().split('T')[0];
  
  for (const builder of BUILDERS) {
    console.log(`\n--- ${builder.name} ---`);
    
    if (!builder.eventsPageUrl) {
      console.log('  スキップ: イベントページURL未設定');
      continue;
    }
    
    let rawEvents = [];
    try {
      rawEvents = await scrapeGeneric(page, builder);
    } catch (e) {
      console.log(`  エラー: ${e.message.substring(0, 60)}`);
      continue;
    }
    
    console.log(`  取得: ${rawEvents.length}件の候補`);
    
    for (const raw of rawEvents) {
      if (raw.title === 'PAGE_CONTENT') {
        // Parse page content for event info
        const text = raw.meta;
        const dates = parseJpDates(text);
        if (!dates) continue;
        
        // Extract event-like sections from page text
        const lines = text.split('\n').filter(l => l.trim().length > 5);
        for (const line of lines) {
          const lineDates = parseJpDates(line);
          if (!lineDates) continue;
          
          const city = detectCity(line);
          if (!city) continue; // Only Mie events
          
          const type = detectType(line);
          const title = line.trim().substring(0, 100);
          
          const id = `${builder.id}-${lineDates.startDate}-${slugify(title).substring(0,20)}`;
          
          allEvents.push({
            id,
            builderId: builder.id,
            title: `${builder.name} ${title}`,
            type,
            startDate: lineDates.startDate,
            endDate: lineDates.endDate,
            startTime: '10:00',
            endTime: '17:00',
            city,
            location: `${detectCityLabel(line)}`,
            description: title,
            sourceUrl: raw.sourceUrl,
            sourceType: 'official',
            reservationRequired: line.includes('予約') || line.includes('要予約'),
            source: 'scraped'
          });
        }
        continue;
      }
      
      // Process individual event links
      const text = raw.title + ' ' + raw.meta;
      const dates = parseJpDates(text);
      const city = detectCity(text);
      
      if (!city) continue; // Only Mie prefecture events
      if (!dates) continue;
      
      // Skip past events
      if (dates.endDate < today) continue;
      
      const type = detectType(text);
      const id = `${builder.id}-${dates.startDate}-${slugify(raw.title).substring(0,20)}`;
      
      allEvents.push({
        id,
        builderId: builder.id,
        title: raw.title.substring(0, 100),
        type,
        startDate: dates.startDate,
        endDate: dates.endDate,
        startTime: '10:00',
        endTime: '17:00',
        city,
        location: detectCityLabel(text),
        description: raw.title,
        sourceUrl: raw.sourceUrl,
        sourceType: 'official',
        reservationRequired: text.includes('予約') || text.includes('要予約'),
        source: 'scraped'
      });
      
      console.log(`  ✓ ${raw.title.substring(0, 50)} (${dates.startDate}〜${dates.endDate}, ${detectCityLabel(text)})`);
    }
  }
  
  await browser.close();
  
  // Merge: keep manual events, replace scraped
  const existingPath = 'scripts/events-data.json';
  let manualEvents = [];
  if (existsSync(existingPath)) {
    const existing = JSON.parse(readFileSync(existingPath, 'utf8'));
    manualEvents = existing.events.filter(e => e.source === 'manual');
  }
  
  // Deduplicate scraped events
  const seen = new Set();
  const dedupedScraped = allEvents.filter(e => {
    const key = `${e.builderId}-${e.startDate}-${e.city}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  const merged = [...manualEvents, ...dedupedScraped];
  
  writeFileSync(existingPath, JSON.stringify({
    lastUpdated: today,
    events: merged
  }, null, 2) + '\n', 'utf8');
  
  console.log(`\n=== 完了 ===`);
  console.log(`手動イベント: ${manualEvents.length}件（保持）`);
  console.log(`スクレイピング: ${dedupedScraped.length}件（新規）`);
  console.log(`合計: ${merged.length}件`);
}

main().catch(console.error);
