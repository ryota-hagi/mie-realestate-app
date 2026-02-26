#!/usr/bin/env node
/**
 * fetch-mlit-data.mjs
 *
 * Fetches disaster & public-facility data from the MLIT Data Platform
 * (国土交通省データプラットフォーム) GraphQL API and outputs a structured
 * JSON file for use by build-pages.mjs.
 *
 * NOTE:  The MLIT search API ignores `attributeFilter` when `locationFilter`
 *        is also present.  To work around this we query by
 *        dataset_id + prefecture_code (AND filter, no location) and then
 *        post-filter results by bounding box in JS.
 *
 * Required env:  MLIT_API_KEY
 * Optional env:  MLIT_BASE_URL (default: https://data-platform.mlit.go.jp/api/v1/)
 *
 * Usage:
 *   MLIT_API_KEY=xxx node scripts/fetch-mlit-data.mjs
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API_URL =
  process.env.MLIT_BASE_URL || 'https://data-platform.mlit.go.jp/api/v1/';
const API_KEY = process.env.MLIT_API_KEY;

if (!API_KEY) {
  console.error('ERROR: MLIT_API_KEY environment variable is required.');
  console.error('  export MLIT_API_KEY=your_key_here');
  process.exit(1);
}

const PREF_CODE = 24; // 三重県

// ---------------------------------------------------------------------------
// Target cities — approximate city-centre coordinates
// ---------------------------------------------------------------------------
const CITIES = {
  yokkaichi: { name: '四日市市', lat: 34.965, lon: 136.625, code: '242021' },
  kuwana:    { name: '桑名市',   lat: 35.065, lon: 136.685, code: '242055' },
  suzuka:    { name: '鈴鹿市',   lat: 34.882, lon: 136.584, code: '242071' },
  inabe:     { name: 'いなべ市', lat: 35.115, lon: 136.560, code: '242144' },
  kameyama:  { name: '亀山市',   lat: 34.854, lon: 136.453, code: '242101' },
  komono:    { name: '菰野町',   lat: 35.015, lon: 136.520, code: '243418' },
  toin:      { name: '東員町',   lat: 35.078, lon: 136.610, code: '243248' },
};

const TARGET_CITY_NAMES = new Set(Object.values(CITIES).map((c) => c.name));

// Bounding box covering all 7 target cities (with margin)
const BBOX = {
  tl: { lat: 35.25, lon: 136.35 },
  br: { lat: 34.78, lon: 136.78 },
};

// Dataset IDs on the MLIT Data Platform
// NOTE: nlni_ksj-p17 (fire stations) has 0 records for Mie — excluded.
const DS = {
  flood:      'nlni_ksj-a31', // 洪水浸水想定区域
  evacuation: 'nlni_ksj-p20', // 避難施設
  school:     'nlni_ksj-p02', // 学校
  park:       'nlni_ksj-p29', // 都市公園
};

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _reqCount = 0;
async function gql(query) {
  _reqCount++;

  const doFetch = () =>
    fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        apikey: API_KEY,
      },
      body: JSON.stringify({ query }),
    });

  let res = await doFetch();

  // Simple retry on transient errors
  if (res.status === 429 || res.status >= 500) {
    console.warn(`  ⚠ HTTP ${res.status} — retrying in 3 s …`);
    await sleep(3000);
    res = await doFetch();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MLIT API ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// ---------------------------------------------------------------------------
// GraphQL filter builders
// ---------------------------------------------------------------------------

/** AND of dataset_id + prefecture_code (the reliable combination) */
function andFilter(datasetId) {
  return (
    '{ AND: [' +
    `{ attributeName: "DPF:dataset_id", is: "${datasetId}" }, ` +
    `{ attributeName: "DPF:prefecture_code", is: ${PREF_CODE} }` +
    '] }'
  );
}

/** Single dataset_id filter (used for flood query with term) */
function dsFilter(datasetId) {
  return `{ attributeName: "DPF:dataset_id", is: "${datasetId}" }`;
}

// ---------------------------------------------------------------------------
// Paginated search
// ---------------------------------------------------------------------------
async function searchAll({
  term,
  attributeFilter,
  fields = 'id title lat lon dataset_id',
  maxResults = 5000,
  label = '',
}) {
  const results = [];
  let first = 0;
  const size = 500;

  while (first < maxResults) {
    const parts = [
      `first: ${first}`,
      `size: ${size}`,
      'phraseMatch: true',
    ];
    if (term !== undefined) {
      parts.push(`term: "${term.replace(/"/g, '\\"')}"`);
    }
    if (attributeFilter) {
      parts.push(`attributeFilter: ${attributeFilter}`);
    }

    const q = `query { search(${parts.join(', ')}) { totalNumber searchResults { ${fields} } } }`;
    const data = await gql(q);
    const batch = data.search.searchResults || [];
    const total = data.search.totalNumber;
    results.push(...batch);

    console.log(`  [${label}] ${results.length} / ${total}`);
    if (batch.length < size || results.length >= total) break;
    first += size;
    await sleep(300); // rate limit
  }
  return results;
}

// ---------------------------------------------------------------------------
// Geo helpers
// ---------------------------------------------------------------------------
function nearestCity(lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const [id, c] of Object.entries(CITIES)) {
    const d = (lat - c.lat) ** 2 + (lon - c.lon) ** 2;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

function inBBox(lat, lon) {
  return (
    lat >= BBOX.br.lat &&
    lat <= BBOX.tl.lat &&
    lon >= BBOX.tl.lon &&
    lon <= BBOX.br.lon
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  MLIT DPF データ取得 (fetch-mlit-data.mjs)  ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ------------------------------------------------------------------
  // 1. 洪水浸水想定区域 — all of Mie prefecture
  // ------------------------------------------------------------------
  console.log('1/4  洪水浸水想定区域 …');
  const floodRaw = await searchAll({
    term: '三重',
    attributeFilter: dsFilter(DS.flood),
    fields: 'id title lat lon year dataset_id metadata',
    maxResults: 50,
    label: '洪水',
  });
  await sleep(300);

  const floodRivers = floodRaw
    .filter((r) => {
      const names = r.metadata?.['DPF:municipality_name'] || [];
      const hasTarget = names.some((n) => TARGET_CITY_NAMES.has(n));
      const inBox = inBBox(parseFloat(r.lat), parseFloat(r.lon));
      return hasTarget || inBox;
    })
    .map((r) => ({
      id: r.id,
      name: r.title,
      waterSystem: r.metadata?.['NLNI:water_system_name'] || '',
      riverType: r.metadata?.['NLNI:river_type'] || '',
      administrator: r.metadata?.['NLNI:administrator'] || '',
      administration: r.metadata?.['NLNI:administration'] || '',
      hasPlannedScale: (r.metadata?.['NLNI:data_type_1'] || '').includes('計画規模'),
      hasMaxScale: (r.metadata?.['NLNI:data_type_2'] || '').includes('想定最大規模'),
      dataUrl: r.metadata?.['DPF:dataURLs'] || '',
      municipalityNames: r.metadata?.['DPF:municipality_name'] || [],
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      year: r.year || '',
    }));

  console.log(`  → 北部三重 対象河川: ${floodRivers.length} 件\n`);

  // ------------------------------------------------------------------
  // 2-4. Facilities for Mie prefecture (no locationFilter)
  //      → post-filter by bounding box
  // ------------------------------------------------------------------
  const facilityTypes = [
    { key: 'evacuation', label: '避難施設', dsId: DS.evacuation, max: 5000 },
    { key: 'school',     label: '学校',     dsId: DS.school,     max: 5000 },
    { key: 'park',       label: '都市公園', dsId: DS.park,       max: 2000 },
  ];

  const rawByType = {};
  for (let i = 0; i < facilityTypes.length; i++) {
    const ft = facilityTypes[i];
    console.log(`${i + 2}/4  ${ft.label} (三重県全域 → 北部絞り込み) …`);

    const raw = await searchAll({
      term: '',
      attributeFilter: andFilter(ft.dsId),
      maxResults: ft.max,
      label: ft.label,
    });

    // Post-filter to northern Mie bounding box
    rawByType[ft.key] = raw.filter((item) =>
      inBBox(parseFloat(item.lat), parseFloat(item.lon)),
    );
    console.log(
      `  → 北部三重: ${rawByType[ft.key].length} 件 (県全体 ${raw.length})\n`,
    );

    if (i < facilityTypes.length - 1) await sleep(300);
  }

  // ------------------------------------------------------------------
  // Aggregate by city
  // ------------------------------------------------------------------
  console.log('集計中 …');
  const facilitiesByCity = {};
  for (const [id] of Object.entries(CITIES)) {
    facilitiesByCity[id] = {
      evacuationShelters: [],
      schools: [],
      parks: [],
    };
  }

  const bucketKey = {
    evacuation: 'evacuationShelters',
    school: 'schools',
    park: 'parks',
  };

  for (const [typeKey, items] of Object.entries(rawByType)) {
    for (const item of items) {
      const lat = parseFloat(item.lat);
      const lon = parseFloat(item.lon);
      const cityId = nearestCity(lat, lon);
      if (!cityId) continue;
      facilitiesByCity[cityId][bucketKey[typeKey]].push({
        name: item.title,
        lat,
        lon,
      });
    }
  }

  // ------------------------------------------------------------------
  // Build flood-risk per city
  // ------------------------------------------------------------------
  const floodByCity = {};
  for (const [id, c] of Object.entries(CITIES)) {
    const rivers = floodRivers.filter((r) =>
      r.municipalityNames.includes(c.name),
    );
    floodByCity[id] = {
      rivers: rivers.map((r) => r.name),
      riskLevel:
        rivers.length >= 2
          ? '高'
          : rivers.length === 1
            ? '中'
            : 'データなし',
    };
  }

  // ------------------------------------------------------------------
  // Build output JSON
  // ------------------------------------------------------------------
  const output = {
    lastUpdated: new Date().toISOString().split('T')[0],
    source: '国土交通省データプラットフォーム',
    license: 'CC BY 4.0',
    sourceUrl: 'https://www.mlit-data.jp/',
    attribution:
      '本データは国土交通省データプラットフォーム（CC BY 4.0）のデータを使用しています。',
    floodRivers,
    facilitiesByCity: {},
  };

  for (const [id, data] of Object.entries(facilitiesByCity)) {
    const c = CITIES[id];
    output.facilitiesByCity[id] = {
      name: c.name,
      floodRivers: floodByCity[id].rivers,
      floodRiskLevel: floodByCity[id].riskLevel,
      evacuationShelterCount: data.evacuationShelters.length,
      schoolCount: data.schools.length,
      parkCount: data.parks.length,
      // Full shelter list for Leaflet map markers
      shelterList: data.evacuationShelters,
    };
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------
  const outDir = join(ROOT, 'data');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const outPath = join(outDir, 'mlit-hazard.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  完了                                        ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`出力:   ${outPath}`);
  console.log(`API数:  ${_reqCount}`);
  console.log(`時間:   ${elapsed} s\n`);

  console.log('--- 洪水河川 ---');
  for (const r of floodRivers) {
    console.log(
      `  ${r.name} (${r.waterSystem}) — ${r.municipalityNames.join('・')}`,
    );
  }

  console.log('\n--- 市町村別施設数 ---');
  const header =
    '市町村'.padEnd(12) +
    '避難施設'.padStart(8) +
    '学校'.padStart(6) +
    '公園'.padStart(6) +
    '洪水河川'.padStart(12);
  console.log(header);
  console.log('-'.repeat(header.length + 8));
  for (const [, d] of Object.entries(output.facilitiesByCity)) {
    const rivers =
      d.floodRivers.length > 0 ? d.floodRivers.join('・') : 'データなし';
    console.log(
      d.name.padEnd(12) +
        String(d.evacuationShelterCount).padStart(8) +
        String(d.schoolCount).padStart(6) +
        String(d.parkCount).padStart(6) +
        `  ${rivers}`,
    );
  }
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message || err);
  process.exit(1);
});
