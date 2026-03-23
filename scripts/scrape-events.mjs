#!/usr/bin/env node
/**
 * 三重県ローカル工務店イベントスクレイパー
 * 対象: ハウスクラフト, サティスホーム, サンクスホーム, アサヒグローバル,
 *       大和住研, 善匠, アキュラホーム, クレバリーホーム
 * 大手HM（ダイワハウス・セキスイハイム・パナソニック・住友林業・一条・トヨタ・タマホーム）は対象外
 */
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ===== 三重県ローカル工務店のみ対象 =====
const LOCAL_BUILDER_IDS = [
  'house-craft', 'satis-home', 'thanks-home', 'asahi-global-home',
  'yamato-juken', 'zencho', 'aqura-home', 'cleverly-home'
];

const CITY_MAP = {
  '四日市': 'yokkaichi', '桑名': 'kuwana', '鈴鹿': 'suzuka',
  'いなべ': 'inabe', '亀山': 'kameyama', '菰野': 'komono', '東員': 'toin',
  '津市': 'tsu', '津 ': 'tsu', '松阪': 'matsusaka', '伊勢': 'ise',
  '名張': 'nabari', '伊賀': 'iga'
};

// 三重県の市名（三重県イベントかどうかの判定に使用）
const MIE_CITIES = ['四日市', '桑名', '鈴鹿', 'いなべ', '亀山', '菰野', '東員',
  '津市', '松阪', '伊勢', '名張', '伊賀', '三重県', '三重'];

function isMieEvent(text) {
  return MIE_CITIES.some(c => text.includes(c));
}

function detectCity(text) {
  for (const [key, val] of Object.entries(CITY_MAP)) {
    if (text.includes(key)) return val;
  }
  return null;
}

function detectCityLabel(text) {
  for (const key of Object.keys(CITY_MAP)) {
    if (text.includes(key)) return key.replace(/\s/g, '');
  }
  return '';
}

function detectType(text) {
  if (text.includes('完成見学') || text.includes('オープンハウス') || text.includes('内覧')) return 'open-house';
  if (text.includes('モデルハウス') || text.includes('展示場')) return 'model-home';
  if (text.includes('セミナー') || text.includes('勉強会') || text.includes('教室')) return 'seminar';
  if (text.includes('キャンペーン') || text.includes('フェア') || text.includes('特典') || text.includes('販売会')) return 'campaign';
  if (text.includes('相談会') || text.includes('相談')) return 'consultation';
  if (text.includes('見学会') || text.includes('見学')) return 'open-house';
  return 'other';
}

function parseJpDates(text) {
  const year = new Date().getFullYear();

  // "2026年3月20日" or "2026.3.20"
  const fullMatch = text.match(/(\d{4})[年./](\d{1,2})[月./](\d{1,2})/);

  // サティスホーム形式: "03/20 fri 03/29 sun" or "01/16 fri 01/18 sun"
  const satisRange = text.match(/(\d{2})\/(\d{2})\s+\w{3}\s+(\d{2})\/(\d{2})\s+\w{3}/);
  if (satisRange) {
    const start = `${year}-${satisRange[1]}-${satisRange[2]}`;
    const end = `${year}-${satisRange[3]}-${satisRange[4]}`;
    return { startDate: start, endDate: end };
  }

  // 善匠形式: "2026.3.21-22" or "2026.3.28-4.5" (年付き範囲)
  const zenshoRange = text.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})\s*[-\-]\s*(?:(\d{1,2})\.)?(\d{1,2})/);
  if (zenshoRange) {
    const y = zenshoRange[1];
    const sm = zenshoRange[2].padStart(2, '0');
    const sd = zenshoRange[3].padStart(2, '0');
    const em = zenshoRange[4] ? zenshoRange[4].padStart(2, '0') : sm;
    const ed = zenshoRange[5].padStart(2, '0');
    return { startDate: `${y}-${sm}-${sd}`, endDate: `${y}-${em}-${ed}` };
  }

  // Range: "3/20～4/30", "3.20-4.30", "3/20(金)〜4/30(木)"
  const rangeMatch = text.match(/(\d{1,2})[/.．月](\d{1,2})[\s\S]{0,20}?[～〜\-\–―][\s\S]{0,20}?(\d{1,2})[/.．月](\d{1,2})/);
  if (rangeMatch) {
    const sy = fullMatch ? parseInt(fullMatch[1]) : year;
    const start = `${sy}-${rangeMatch[1].padStart(2,'0')}-${rangeMatch[2].padStart(2,'0')}`;
    const end = `${sy}-${rangeMatch[3].padStart(2,'0')}-${rangeMatch[4].padStart(2,'0')}`;
    return { startDate: start, endDate: end };
  }

  // サンクスホーム形式: "【3/14-15】" (同月内)
  const sameMonthRange = text.match(/(\d{1,2})\/(\d{1,2})\s*[-\-]\s*(\d{1,2})/);
  if (sameMonthRange && parseInt(sameMonthRange[3]) < 32) {
    const m = sameMonthRange[1].padStart(2, '0');
    const start = `${year}-${m}-${sameMonthRange[2].padStart(2,'0')}`;
    const end = `${year}-${m}-${sameMonthRange[3].padStart(2,'0')}`;
    return { startDate: start, endDate: end };
  }

  // Single date: "3/20" or "2026年3月20日"
  if (fullMatch) {
    const d = `${fullMatch[1]}-${fullMatch[2].padStart(2,'0')}-${fullMatch[3].padStart(2,'0')}`;
    return { startDate: d, endDate: d };
  }
  const single = text.match(/(\d{1,2})[/.．月](\d{1,2})/);
  if (single) {
    const d = `${year}-${single[1].padStart(2,'0')}-${single[2].padStart(2,'0')}`;
    return { startDate: d, endDate: d };
  }

  return null;
}

function parseTime(text) {
  const m = text.match(/(\d{1,2})[：:](\d{2})\s*[～〜\-]\s*(\d{1,2})[：:](\d{2})/);
  if (m) return { startTime: `${m[1].padStart(2,'0')}:${m[2]}`, endTime: `${m[3].padStart(2,'0')}:${m[4]}` };
  return { startTime: '10:00', endTime: '17:00' };
}

function slugify(text) {
  return text.replace(/[^a-zA-Z0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '-').substring(0, 30).toLowerCase();
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// ===================================================================
//  各社専用スクレイパー
// ===================================================================

/** ハウスクラフト - カードリンク方式 */
async function scrapeHouseCraft(page) {
  await page.goto('https://www.house-craft.jp/events/', { waitUntil: 'networkidle2', timeout: 25000 });
  await wait(2000);
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/events/"]').forEach(a => {
      const href = a.href;
      if (seen.has(href) || href === location.href || href.includes('events_category')) return;
      seen.add(href);
      const card = a.closest('article, .card, li, div') || a;
      const title = (card.querySelector('h2, h3, .title, .ttl')?.textContent || a.textContent || '').trim();
      if (title.length > 5) {
        results.push({ title, meta: (card.textContent || '').replace(/\s+/g, ' ').substring(0, 500), sourceUrl: href });
      }
    });
    return results;
  });
}

/** サティスホーム - .event-item カード
 *  セレクタ: h2.item-ttl, .date-start/.date-end, .item-place dd, .event-finished
 */
async function scrapeSatisHome(page) {
  await page.goto('https://satishome.com/event/', { waitUntil: 'networkidle2', timeout: 25000 });
  await wait(2000);
  return page.evaluate(() => {
    const results = [];
    document.querySelectorAll('.event-item').forEach(card => {
      // 終了イベントはスキップ
      if (card.querySelector('.event-finished')) return;
      const linkEl = card.querySelector('a.item-link') || card.querySelector('a[href]');
      const href = linkEl?.href || '';
      if (!href) return;
      const title = (card.querySelector('h2.item-ttl')?.textContent || '').trim();
      const category = (card.querySelector('.item-cate span')?.textContent || '').trim();
      const dateStart = (card.querySelector('.date-start')?.textContent || '').trim();
      const dateEnd = (card.querySelector('.date-end')?.textContent || '').trim();
      const place = (card.querySelector('.item-place dd')?.textContent || '').trim();
      const time = (card.querySelector('.item-schedule li:nth-child(2)')?.textContent || '').trim();
      const meta = [category, title, dateStart, dateEnd, time, place].join(' ');
      if (title.length > 3 || category.length > 0) {
        results.push({ title: (category + ' ' + title).trim().substring(0, 150), meta, sourceUrl: href });
      }
    });
    return results;
  });
}

/** サンクスホーム - WordPress構造 article.work-archive-box
 *  セレクタ: h2.work-archive-box--title, span.work-archive-box--time, a.div-link
 *  エリアフィルタURL: /event_area/yokkaichi/ 等
 */
async function scrapeThanksHome(page) {
  const results = [];
  // 三重県エリア別 + 全体ページをスクレイプ
  const urls = [
    'https://sunkushome.jp/event-post/',
    'https://sunkushome.jp/event_cat/%E8%A6%8B%E5%AD%A6%E4%BC%9A/',
    'https://sunkushome.jp/event_cat/%E7%9B%B8%E8%AB%87%E4%BC%9A/',
    'https://sunkushome.jp/event_cat/%E3%82%AD%E3%83%A3%E3%83%B3%E3%83%9A%E3%83%BC%E3%83%B3/',
  ];

  const seen = new Set();
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      await wait(2000);
      const pageResults = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('article.work-archive-box, article.event-post-archive-box').forEach(card => {
          const title = (card.querySelector('h2.work-archive-box--title')?.textContent || '').trim();
          const dateEl = card.querySelector('span.work-archive-box--time');
          const dateText = dateEl ? dateEl.textContent.replace('開催日：', '').trim() : '';
          const link = card.querySelector('a.div-link')?.href || card.querySelector('a[href]')?.href || '';
          const tags = Array.from(card.querySelectorAll('.work-archive-box-tag em')).map(e => e.textContent.trim());
          if (title.length > 3) {
            items.push({
              title,
              meta: [title, dateText, ...tags].join(' '),
              sourceUrl: link || window.location.href
            });
          }
        });
        return items;
      });
      for (const r of pageResults) {
        if (!seen.has(r.sourceUrl)) {
          seen.add(r.sourceUrl);
          results.push(r);
        }
      }
    } catch (e) { /* skip */ }
  }
  return results;
}

/** アサヒグローバルホーム - article カード */
async function scrapeAsahiGlobal(page) {
  await page.goto('https://asahigloval.co.jp/event/', { waitUntil: 'networkidle2', timeout: 25000 });
  await wait(2000);
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();
    // Main event articles
    document.querySelectorAll('article, .e-box-item, [class*="event"]').forEach(card => {
      const linkEl = card.querySelector('a[href*="/event"]') || card.querySelector('a[href]');
      const href = linkEl?.href || '';
      if (!href || seen.has(href) || href === location.href) return;
      seen.add(href);
      const title = (card.querySelector('h2, h3, .title, .ttl')?.textContent || linkEl?.textContent || '').trim();
      const meta = (card.textContent || '').replace(/\s+/g, ' ').substring(0, 500);
      if (title.length > 5) {
        results.push({ title, meta, sourceUrl: href });
      }
    });
    // Also get direct event links
    document.querySelectorAll('a[href*="/event/"]').forEach(a => {
      const href = a.href;
      if (seen.has(href) || href === location.href) return;
      seen.add(href);
      const text = a.textContent.trim();
      if (text.length > 10) {
        const card = a.closest('div, li') || a;
        results.push({ title: text.substring(0, 120), meta: (card.textContent || '').replace(/\s+/g, ' ').substring(0, 500), sourceUrl: href });
      }
    });
    return results;
  });
}

/** ヤマト住建 - 三重県ページに直接アクセス */
async function scrapeYamatoJuken(page) {
  // 三重県専用ページがある
  await page.goto('https://www.yamatojk.co.jp/event_cat/mie', { waitUntil: 'networkidle2', timeout: 20000 });
  await wait(2000);
  return page.evaluate(() => {
    const items = [];
    const seen = new Set();
    // イベントカード or 記事リンクを取得
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      const text = a.textContent.trim().replace(/\s+/g, ' ');
      if (seen.has(href) || text.length < 10 || text.length > 300) return;
      // イベント個別ページ or 展示場ページ
      if (!href.includes('/event/') && !href.includes('/ex-construction/')) return;
      if (href.includes('/event_cat/')) return; // カテゴリページはスキップ
      seen.add(href);
      const card = a.closest('article, .card, li, div') || a;
      const meta = (card.textContent || '').replace(/\s+/g, ' ').substring(0, 500);
      items.push({ title: text.substring(0, 150), meta, sourceUrl: href });
    });
    return items;
  });
}

/** 善匠 - イベントカード */
async function scrapeZensho(page) {
  await page.goto('https://www.zenshoo.com/event/', { waitUntil: 'networkidle2', timeout: 25000 });
  await wait(2000);
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();
    document.querySelectorAll('[class*="event"], article, .card').forEach(card => {
      const linkEl = card.querySelector('a[href*="/event"]') || card.querySelector('a[href]');
      const href = linkEl?.href || '';
      if (!href || seen.has(href) || href === location.href) return;
      seen.add(href);
      const title = (card.querySelector('h2, h3, .title, .ttl')?.textContent || linkEl?.textContent || '').trim();
      const meta = (card.textContent || '').replace(/\s+/g, ' ').substring(0, 500);
      if (title.length > 5) {
        results.push({ title, meta, sourceUrl: href });
      }
    });
    return results;
  });
}

/** アキュラホーム - /modelhouse/event/ のevents_itemカード
 *  セレクタ: div.events_item, p.events_name, p.events_date, p.events_place
 */
async function scrapeAquraHome(page) {
  await page.goto('https://www.aqura.co.jp/modelhouse/event/', { waitUntil: 'networkidle2', timeout: 25000 });
  await wait(2000);
  return page.evaluate(() => {
    const items = [];
    document.querySelectorAll('.events_item, div.events_item').forEach(card => {
      const linkEl = card.querySelector('a.events_itemInner') || card.querySelector('a[href]');
      const href = linkEl?.href || '';
      const title = (card.querySelector('p.events_name')?.textContent || '').trim();
      const date = (card.querySelector('p.events_date')?.textContent || '').trim();
      const place = (card.querySelector('p.events_place')?.textContent || '').trim();
      const label = (card.querySelector('p.events_label')?.textContent || '').trim();
      if (title.length > 3) {
        items.push({
          title: title.substring(0, 120),
          meta: [label, title, date, place].join(' '),
          sourceUrl: href ? (href.startsWith('http') ? href : 'https://www.aqura.co.jp' + href) : 'https://www.aqura.co.jp/modelhouse/event/'
        });
      }
    });
    return items;
  });
}

/** クレバリーホーム - エリア別マップ方式 */
async function scrapeCleverlyHome(page) {
  // Try Mie/Chubu area event page
  const urls = [
    'https://www.cleverlyhome.com/cleverlyhome/event/#c-area__chubuMap',
    'https://www.cleverlyhome.com/cleverlyhome/event/'
  ];
  const results = [];
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      await wait(2000);
      // Try to click on Chubu/Tokai area
      await page.evaluate(() => {
        document.querySelectorAll('a, button').forEach(el => {
          const text = el.textContent || '';
          if (text.includes('中部') || text.includes('東海') || text.includes('三重')) {
            el.click();
          }
        });
      });
      await wait(2000);
      const pageResults = await page.evaluate(() => {
        const items = [];
        const seen = new Set();
        document.querySelectorAll('a[href]').forEach(a => {
          const text = a.textContent.trim();
          const href = a.href;
          if (seen.has(href) || text.length < 10 || text.length > 300) return;
          const hasKeyword = ['見学', '相談', 'モデル', 'イベント', 'フェア', '展示', '三重']
            .some(k => text.includes(k));
          if (!hasKeyword) return;
          seen.add(href);
          const card = a.closest('article, div, li') || a;
          items.push({
            title: text.substring(0, 120),
            meta: (card.textContent || '').replace(/\s+/g, ' ').substring(0, 500),
            sourceUrl: href
          });
        });
        return items;
      });
      results.push(...pageResults);
    } catch (e) { /* continue */ }
  }
  return results;
}

// ===================================================================
//  スクレイパー登録
// ===================================================================

const SCRAPERS = {
  'house-craft':       scrapeHouseCraft,
  'satis-home':        scrapeSatisHome,
  'thanks-home':       scrapeThanksHome,
  'asahi-global-home': scrapeAsahiGlobal,
  'yamato-juken':      scrapeYamatoJuken,
  'zencho':            scrapeZensho,
  'aqura-home':        scrapeAquraHome,
  'cleverly-home':     scrapeCleverlyHome,
};

// ===================================================================
//  メイン処理
// ===================================================================

async function main() {
  console.log('=== 三重県ローカル工務店イベントスクレイピング ===');
  console.log(`対象: ${LOCAL_BUILDER_IDS.length}社\n`);

  const buildersData = JSON.parse(readFileSync('scripts/builders-data.json', 'utf8')).builders;
  const today = new Date().toISOString().split('T')[0];

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1400, height: 900 });

  const allEvents = [];

  for (const builderId of LOCAL_BUILDER_IDS) {
    const builder = Object.values(buildersData).find(b => b.id === builderId);
    if (!builder) { console.log(`⚠️ ${builderId}: builders-data.jsonに未登録`); continue; }

    console.log(`\n--- ${builder.name} (${builderId}) ---`);

    const scraper = SCRAPERS[builderId];
    if (!scraper) { console.log('  スキップ: スクレイパー未定義'); continue; }

    let rawEvents = [];
    try {
      rawEvents = await scraper(page, builder);
    } catch (e) {
      console.log(`  エラー: ${e.message.substring(0, 80)}`);
      continue;
    }

    console.log(`  候補: ${rawEvents.length}件`);

    let matched = 0;
    for (const raw of rawEvents) {
      if (raw.title === 'PAGE_CONTENT') continue; // Skip fallback content

      const text = raw.title + ' ' + raw.meta;

      // 広域展開ビルダーは三重県のイベントのみ抽出
      const needsMieFilter = ['yamato-juken', 'aqura-home', 'cleverly-home', 'zencho'];
      if (needsMieFilter.includes(builderId) && !isMieEvent(text)) {
        console.log(`    スキップ(三重県外): ${raw.title.substring(0, 40)}`);
        continue;
      }

      const dates = parseJpDates(text);
      if (!dates) continue;

      // 過去イベントスキップ
      if (dates.endDate < today) continue;

      const city = detectCity(text);
      const type = detectType(text);
      const times = parseTime(text);
      const id = `${builderId}-${dates.startDate}-${slugify(raw.title).substring(0, 20)}`;

      allEvents.push({
        id,
        builderId,
        title: raw.title.substring(0, 120),
        type,
        startDate: dates.startDate,
        endDate: dates.endDate,
        startTime: times.startTime,
        endTime: times.endTime,
        city: city || 'other',
        location: detectCityLabel(text) || '',
        description: raw.title,
        url: raw.sourceUrl,
        reservationRequired: text.includes('予約') || text.includes('要予約') || text.includes('予約制'),
        source: 'scraped'
      });
      matched++;
      console.log(`  ✓ ${raw.title.substring(0, 60)}`);
      console.log(`    ${dates.startDate}〜${dates.endDate} | ${detectCityLabel(text) || '場所未特定'} | ${type}`);
    }
    console.log(`  → ${matched}件のイベントを抽出`);
  }

  await browser.close();

  // マージ: 手動イベントを保持、スクレイプ分は置換
  const existingPath = 'scripts/events-data.json';
  let manualEvents = [];
  if (existsSync(existingPath)) {
    const existing = JSON.parse(readFileSync(existingPath, 'utf8'));
    manualEvents = existing.events.filter(e => e.source === 'manual');
  }

  // 重複排除
  const seen = new Set();
  const dedupedScraped = allEvents.filter(e => {
    const key = `${e.builderId}-${e.startDate}-${e.city}-${e.type}`;
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
  console.log(`スクレイピング: ${dedupedScraped.length}件（新規取得）`);
  console.log(`合計: ${merged.length}件`);
  console.log(`保存先: ${existingPath}`);
}

main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
