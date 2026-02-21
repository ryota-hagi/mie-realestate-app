#!/usr/bin/env node
/**
 * build-pages.mjs
 *
 * Generates:
 *   area/mie/index.html           - Hub page (enhanced area.html)
 *   area/mie/{city}/index.html    - City pages × 7
 *   knowledge/{id}/index.html     - Knowledge articles × N
 *   knowledge/index.html          - Knowledge hub page
 *   sitemap.xml                   - Auto-generated sitemap
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { minify } from 'terser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------
const cityData = JSON.parse(readFileSync(join(ROOT, 'scripts/city-data.json'), 'utf-8'));
const knowledgeData = JSON.parse(readFileSync(join(ROOT, 'scripts/knowledge-data.json'), 'utf-8'));
const areaHtml = readFileSync(join(ROOT, 'scripts/area-template.html'), 'utf-8');

const DOMAIN = 'https://research.chuumon-soudan.com';
const TODAY = new Date().toISOString().split('T')[0];

const CITIES = [
  { id: 'yokkaichi', name: '四日市市' },
  { id: 'kuwana',    name: '桑名市' },
  { id: 'suzuka',    name: '鈴鹿市' },
  { id: 'inabe',     name: 'いなべ市' },
  { id: 'kameyama',  name: '亀山市' },
  { id: 'komono',    name: '菰野町' },
  { id: 'toin',      name: '東員町' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Cost Simulator HTML (rendered as a section)
// ---------------------------------------------------------------------------
function buildCostSimulatorHtml(cityId) {
  // If cityId is null, show an area selector; otherwise lock to the city
  const areaSelector = cityId
    ? `<input type="hidden" id="cs-area" value="${cityId}">`
    : `<div>
        <label class="text-sm font-medium text-gray-700">エリア選択</label>
        <select id="cs-area" class="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm" onchange="csCalc()">
          ${CITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
        </select>
      </div>`;

  return `
    <div class="card p-6 mb-6" id="cost-simulator">
      <h2 class="text-lg font-bold text-gray-800 mb-1">💰 注文住宅 費用シミュレーター</h2>
      <p class="text-xs text-gray-500 mb-4">スライダーを動かすと即時に再計算されます。土地価格は国土交通省の実取引データに基づく坪単価を使用しています。</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        ${areaSelector}
        <div>
          <label class="text-sm font-medium text-gray-700">土地面積: <span id="cs-land-val">50</span>坪</label>
          <input type="range" id="cs-land" min="30" max="100" value="50" step="5" class="w-full cursor-pointer mt-1" oninput="csCalc()" style="background:linear-gradient(to right,#3b82f6 0%,#3b82f6 29%,#e5e7eb 29%,#e5e7eb 100%)">
          <div class="flex justify-between text-xs text-gray-400"><span>30坪</span><span>100坪</span></div>
        </div>
        <div>
          <label class="text-sm font-medium text-gray-700">建物延床面積: <span id="cs-building-val">35</span>坪</label>
          <input type="range" id="cs-building" min="20" max="60" value="35" step="1" class="w-full cursor-pointer mt-1" oninput="csCalc()" style="background:linear-gradient(to right,#3b82f6 0%,#3b82f6 38%,#e5e7eb 38%,#e5e7eb 100%)">
          <div class="flex justify-between text-xs text-gray-400"><span>20坪</span><span>60坪</span></div>
        </div>
        <div>
          <label class="text-sm font-medium text-gray-700">建築グレード</label>
          <div class="flex gap-2 mt-1">
            <label class="flex-1 text-center px-2 py-2 border rounded-lg cursor-pointer text-xs transition-all" id="cs-grade-low-label">
              <input type="radio" name="cs-grade" value="50" class="hidden" onchange="csCalc()"> ローコスト<br><span class="font-bold">50万/坪</span>
            </label>
            <label class="flex-1 text-center px-2 py-2 border rounded-lg cursor-pointer text-xs transition-all border-blue-500 bg-blue-50" id="cs-grade-std-label">
              <input type="radio" name="cs-grade" value="65" class="hidden" checked onchange="csCalc()"> スタンダード<br><span class="font-bold">65万/坪</span>
            </label>
            <label class="flex-1 text-center px-2 py-2 border rounded-lg cursor-pointer text-xs transition-all" id="cs-grade-hi-label">
              <input type="radio" name="cs-grade" value="85" class="hidden" onchange="csCalc()"> ハイグレード<br><span class="font-bold">85万/坪</span>
            </label>
          </div>
        </div>
        <div>
          <label class="text-sm font-medium text-gray-700">頭金: <span id="cs-down-val">300</span>万円</label>
          <input type="range" id="cs-down" min="0" max="2000" value="300" step="50" class="w-full cursor-pointer mt-1" oninput="csCalc()" style="background:linear-gradient(to right,#10b981 0%,#10b981 15%,#e5e7eb 15%,#e5e7eb 100%)">
          <div class="flex justify-between text-xs text-gray-400"><span>0万</span><span>2,000万</span></div>
        </div>
        <div>
          <label class="text-sm font-medium text-gray-700">金利: <span id="cs-rate-val">0.80</span>%</label>
          <input type="range" id="cs-rate" min="0.3" max="3.0" value="0.8" step="0.05" class="w-full cursor-pointer mt-1" oninput="csCalc()">
          <div class="flex justify-between text-xs text-gray-400"><span>0.3%</span><span>3.0%</span></div>
        </div>
        <div>
          <label class="text-sm font-medium text-gray-700">ローン期間: <span id="cs-years-val">35</span>年</label>
          <input type="range" id="cs-years" min="20" max="40" value="35" step="1" class="w-full cursor-pointer mt-1" oninput="csCalc()">
          <div class="flex justify-between text-xs text-gray-400"><span>20年</span><span>40年</span></div>
        </div>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3" id="cs-results">
        <div class="bg-blue-50 rounded-lg p-3 text-center">
          <div class="text-xs text-gray-500">土地購入費</div>
          <div class="text-lg font-bold text-blue-700" id="cs-land-cost">-</div>
        </div>
        <div class="bg-green-50 rounded-lg p-3 text-center">
          <div class="text-xs text-gray-500">建築費</div>
          <div class="text-lg font-bold text-green-700" id="cs-build-cost">-</div>
        </div>
        <div class="bg-amber-50 rounded-lg p-3 text-center">
          <div class="text-xs text-gray-500">諸費用</div>
          <div class="text-lg font-bold text-amber-700" id="cs-misc-cost">-</div>
        </div>
        <div class="bg-purple-50 rounded-lg p-3 text-center">
          <div class="text-xs text-gray-500 font-medium">総額</div>
          <div class="text-xl font-bold text-gray-900" id="cs-total">-</div>
        </div>
      </div>
      <div class="bg-gray-50 rounded-lg p-3 text-center">
        <span class="text-xs text-gray-500">月々返済額（元利均等）</span>
        <span class="text-lg font-bold text-blue-600 ml-2" id="cs-monthly">-</span>
      </div>
    </div>`;
}

// Cost simulator JS (to be added once per page)
function buildCostSimulatorScript() {
  return `
// === Cost Simulator ===
function csCalc() {
  const areaEl = document.getElementById('cs-area');
  if (!areaEl) return;
  const areaId = areaEl.value;
  const area = AREAS.find(a => a.id === areaId);
  if (!area) return;

  const landTsubo = parseInt(document.getElementById('cs-land').value);
  const buildTsubo = parseInt(document.getElementById('cs-building').value);
  const gradeEl = document.querySelector('input[name="cs-grade"]:checked');
  const grade = gradeEl ? parseInt(gradeEl.value) : 65;
  const downPayment = parseInt(document.getElementById('cs-down').value);
  const rate = parseFloat(document.getElementById('cs-rate').value);
  const years = parseInt(document.getElementById('cs-years').value);

  // Update display values
  document.getElementById('cs-land-val').textContent = landTsubo;
  document.getElementById('cs-building-val').textContent = buildTsubo;
  document.getElementById('cs-down-val').textContent = downPayment;
  document.getElementById('cs-rate-val').textContent = rate.toFixed(2);
  document.getElementById('cs-years-val').textContent = years;

  // Slider backgrounds
  const landPct = ((landTsubo - 30) / 70 * 100);
  document.getElementById('cs-land').style.background = 'linear-gradient(to right,#3b82f6 0%,#3b82f6 ' + landPct + '%,#e5e7eb ' + landPct + '%,#e5e7eb 100%)';
  const buildPct = ((buildTsubo - 20) / 40 * 100);
  document.getElementById('cs-building').style.background = 'linear-gradient(to right,#3b82f6 0%,#3b82f6 ' + buildPct + '%,#e5e7eb ' + buildPct + '%,#e5e7eb 100%)';
  const downPct = (downPayment / 2000 * 100);
  document.getElementById('cs-down').style.background = 'linear-gradient(to right,#10b981 0%,#10b981 ' + downPct + '%,#e5e7eb ' + downPct + '%,#e5e7eb 100%)';

  // Grade radio styling
  document.querySelectorAll('[id^="cs-grade-"]').forEach(el => { el.className = el.className.replace(/border-blue-500 bg-blue-50/g, '').trim(); });
  const gradeMap = { '50': 'cs-grade-low-label', '65': 'cs-grade-std-label', '85': 'cs-grade-hi-label' };
  const activeLabel = document.getElementById(gradeMap[String(grade)]);
  if (activeLabel) activeLabel.className += ' border-blue-500 bg-blue-50';

  // Calculations
  const tsuboPrice = area.pricePerTsubo; // yen per tsubo
  const landCost = landTsubo * tsuboPrice;
  const buildCost = buildTsubo * grade * 10000;
  const miscCost = Math.round((landCost + buildCost) * 0.08); // 8% misc costs
  const total = landCost + buildCost + miscCost;
  const loanAmount = Math.max(0, total - downPayment * 10000);

  // Monthly payment (equal principal and interest)
  let monthly = 0;
  if (loanAmount > 0 && rate > 0) {
    const r = rate / 100 / 12;
    const n = years * 12;
    monthly = Math.round(loanAmount * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1));
  } else if (loanAmount > 0) {
    monthly = Math.round(loanAmount / (years * 12));
  }

  function fmtMan(yen) {
    const man = Math.round(yen / 10000);
    if (man >= 10000) return (man / 10000).toFixed(1) + '億';
    return man.toLocaleString() + '万円';
  }

  document.getElementById('cs-land-cost').textContent = fmtMan(landCost);
  document.getElementById('cs-build-cost').textContent = fmtMan(buildCost);
  document.getElementById('cs-misc-cost').textContent = fmtMan(miscCost);
  document.getElementById('cs-total').textContent = fmtMan(total);
  document.getElementById('cs-monthly').textContent = monthly > 0 ? monthly.toLocaleString() + '円' : '-';
}
// Run on load
document.addEventListener('DOMContentLoaded', function() { setTimeout(csCalc, 100); });
`;
}

// ---------------------------------------------------------------------------
// Checklist HTML
// ---------------------------------------------------------------------------
function buildChecklistHtml(cityId) {
  const items = cityData.checklist;
  const cd = cityData[cityId];
  return `
    <div class="card p-6 mb-6" id="land-checklist">
      <h2 class="text-lg font-bold text-gray-800 mb-1">✅ 土地購入前チェックリスト</h2>
      <p class="text-xs text-gray-500 mb-2">チェック状態はブラウザに自動保存されます</p>
      ${cd && cd.checklist_notes ? `<div class="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3 text-sm text-amber-800">💡 ${escHtml(cd.checklist_notes)}</div>` : ''}
      <div class="text-sm font-medium text-blue-600 mb-3" id="cl-progress">0/10 完了</div>
      <div class="space-y-2" id="cl-items">
        ${items.map(item => `
          <label class="flex items-start gap-3 p-3 rounded-lg border border-gray-100 hover:bg-blue-50 cursor-pointer transition-colors" data-cl-id="${item.id}">
            <input type="checkbox" class="mt-1 w-4 h-4 rounded border-gray-300 text-blue-600 cursor-pointer" data-cl-check="${item.id}" onchange="clUpdate('${cityId}')">
            <div>
              <div class="text-sm font-medium text-gray-800">${escHtml(item.label)}</div>
              <div class="text-xs text-gray-500 mt-0.5">${escHtml(item.detail)}</div>
            </div>
          </label>
        `).join('')}
      </div>
    </div>`;
}

function buildChecklistScript() {
  return `
// === Checklist (localStorage) ===
function clUpdate(cityId) {
  const checks = {};
  document.querySelectorAll('[data-cl-check]').forEach(cb => { checks[cb.dataset.clCheck] = cb.checked; });
  localStorage.setItem('cl_' + cityId, JSON.stringify(checks));
  const done = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  const el = document.getElementById('cl-progress');
  if (el) el.textContent = done + '/' + total + ' 完了';
}
function clRestore(cityId) {
  try {
    const saved = JSON.parse(localStorage.getItem('cl_' + cityId) || '{}');
    let done = 0, total = 0;
    document.querySelectorAll('[data-cl-check]').forEach(cb => {
      total++;
      if (saved[cb.dataset.clCheck]) { cb.checked = true; done++; }
    });
    const el = document.getElementById('cl-progress');
    if (el) el.textContent = done + '/' + total + ' 完了';
  } catch {}
}
`;
}

// ---------------------------------------------------------------------------
// FAQ HTML + JSON-LD
// ---------------------------------------------------------------------------
function buildFaqHtml(cityId) {
  const cd = cityData[cityId];
  if (!cd || !cd.faqs || cd.faqs.length === 0) return '';

  const faqItems = cd.faqs.map((faq, i) => `
    <div class="border border-gray-200 rounded-lg overflow-hidden">
      <button class="w-full text-left px-4 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors" onclick="this.parentElement.classList.toggle('faq-open')">
        <span class="text-sm font-medium text-gray-800">${escHtml(faq.question)}</span>
        <svg class="w-5 h-5 text-gray-400 faq-chevron transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
      </button>
      <div class="faq-answer px-4 py-3 text-sm text-gray-600 leading-relaxed border-t border-gray-100">${escHtml(faq.answer)}</div>
    </div>
  `).join('');

  return `
    <div class="card p-6 mb-6" id="faq-section">
      <h2 class="text-lg font-bold text-gray-800 mb-4">❓ よくある質問（${cd.nameJa}の注文住宅）</h2>
      <div class="space-y-2">${faqItems}</div>
    </div>`;
}

function buildFaqJsonLd(cityId) {
  const cd = cityData[cityId];
  if (!cd || !cd.faqs || cd.faqs.length === 0) return '';

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: cd.faqs.map(faq => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer
      }
    }))
  };

  return `<script type="application/ld+json">${JSON.stringify(faqSchema)}</script>`;
}

// ---------------------------------------------------------------------------
// Tips (info boxes)
// ---------------------------------------------------------------------------
function buildTipsHtml(cityId) {
  const cd = cityData[cityId];
  if (!cd || !cd.tips || cd.tips.length === 0) return '';

  return cd.tips.map(tip => `
    <div class="bg-blue-50 border border-blue-200 rounded-xl p-5 mb-4">
      <h3 class="text-sm font-bold text-blue-700 mb-2">🏠 注文住宅ワンポイント: ${escHtml(tip.title)}</h3>
      <p class="text-sm text-blue-900 leading-relaxed">${escHtml(tip.body)}</p>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// Breadcrumb HTML + JSON-LD
// ---------------------------------------------------------------------------
function buildBreadcrumbHtml(items) {
  const links = items.map((item, i) => {
    if (i === items.length - 1) {
      return `<span class="text-sm text-gray-600">${escHtml(item.name)}</span>`;
    }
    return `<a href="${item.url}" class="text-sm text-blue-600 hover:underline">${escHtml(item.name)}</a>`;
  });
  return `<nav class="flex items-center gap-1 flex-wrap px-4 py-2 text-xs text-gray-400" aria-label="パンくずリスト">${links.join(' <span class="mx-1">/</span> ')}</nav>`;
}

function buildBreadcrumbJsonLd(items) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url.startsWith('http') ? item.url : DOMAIN + item.url
    }))
  };
  return `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
}

// ---------------------------------------------------------------------------
// Tooltip CSS + JS
// ---------------------------------------------------------------------------
function buildTooltipCss() {
  return `
  .tip-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; background: #dbeafe; color: #2563eb; font-size: 10px; font-weight: 700; cursor: help; position: relative; margin-left: 4px; vertical-align: middle; }
  .tip-icon:hover .tip-body, .tip-icon:focus .tip-body { display: block; }
  .tip-body { display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); width: 260px; padding: 8px 12px; background: #1e293b; color: #f1f5f9; font-size: 12px; line-height: 1.5; border-radius: 8px; z-index: 50; font-weight: 400; box-shadow: 0 4px 12px rgba(0,0,0,0.15); pointer-events: none; }
  .tip-body::after { content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%); border: 5px solid transparent; border-top-color: #1e293b; }
  /* FAQ accordion */
  .faq-answer { display: none; }
  .faq-open .faq-answer { display: block; }
  .faq-open .faq-chevron { transform: rotate(180deg); }
  `;
}

// ---------------------------------------------------------------------------
// Neighbor links
// ---------------------------------------------------------------------------
function buildNeighborLinksHtml(cityId) {
  const cd = cityData[cityId];
  if (!cd || !cd.neighbors || cd.neighbors.length === 0) return '';

  const links = cd.neighbors.map(nId => {
    const nc = cityData[nId];
    if (!nc) return '';
    return `<a href="/area/mie/${nId}/" class="px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-300 transition-colors">${escHtml(nc.nameJa)}の注文住宅情報 →</a>`;
  }).filter(Boolean).join('');

  return `
    <div class="card p-6 mb-6">
      <h2 class="text-base font-bold text-gray-800 mb-3">🔗 近隣エリアの注文住宅情報</h2>
      <div class="flex flex-wrap gap-2">${links}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// CITY_SEO_DATA JS variable (injected into template for modal rendering)
// ---------------------------------------------------------------------------
function buildCitySeoDataJs() {
  const data = {};
  for (const city of CITIES) {
    const cd = cityData[city.id];
    if (!cd) continue;
    data[city.id] = {
      nameJa: cd.nameJa || city.name,
      tips: (cd.tips || []).map(t => ({ title: t.title, body: t.body })),
      faqs: (cd.faqs || []).map(f => ({ question: f.question, answer: f.answer })),
      checklist_notes: cd.checklist_notes || '',
      neighbors: (cd.neighbors || []).map(nId => {
        const nc = cityData[nId];
        return nc ? { id: nId, name: nc.nameJa } : null;
      }).filter(Boolean),
      cityUrl: `/area/mie/${city.id}/`,
    };
  }
  data._checklist = (cityData.checklist || []).map(item => ({
    id: item.id, label: item.label, detail: item.detail,
  }));
  return `const CITY_SEO_DATA = ${JSON.stringify(data)};`;
}

// ---------------------------------------------------------------------------
// Static SEO content for city pages (visible to crawlers, hidden after JS loads)
// ---------------------------------------------------------------------------
function buildStaticCityContent(cityId) {
  const cd = cityData[cityId];
  if (!cd) return '';
  const cityObj = CITIES.find(c => c.id === cityId);
  const cityName = cityObj.name;

  const faqHtml = (cd.faqs || []).map(faq =>
    `<div class="seo-faq-item"><h3>${escHtml(faq.question)}</h3><p>${escHtml(faq.answer)}</p></div>`
  ).join('');

  const tipsHtml = (cd.tips || []).map(tip =>
    `<div class="seo-tip"><h3>${escHtml(tip.title)}</h3><p>${escHtml(tip.body)}</p></div>`
  ).join('');

  const checklistHtml = (cityData.checklist || []).map(item =>
    `<li><strong>${escHtml(item.label)}</strong>: ${escHtml(item.detail)}</li>`
  ).join('');

  const neighborLinks = (cd.neighbors || []).map(nId => {
    const nc = cityData[nId];
    return nc ? `<a href="/area/mie/${nId}/">${escHtml(nc.nameJa)}の注文住宅情報</a>` : '';
  }).filter(Boolean).join(' | ');

  const seo = cd.seo_sections || {};

  return `
<article id="seo-static" class="seo-static-content">
  <h1>${escHtml(cityName)}で注文住宅を建てる｜土地相場・費用シミュレーション</h1>

  <section>
    <h2>${escHtml(cityName)}の注文住宅事情</h2>
    ${seo.overview ? `<p>${escHtml(seo.overview)}</p>` : `<p>${escHtml(cd.meta_description)}</p>`}
    ${tipsHtml}
  </section>

  <section>
    <h2>${escHtml(cityName)}の土地選び実践ガイド</h2>
    ${seo.land_guide ? `<p>${escHtml(seo.land_guide)}</p>` : ''}
  </section>

  <section>
    <h2>${escHtml(cityName)}の注文住宅 費用の内訳</h2>
    ${seo.cost_detail ? `<p>${escHtml(seo.cost_detail)}</p>` : `<p>${escHtml(cityName)}で注文住宅を建てる場合の費用を、土地面積・建物面積・建築グレード・頭金・金利・ローン期間から即時シミュレーションできます。</p>`}
  </section>

  <section>
    <h2>${escHtml(cityName)}のエリア比較</h2>
    ${seo.area_comparison ? `<p>${escHtml(seo.area_comparison)}</p>` : ''}
  </section>

  <section>
    <h2>${escHtml(cityName)}で注文住宅を建てる際のよくある失敗</h2>
    ${seo.common_mistakes ? `<p>${escHtml(seo.common_mistakes)}</p>` : ''}
  </section>

  <section>
    <h2>土地購入前チェックリスト</h2>
    ${cd.checklist_notes ? `<p>${escHtml(cd.checklist_notes)}</p>` : ''}
    <ol>${checklistHtml}</ol>
  </section>

  <section>
    <h2>よくある質問（${escHtml(cityName)}の注文住宅）</h2>
    ${faqHtml}
  </section>

  <section>
    <h2>近隣エリアの注文住宅情報</h2>
    <p>${neighborLinks}</p>
    <p><a href="/area/mie/">三重県エリア比較に戻る</a> | <a href="/">注文住宅比較.comを使う</a></p>
  </section>

  <footer>
    <p>データ出典: <a href="https://www.reinfolib.mlit.go.jp/" rel="noopener">国土交通省 不動産情報ライブラリ（REINFOLIB）</a>、<a href="https://www.land.mlit.go.jp/landPrice/AriaServlet?MOD=2&TYP=0" rel="noopener">国土交通省 地価公示</a></p>
    <p>最終更新: ${TODAY} ｜ 監修: <a href="/about/" rel="noopener">注文住宅比較.com</a> 編集部</p>
  </footer>
</article>`;
}

function buildStaticHubContent() {
  const cityLinksHtml = CITIES.map(c => {
    const cd2 = cityData[c.id];
    return cd2 ? `<li><a href="/area/mie/${c.id}/"><strong>${escHtml(cd2.nameJa)}</strong></a>: ${escHtml(cd2.meta_description)}</li>` : '';
  }).filter(Boolean).join('');

  const hubFaqs = [
    { q: '三重県で注文住宅の土地相場はいくらですか？', a: '三重県北部7エリアの住宅地平均地価は約22,000〜53,700円/m²（坪単価8〜19万円）です。最も高いのは桑名市（坪18.4万円）、最も手頃なのはいなべ市（坪8.1万円）。名古屋通勤圏でも手頃な土地が見つかります。' },
    { q: '三重県から名古屋への通勤は可能ですか？', a: '可能です。桑名市から名古屋駅まで近鉄急行で最短25分、四日市市から約35分。車でも東名阪自動車道で40分〜1時間程度。三重県北部は名古屋通勤圏として人気があります。' },
    { q: '三重県で注文住宅を建てる総費用の目安は？', a: '土地50坪＋建物35坪のスタンダードプラン（65万円/坪）の場合、エリアにより総額2,800〜4,200万円程度。いなべ市なら2,800万円台、桑名駅近なら4,000万円超も。当サイトの費用シミュレーターで詳細な試算が可能です。' },
  ];
  const hubFaqHtml = hubFaqs.map(faq =>
    `<div class="seo-faq-item"><h3>${escHtml(faq.q)}</h3><p>${escHtml(faq.a)}</p></div>`
  ).join('');

  return `
<article id="seo-static" class="seo-static-content">
  <h1>三重県で注文住宅を建てるなら｜エリア別 土地相場・費用シミュレーター</h1>

  <section>
    <h2>三重県北部の注文住宅エリアガイド</h2>
    <p>三重県北部で注文住宅を検討中の方へ。四日市・桑名・鈴鹿・いなべ・亀山・菰野・東員の7エリアの土地価格相場、費用シミュレーション、国土交通省の実取引データを比較して、理想の土地を見つけましょう。</p>
    <p>三重県は全国平均と比べて土地取得費用が約586万円安く、名古屋通勤圏でありながら広い敷地を確保しやすい地域です。坪単価8万円台のいなべ市から、名古屋25分の桑名市まで、ライフスタイルに合ったエリアが見つかります。</p>
  </section>

  <section>
    <h2>エリア別 注文住宅ガイド</h2>
    <ul>${cityLinksHtml}</ul>
  </section>

  <section>
    <h2>注文住宅 費用シミュレーター</h2>
    <p>土地面積・建物面積・建築グレード・頭金・金利・ローン期間を設定して、注文住宅の総費用と月々の返済額を即時シミュレーション。各エリアの実取引データに基づく坪単価を使用した、信頼性の高い試算が可能です。</p>
  </section>

  <section>
    <h2>よくある質問（三重県の注文住宅）</h2>
    ${hubFaqHtml}
  </section>

  <section>
    <h2>データについて</h2>
    <p>当サイトの土地価格データは<a href="https://www.reinfolib.mlit.go.jp/" rel="noopener">国土交通省 不動産情報ライブラリ（REINFOLIB）</a>の実取引データに基づいています。地価の推移は<a href="https://www.land.mlit.go.jp/landPrice/AriaServlet?MOD=2&TYP=0" rel="noopener">国土交通省 地価公示</a>を参照しています。</p>
    <p>最終更新: ${TODAY} ｜ 監修: <a href="/about/" rel="noopener">注文住宅比較.com</a> 編集部</p>
  </section>

  <footer>
    <p><a href="/">注文住宅比較.comを使う</a></p>
  </footer>
</article>`;
}

// CSS for static SEO content (hidden when JS loads, visible for crawlers)
function buildStaticContentCss() {
  return `
  .seo-static-content { max-width: 800px; margin: 0 auto; padding: 24px 16px; font-family: 'Noto Sans JP', sans-serif; color: #374151; line-height: 1.8; }
  .seo-static-content h1 { font-size: 1.5rem; font-weight: 700; color: #111827; margin-bottom: 16px; }
  .seo-static-content h2 { font-size: 1.2rem; font-weight: 700; color: #1f2937; margin-top: 32px; margin-bottom: 12px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
  .seo-static-content h3 { font-size: 1rem; font-weight: 600; color: #374151; margin-top: 16px; margin-bottom: 8px; }
  .seo-static-content p { margin-bottom: 12px; font-size: 0.95rem; }
  .seo-static-content ul, .seo-static-content ol { margin-bottom: 16px; padding-left: 24px; }
  .seo-static-content li { margin-bottom: 8px; font-size: 0.9rem; }
  .seo-static-content a { color: #2563eb; text-decoration: underline; }
  .seo-static-content footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 0.8rem; color: #6b7280; }
  .seo-faq-item { margin-bottom: 16px; padding: 12px 16px; background: #f9fafb; border-radius: 8px; }
  .seo-tip { margin-bottom: 12px; padding: 12px 16px; background: #eff6ff; border-radius: 8px; border-left: 4px solid #3b82f6; }
  `;
}

// ---------------------------------------------------------------------------
// CTA to property comparison tool
// ---------------------------------------------------------------------------
function buildCtaHtml() {
  return `
    <div class="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-6 mb-6 text-center">
      <h3 class="text-base font-bold text-gray-800 mb-2">具体的な物件が見つかったら...</h3>
      <p class="text-sm text-gray-600 mb-4">AIが複数物件を自動比較。SUUMO・ホームズ等のURLを貼るだけで、見やすい比較表を作成します。</p>
      <a href="/" class="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors shadow-sm">
        🏠 注文住宅比較.comを使う →
      </a>
    </div>`;
}

// ---------------------------------------------------------------------------
// Share buttons
// ---------------------------------------------------------------------------
function buildShareButtonsHtml(pageUrl, pageTitle) {
  const encodedUrl = encodeURIComponent(pageUrl);
  const encodedTitle = encodeURIComponent(pageTitle);
  return `
    <div class="card p-4 mb-6">
      <div class="flex items-center justify-center gap-3 flex-wrap">
        <span class="text-xs text-gray-500">このページをシェア:</span>
        <a href="https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;background:#000;color:white;border-radius:6px;font-size:12px;font-weight:500;text-decoration:none;">𝕏 ポスト</a>
        <a href="https://social-plugins.line.me/lineit/share?url=${encodedUrl}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;background:#06c755;color:white;border-radius:6px;font-size:12px;font-weight:500;text-decoration:none;">LINE 送る</a>
        <a href="https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;background:#1877f2;color:white;border-radius:6px;font-size:12px;font-weight:500;text-decoration:none;">Facebook</a>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Hub page internal links to city pages
// ---------------------------------------------------------------------------
function buildCityLinksSection() {
  return `
    <div class="card p-6 mb-6" id="city-pages">
      <h2 class="text-lg font-bold text-gray-800 mb-2">📍 市区町村別 注文住宅ガイド</h2>
      <p class="text-xs text-gray-500 mb-4">各市の詳細な土地相場・費用シミュレーション・取引データをご覧いただけます</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        ${CITIES.map(c => {
          const cd2 = cityData[c.id];
          return `
            <a href="/area/mie/${c.id}/" class="block p-4 border border-gray-200 rounded-lg hover:bg-blue-50 hover:border-blue-300 transition-all group">
              <div class="text-base font-bold text-gray-800 group-hover:text-blue-700">${c.name}</div>
              <div class="text-xs text-gray-500 mt-1">${cd2 ? escHtml(cd2.meta_description.substring(0, 60)) + '...' : ''}</div>
            </a>`;
        }).join('')}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Generate Hub Page (area/mie/index.html)
// ---------------------------------------------------------------------------
function generateHubPage() {
  let html = areaHtml;

  // 1. Update <title>
  html = html.replace(
    /<title>[^<]*<\/title>/,
    '<title>三重県で注文住宅を建てるなら｜エリア別 土地相場・費用シミュレーター | 注文住宅比較.com</title>'
  );

  // 2. Update canonical
  html = html.replace(
    /<link rel="canonical" href="[^"]*">/,
    `<link rel="canonical" href="${DOMAIN}/area/mie/">`
  );

  // 3. Update og:url
  html = html.replace(
    /<meta property="og:url" content="[^"]*">/,
    `<meta property="og:url" content="${DOMAIN}/area/mie/">`
  );

  // 4. Update og:title
  html = html.replace(
    /<meta property="og:title" content="[^"]*">/,
    '<meta property="og:title" content="三重県で注文住宅を建てるなら｜エリア別 土地相場・費用シミュレーター">'
  );

  // 5. Update meta description
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    '<meta name="description" content="三重県北部で注文住宅を検討中の方へ。四日市・桑名・鈴鹿・いなべ・亀山・菰野・東員の7エリアの土地価格相場、費用シミュレーション、実取引データを比較。国土交通省データに基づく信頼性の高い情報で理想の土地探しをサポートします。">'
  );

  // 5b. Add og:image and update Twitter Card
  html = html.replace(
    '<!-- 構造化データ (JSON-LD) -->',
    `<meta property="og:image" content="${DOMAIN}/og-image-hub.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:image" content="${DOMAIN}/og-image-hub.png">
<!-- 構造化データ (JSON-LD) -->`
  );
  html = html.replace(
    /<meta name="twitter:title" content="[^"]*">/,
    '<meta name="twitter:title" content="三重県で注文住宅を建てるなら｜エリア別 土地相場・費用シミュレーター">'
  );
  html = html.replace(
    /<meta name="twitter:description" content="[^"]*">/,
    '<meta name="twitter:description" content="四日市・桑名・鈴鹿・いなべ・亀山・菰野・東員の7エリアの土地相場と費用を無料シミュレーション。国土交通省データに基づく注文住宅の土地探しツール。">'
  );

  // 6. Update WebApplication structured data URL + enhance author
  html = html.replace(
    /"url": "https:\/\/research\.chuumon-soudan\.com\/area\.html"/,
    `"url": "${DOMAIN}/area/mie/"`
  );
  html = html.replace(
    '"author": { "@type": "Organization", "name": "注文住宅比較.com" }',
    '"author": { "@type": "Organization", "name": "注文住宅比較.com", "url": "https://research.chuumon-soudan.com/about/", "description": "注文住宅の土地探し・費用比較をサポートする情報サイト" }, "publisher": { "@type": "Organization", "name": "注文住宅比較.com", "url": "https://research.chuumon-soudan.com/about/" }, "dateModified": "' + TODAY + '"'
  );

  // 7. Add tooltip CSS + static content CSS before </style>
  html = html.replace('</style>', buildTooltipCss() + buildStaticContentCss() + '\n</style>');

  // 7b. Inject static SEO content after <div id="app"></div>
  html = html.replace(
    '<div id="app"></div>',
    '<div id="app"></div>\n' + buildStaticHubContent()
  );

  // 8. Add breadcrumb + FAQ JSON-LD before </head>
  const breadcrumbItems = [
    { name: 'トップ', url: '/' },
    { name: '三重県エリア比較', url: '/area/mie/' }
  ];

  // Build a combined FAQ from all cities for the hub
  const hubFaqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: '三重県で注文住宅の土地相場はいくらですか？', acceptedAnswer: { '@type': 'Answer', text: '三重県北部7エリアの住宅地平均地価は約22,000〜53,700円/m²（坪単価8〜19万円）です。最も高いのは桑名市（坪18.4万円）、最も手頃なのはいなべ市（坪8.1万円）。名古屋通勤圏でも手頃な土地が見つかります。' }},
      { '@type': 'Question', name: '三重県から名古屋への通勤は可能ですか？', acceptedAnswer: { '@type': 'Answer', text: '可能です。桑名市から名古屋駅まで近鉄急行で最短25分、四日市市から約35分。車でも東名阪自動車道で40分〜1時間程度。三重県北部は名古屋通勤圏として人気があります。' }},
      { '@type': 'Question', name: '三重県で注文住宅を建てる総費用の目安は？', acceptedAnswer: { '@type': 'Answer', text: '土地50坪＋建物35坪のスタンダードプラン（65万円/坪）の場合、エリアにより総額2,800〜4,200万円程度。いなべ市なら2,800万円台、桑名駅近なら4,000万円超も。当サイトの費用シミュレーターで詳細な試算が可能です。' }}
    ]
  };

  const hubStructuredData = buildBreadcrumbJsonLd(breadcrumbItems) + '\n' +
    `<script type="application/ld+json">${JSON.stringify(hubFaqSchema)}</script>`;

  html = html.replace('</head>', hubStructuredData + '\n</head>');

  // 9. Fix data file paths to absolute
  html = html.replace(/fetch\('data\/live-data\.json'\)/g, "fetch('/data/live-data.json')");
  html = html.replace(/fetch\('school-districts\.geojson'\)/g, "fetch('/school-districts.geojson')");

  // 10. Insert breadcrumb, cost simulator, city links, FAQ, and tips into the render output
  //     We inject content into the renderFooter function and renderHeader
  //     Strategy: Add new sections via the render() function's output

  // Inject breadcrumb into header
  html = html.replace(
    "<!-- タイトル（スクロールで消える） -->",
    buildBreadcrumbHtml(breadcrumbItems) + "\n    <!-- タイトル（スクロールで消える） -->"
  );

  // Add E-E-A-T badge to hub subtitle
  html = html.replace(
    '<p class="text-sm text-gray-500 mt-1 mobile-subtitle-text">三重県北部の土地相場・取引データを比較して、注文住宅に最適なエリアを見つけよう</p>',
    `<p class="text-sm text-gray-500 mt-1 mobile-subtitle-text">三重県北部の土地相場・取引データを比較して、注文住宅に最適なエリアを見つけよう</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">
          <span style="font-size:11px;color:#6b7280;background:#f3f4f6;padding:2px 8px;border-radius:4px;">📊 データ出典: <a href="https://www.reinfolib.mlit.go.jp/" style="color:#3b82f6;text-decoration:none;" rel="noopener">国土交通省 不動産情報ライブラリ</a></span>
          <span style="font-size:11px;color:#6b7280;background:#f3f4f6;padding:2px 8px;border-radius:4px;">✏️ 監修: <a href="/about/" style="color:#3b82f6;text-decoration:none;" rel="noopener">注文住宅比較.com</a> 編集部</span>
          <span style="font-size:11px;color:#6b7280;background:#f3f4f6;padding:2px 8px;border-radius:4px;">🕐 最終更新: ${TODAY}</span>
        </div>`
  );

  // Update the link in header from index.html to /
  html = html.replace(
    '<a href="index.html" style="display:inline-block;margin-top:6px;font-size:13px;color:#3b82f6;font-weight:500;text-decoration:none;">🏠 注文住宅比較.comはこちら →</a>',
    '<a href="/" style="display:inline-block;margin-top:6px;font-size:13px;color:#3b82f6;font-weight:500;text-decoration:none;">🏠 注文住宅比較.comはこちら →</a>'
  );

  // Inject cost simulator + city links + FAQ + CTA before the footer in the render function
  const hubExtraSections = `
      ${buildCostSimulatorHtml(null)}
      ${buildCityLinksSection()}
      ${buildTipsHtml('yokkaichi').split('\n').slice(0, 1).join('')}
      <div class="card p-6 mb-6">
        <h2 class="text-lg font-bold text-gray-800 mb-4">❓ よくある質問（三重県の注文住宅）</h2>
        <div class="space-y-2">
          <div class="border border-gray-200 rounded-lg overflow-hidden">
            <button class="w-full text-left px-4 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors" onclick="this.parentElement.classList.toggle('faq-open')">
              <span class="text-sm font-medium text-gray-800">三重県で注文住宅の土地相場はいくらですか？</span>
              <svg class="w-5 h-5 text-gray-400 faq-chevron transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </button>
            <div class="faq-answer px-4 py-3 text-sm text-gray-600 leading-relaxed border-t border-gray-100">三重県北部7エリアの住宅地平均地価は約22,000〜53,700円/m\u00B2（坪単価8〜19万円）です。最も高いのは桑名市（坪18.4万円）、最も手頃なのはいなべ市（坪8.1万円）。名古屋通勤圏でも手頃な土地が見つかります。</div>
          </div>
          <div class="border border-gray-200 rounded-lg overflow-hidden">
            <button class="w-full text-left px-4 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors" onclick="this.parentElement.classList.toggle('faq-open')">
              <span class="text-sm font-medium text-gray-800">三重県から名古屋への通勤は可能ですか？</span>
              <svg class="w-5 h-5 text-gray-400 faq-chevron transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </button>
            <div class="faq-answer px-4 py-3 text-sm text-gray-600 leading-relaxed border-t border-gray-100">可能です。桑名市から名古屋駅まで近鉄急行で最短25分、四日市市から約35分。車でも東名阪自動車道で40分〜1時間程度。三重県北部は名古屋通勤圏として人気があります。</div>
          </div>
          <div class="border border-gray-200 rounded-lg overflow-hidden">
            <button class="w-full text-left px-4 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors" onclick="this.parentElement.classList.toggle('faq-open')">
              <span class="text-sm font-medium text-gray-800">三重県で注文住宅を建てる総費用の目安は？</span>
              <svg class="w-5 h-5 text-gray-400 faq-chevron transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </button>
            <div class="faq-answer px-4 py-3 text-sm text-gray-600 leading-relaxed border-t border-gray-100">土地50坪＋建物35坪のスタンダードプラン（65万円/坪）の場合、エリアにより総額2,800〜4,200万円程度。いなべ市なら2,800万円台、桑名駅近なら4,000万円超も。当サイトの費用シミュレーターで詳細な試算が可能です。</div>
          </div>
        </div>
      </div>
      ${buildCtaHtml()}
      ${buildShareButtonsHtml(DOMAIN + '/area/mie/', '三重県で注文住宅を建てるなら｜エリア別 土地相場・費用シミュレーター')}`;

  // Inject before renderFooter() call in the render function
  html = html.replace(
    '${renderFooter()}',
    hubExtraSections.replace(/\$/g, '$$$$') + '\n      ${renderFooter()}'
  );

  // 11. Update footer with city links + knowledge links
  const hubFooterLinks = CITIES.map(c =>
    `<a href="/area/mie/${c.id}/" class="text-xs text-blue-600 hover:underline">${c.name}</a>`
  ).join(' | ');

  const knowledgeFooterLinks = knowledgeData.articles.map(a =>
    `<a href="/knowledge/${a.id}/" class="text-xs text-blue-600 hover:underline">${a.title.split('｜')[0]}</a>`
  ).join(' | ');

  html = html.replace(
    "function renderFooter() {\n  return `\n    <footer class=\"mt-8 py-6 border-t border-gray-200\">\n      <div class=\"text-center space-y-2\">",
    `function renderFooter() {
  return \`
    <footer class="mt-8 py-6 border-t border-gray-200">
      <div class="text-center space-y-2">
        <div class="flex justify-center flex-wrap gap-2 mb-3">${hubFooterLinks}</div>
        <div class="flex justify-center flex-wrap gap-2 mb-3">${knowledgeFooterLinks}</div>
        <div class="mb-2"><a href="/" class="text-sm text-blue-600 hover:underline">🏠 注文住宅比較.com</a></div>`
  );

  // 12. Add drawer menu city links
  const drawerCityLinks = CITIES.map(c =>
    `<a href="/area/mie/${c.id}/" style="width:100%;text-align:left;padding:8px 16px;border-radius:8px;font-size:13px;background:#f0f9ff;color:#1e40af;border:none;text-decoration:none;display:block;">${c.name}</a>`
  ).join('\n          ');

  html = html.replace(
    '</div>\n    </div>\n  `;' + '\n}' + '\n\nfunction openMobileDrawer',
    `<div style="border-top:1px solid #e5e7eb;padding-top:8px;margin-top:8px;">
          <div style="font-size:11px;color:#9ca3af;padding:0 16px 4px;">エリア別ガイド</div>
          ${drawerCityLinks}
        </div>
      </div>
    </div>
  \`;
}

function openMobileDrawer`
  );

  // 13. Add cost simulator JS + SEO hide before the closing </script>
  html = html.replace(
    'loadStaticData();\n</script>',
    `loadStaticData();

${buildCostSimulatorScript()}
// Hide static SEO content after JS renders
document.addEventListener('DOMContentLoaded', function() { var el = document.getElementById('seo-static'); if (el) el.style.display = 'none'; });
</script>`
  );

  // 14. Add ranking items linking to city pages
  // Add a city page link to each ranking card
  html = html.replace(
    `<p class="text-sm text-gray-600 mb-3">\${a.description}</p>`,
    `<p class="text-sm text-gray-600 mb-2">\${a.description}</p>
              <a href="/area/mie/\${a.id}/" class="inline-block text-xs text-blue-600 hover:underline mb-2">📄 \${a.name}の詳細ガイド →</a>`
  );

  // 15. Enhance footer with operator info (E-E-A-T)
  html = html.replace(
    '<p class="text-xs text-gray-300 mt-3">© 注文住宅比較.com — Powered by 国土交通省 不動産情報ライブラリ + 行政オープンデータ</p>',
    `<div style="margin-top:12px;padding-top:12px;border-top:1px solid #f3f4f6;">
          <p class="text-xs text-gray-400" style="margin-bottom:4px;"><strong>運営</strong>: <a href="/about/" style="color:#6b7280;text-decoration:underline;" rel="noopener">注文住宅比較.com</a>（注文住宅の土地探し・費用比較をサポート）</p>
          <p class="text-xs text-gray-400" style="margin-bottom:4px;"><strong>データ更新</strong>: ${TODAY} ｜ 国土交通省 不動産情報ライブラリAPI・地価公示データを定期取得</p>
          <p class="text-xs text-gray-300">© 注文住宅比較.com — 本ツールの利用は無料です。不動産購入の最終判断は専門家にご相談ください。</p>
        </div>`
  );

  // 16. Inject CITY_SEO_DATA for modal rendering
  html = html.replace(
    "const COLORS = ['#3b82f6'",
    buildCitySeoDataJs() + "\nconst COLORS = ['#3b82f6'"
  );

  return html;
}

// ---------------------------------------------------------------------------
// Generate City Page (area/mie/{city}/index.html)
// ---------------------------------------------------------------------------
function generateCityPage(cityId) {
  const cd = cityData[cityId];
  if (!cd) throw new Error(`No city data for ${cityId}`);

  const cityObj = CITIES.find(c => c.id === cityId);
  const cityName = cityObj.name;

  let html = areaHtml;

  // 1. Update <title>
  html = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${cityName}で注文住宅｜土地相場・費用シミュレーション・取引データ | 注文住宅比較.com</title>`
  );

  // 2. Update meta description
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${escHtml(cd.meta_description)}">`
  );

  // 3. Update canonical
  html = html.replace(
    /<link rel="canonical" href="[^"]*">/,
    `<link rel="canonical" href="${DOMAIN}/area/mie/${cityId}/">`
  );

  // 4. Update og:url and og:title
  html = html.replace(
    /<meta property="og:url" content="[^"]*">/,
    `<meta property="og:url" content="${DOMAIN}/area/mie/${cityId}/">`
  );
  html = html.replace(
    /<meta property="og:title" content="[^"]*">/,
    `<meta property="og:title" content="${cityName}で注文住宅｜土地相場・費用シミュレーション・取引データ">`
  );
  html = html.replace(
    /<meta property="og:description" content="[^"]*">/,
    `<meta property="og:description" content="${escHtml(cd.meta_description)}">`
  );

  // 5. Update keywords
  html = html.replace(
    /<meta name="keywords" content="[^"]*">/,
    `<meta name="keywords" content="${cityName},注文住宅,土地探し,土地相場,費用シミュレーション,三重県,名古屋通勤">`
  );

  // 5b. Add og:image and update Twitter Card
  html = html.replace(
    '<!-- 構造化データ (JSON-LD) -->',
    `<meta property="og:image" content="${DOMAIN}/og-image-${cityId}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:image" content="${DOMAIN}/og-image-${cityId}.png">
<!-- 構造化データ (JSON-LD) -->`
  );
  html = html.replace(
    /<meta name="twitter:title" content="[^"]*">/,
    `<meta name="twitter:title" content="${cityName}で注文住宅｜土地相場・費用シミュレーション">`
  );
  html = html.replace(
    /<meta name="twitter:description" content="[^"]*">/,
    `<meta name="twitter:description" content="${escHtml(cd.meta_description.substring(0, 100))}">`
  );

  // 6. Update WebApplication structured data + enhance author
  html = html.replace(
    /"url": "https:\/\/research\.chuumon-soudan\.com\/area\.html"/,
    `"url": "${DOMAIN}/area/mie/${cityId}/"`
  );
  html = html.replace(
    /"name": "三重県 注文住宅エリア比較ツール"/,
    `"name": "${cityName} 注文住宅 土地相場・費用シミュレーター"`
  );
  html = html.replace(
    '"author": { "@type": "Organization", "name": "注文住宅比較.com" }',
    '"author": { "@type": "Organization", "name": "注文住宅比較.com", "url": "https://research.chuumon-soudan.com/about/", "description": "注文住宅の土地探し・費用比較をサポートする情報サイト" }, "publisher": { "@type": "Organization", "name": "注文住宅比較.com", "url": "https://research.chuumon-soudan.com/about/" }, "dateModified": "' + TODAY + '"'
  );

  // 7. Add tooltip CSS + static content CSS
  html = html.replace('</style>', buildTooltipCss() + buildStaticContentCss() + '\n</style>');

  // 7b. Inject static SEO content after <div id="app"></div>
  html = html.replace(
    '<div id="app"></div>',
    '<div id="app"></div>\n' + buildStaticCityContent(cityId)
  );

  // 8. Add breadcrumb + FAQ JSON-LD
  const breadcrumbItems = [
    { name: 'トップ', url: '/' },
    { name: '三重県エリア比較', url: '/area/mie/' },
    { name: cityName, url: `/area/mie/${cityId}/` }
  ];

  const cityStructuredData = buildBreadcrumbJsonLd(breadcrumbItems) + '\n' + buildFaqJsonLd(cityId);
  html = html.replace('</head>', cityStructuredData + '\n</head>');

  // 9. Fix data file paths
  html = html.replace(/fetch\('data\/live-data\.json'\)/g, "fetch('/data/live-data.json')");
  html = html.replace(/fetch\('school-districts\.geojson'\)/g, "fetch('/school-districts.geojson')");

  // 10. Inject breadcrumb
  html = html.replace(
    "<!-- タイトル（スクロールで消える） -->",
    buildBreadcrumbHtml(breadcrumbItems) + "\n    <!-- タイトル（スクロールで消える） -->"
  );

  // 11. Update H1 and subtitle + E-E-A-T badge
  html = html.replace(
    '<h1 class="text-2xl font-bold text-gray-900 mobile-title-text">🏠 三重県 注文住宅エリア比較</h1>',
    `<h1 class="text-2xl font-bold text-gray-900 mobile-title-text">🏠 ${cityName}で注文住宅を建てる</h1>`
  );
  html = html.replace(
    '<p class="text-sm text-gray-500 mt-1 mobile-subtitle-text">三重県北部の土地相場・取引データを比較して、注文住宅に最適なエリアを見つけよう</p>',
    `<p class="text-sm text-gray-500 mt-1 mobile-subtitle-text">土地相場・費用シミュレーション・取引データで${cityName}の注文住宅をサポート</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">
          <span style="font-size:11px;color:#6b7280;background:#f3f4f6;padding:2px 8px;border-radius:4px;">📊 データ出典: <a href="https://www.reinfolib.mlit.go.jp/" style="color:#3b82f6;text-decoration:none;" rel="noopener">国土交通省 不動産情報ライブラリ</a></span>
          <span style="font-size:11px;color:#6b7280;background:#f3f4f6;padding:2px 8px;border-radius:4px;">✏️ 監修: <a href="/about/" style="color:#3b82f6;text-decoration:none;" rel="noopener">注文住宅比較.com</a> 編集部</span>
          <span style="font-size:11px;color:#6b7280;background:#f3f4f6;padding:2px 8px;border-radius:4px;">🕐 最終更新: ${TODAY}</span>
        </div>`
  );

  // 12. Update link in header
  html = html.replace(
    '<a href="index.html" style="display:inline-block;margin-top:6px;font-size:13px;color:#3b82f6;font-weight:500;text-decoration:none;">🏠 注文住宅比較.comはこちら →</a>',
    '<a href="/area/mie/" style="display:inline-block;margin-top:6px;font-size:13px;color:#3b82f6;font-weight:500;text-decoration:none;">← 三重県エリア比較に戻る</a>'
  );

  // 13. Set initial state to show this city's detail view
  html = html.replace(
    "view: 'ranking'",
    `view: 'detail'`
  );
  html = html.replace(
    "selectedAreaId: null",
    `selectedAreaId: '${cityId}'`
  );

  // 14. Inject city-specific sections before footer (only cost simulator remains here; tips/FAQ/checklist moved to modal)
  const cityExtraSections = `
      ${buildCostSimulatorHtml(cityId)}`;

  html = html.replace(
    '${renderFooter()}',
    cityExtraSections.replace(/\$/g, '$$$$') + '\n      ${renderFooter()}'
  );

  // 15. Update footer with knowledge links
  const cityFooterLinks = [
    `<a href="/area/mie/" class="text-xs text-blue-600 hover:underline">三重県エリア比較</a>`,
    ...cd.neighbors.map(nId => {
      const nc = cityData[nId];
      return nc ? `<a href="/area/mie/${nId}/" class="text-xs text-blue-600 hover:underline">${nc.nameJa}</a>` : '';
    }).filter(Boolean),
    `<a href="/" class="text-xs text-blue-600 hover:underline">注文住宅比較.com</a>`
  ].join(' | ');

  const cityKnowledgeLinks = knowledgeData.articles.map(a =>
    `<a href="/knowledge/${a.id}/" class="text-xs text-blue-600 hover:underline">${a.title.split('｜')[0]}</a>`
  ).join(' | ');

  html = html.replace(
    "function renderFooter() {\n  return `\n    <footer class=\"mt-8 py-6 border-t border-gray-200\">\n      <div class=\"text-center space-y-2\">",
    `function renderFooter() {
  return \`
    <footer class="mt-8 py-6 border-t border-gray-200">
      <div class="text-center space-y-2">
        <div class="flex justify-center flex-wrap gap-2 mb-3">${cityFooterLinks}</div>
        <div class="flex justify-center flex-wrap gap-2 mb-3">${cityKnowledgeLinks}</div>`
  );

  // 16. Add cost simulator + checklist JS
  html = html.replace(
    'loadStaticData();\n</script>',
    `loadStaticData();

${buildCostSimulatorScript()}
${buildChecklistScript()}
// Restore checklist on load
document.addEventListener('DOMContentLoaded', function() { setTimeout(function() { clRestore('${cityId}'); }, 200); });
// Hide static SEO content after JS renders
document.addEventListener('DOMContentLoaded', function() { var el = document.getElementById('seo-static'); if (el) el.style.display = 'none'; });
</script>`
  );

  // 17. Add drawer menu with area navigation
  const drawerCityLinks = CITIES.map(c =>
    `<a href="/area/mie/${c.id}/" style="width:100%;text-align:left;padding:8px 16px;border-radius:8px;font-size:13px;${c.id === cityId ? 'background:#dbeafe;color:#1e40af;font-weight:600;' : 'background:#f0f9ff;color:#1e40af;'}border:none;text-decoration:none;display:block;">${cityData[c.id]?.nameJa || c.name}</a>`
  ).join('\n          ');

  html = html.replace(
    '</div>\n    </div>\n  `;' + '\n}' + '\n\nfunction openMobileDrawer',
    `<div style="border-top:1px solid #e5e7eb;padding-top:8px;margin-top:8px;">
          <div style="font-size:11px;color:#9ca3af;padding:0 16px 4px;">エリア別ガイド</div>
          ${drawerCityLinks}
          <a href="/area/mie/" style="width:100%;text-align:left;padding:8px 16px;border-radius:8px;font-size:13px;background:#f9fafb;color:#6b7280;border:none;text-decoration:none;display:block;margin-top:4px;">← エリア比較に戻る</a>
        </div>
      </div>
    </div>
  \`;
}

function openMobileDrawer`
  );

  // 18. Enhance footer with operator info (E-E-A-T)
  html = html.replace(
    '<p class="text-xs text-gray-300 mt-3">© 注文住宅比較.com — Powered by 国土交通省 不動産情報ライブラリ + 行政オープンデータ</p>',
    `<div style="margin-top:12px;padding-top:12px;border-top:1px solid #f3f4f6;">
          <p class="text-xs text-gray-400" style="margin-bottom:4px;"><strong>運営</strong>: <a href="/about/" style="color:#6b7280;text-decoration:underline;" rel="noopener">注文住宅比較.com</a>（注文住宅の土地探し・費用比較をサポート）</p>
          <p class="text-xs text-gray-400" style="margin-bottom:4px;"><strong>データ更新</strong>: ${TODAY} ｜ 国土交通省 不動産情報ライブラリAPI・地価公示データを定期取得</p>
          <p class="text-xs text-gray-300">© 注文住宅比較.com — 本ツールの利用は無料です。不動産購入の最終判断は専門家にご相談ください。</p>
        </div>`
  );

  // 19. Inject CITY_SEO_DATA for modal rendering
  html = html.replace(
    "const COLORS = ['#3b82f6'",
    buildCitySeoDataJs() + "\nconst COLORS = ['#3b82f6'"
  );

  return html;
}

// ---------------------------------------------------------------------------
// Generate About Page (/about/index.html)
// ---------------------------------------------------------------------------
function generateAboutPage() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="google-site-verification" content="VBmM5Mikm2LrkY9dXa30MUHtT9KD2SpZFsoGHBuFPWM" />
<script async src="https://www.googletagmanager.com/gtag/js?id=G-SZV3XF0W0G"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-SZV3XF0W0G');
</script>
<title>運営者情報 | 注文住宅比較.com</title>
<meta name="description" content="注文住宅比較.comの運営者情報・サイト概要・データ出典についてご説明します。">
<link rel="canonical" href="${DOMAIN}/about/">
<meta property="og:title" content="運営者情報 | 注文住宅比較.com">
<meta property="og:type" content="website">
<meta property="og:url" content="${DOMAIN}/about/">
<meta property="og:site_name" content="注文住宅比較.com">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Noto Sans JP', sans-serif; background: linear-gradient(135deg, #f0f4ff 0%, #e8f0fe 50%, #f5f0ff 100%); color: #374151; line-height: 1.8; min-height: 100vh; }
  .about-header { background: white; border-bottom: 1px solid #e5e7eb; padding: 12px 16px; position: sticky; top: 0; z-index: 50; }
  .about-header-inner { max-width: 700px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; }
  .about-header a { text-decoration: none; color: #3b82f6; font-size: 13px; font-weight: 500; }
  .about-header .site-name { font-size: 15px; font-weight: 700; color: #1f2937; }
  .about-main { max-width: 700px; margin: 0 auto; padding: 32px 16px 48px; }
  .about-main h1 { font-size: 1.5rem; font-weight: 700; color: #111827; margin-bottom: 24px; }
  .about-main h2 { font-size: 1.1rem; font-weight: 700; color: #1f2937; margin-top: 32px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 2px solid #e5e7eb; }
  .about-main p { margin-bottom: 14px; font-size: 0.95rem; }
  .about-main ul { padding-left: 20px; margin-bottom: 14px; }
  .about-main li { margin-bottom: 6px; font-size: 0.9rem; }
  .about-main a { color: #3b82f6; text-decoration: underline; }
  .about-main table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 0.9rem; }
  .about-main th { background: #f9fafb; text-align: left; padding: 10px 12px; border: 1px solid #e5e7eb; font-weight: 600; width: 30%; }
  .about-main td { padding: 10px 12px; border: 1px solid #e5e7eb; }
  .about-footer { max-width: 700px; margin: 0 auto; padding: 24px 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; text-align: center; }
  .about-footer a { color: #3b82f6; text-decoration: none; }
</style>
</head>
<body>
  <header class="about-header">
    <div class="about-header-inner">
      <span class="site-name">注文住宅比較.com</span>
      <div>
        <a href="/area/mie/">エリア比較</a>
        <span style="margin: 0 6px; color: #d1d5db;">|</span>
        <a href="/knowledge/">知識</a>
        <span style="margin: 0 6px; color: #d1d5db;">|</span>
        <a href="/">注文住宅比較.com</a>
      </div>
    </div>
  </header>

  <main class="about-main">
    <h1>運営者情報</h1>

    <h2>サイト概要</h2>
    <table>
      <tr><th>サイト名</th><td>注文住宅比較.com</td></tr>
      <tr><th>URL</th><td>${DOMAIN}/</td></tr>
      <tr><th>サービス内容</th><td>注文住宅の土地探し・費用比較をサポートする無料Webツール</td></tr>
      <tr><th>対象エリア</th><td>三重県北部（四日市市・桑名市・鈴鹿市・いなべ市・亀山市・菰野町・東員町）</td></tr>
    </table>

    <h2>提供ツール</h2>
    <ul>
      <li><a href="/area/mie/">エリア比較ツール</a> — 三重県北部7エリアの土地相場・取引データ・子育て環境をリアルタイム比較</li>
      <li><a href="/">注文住宅比較.com</a> — SUUMO・ホームズ等のURLを貼るだけで、AIが物件情報を自動取得・比較表を作成</li>
      <li>費用シミュレーター — 土地面積・建物面積・建築グレードから注文住宅の総費用を即時試算</li>
    </ul>

    <h2>データ出典</h2>
    <p>当サイトで使用しているデータは、以下の公的機関のオープンデータに基づいています。</p>
    <ul>
      <li><a href="https://www.reinfolib.mlit.go.jp/" rel="noopener" target="_blank">国土交通省 不動産情報ライブラリ（REINFOLIB）</a> — 不動産取引価格情報</li>
      <li><a href="https://www.land.mlit.go.jp/landPrice/AriaServlet?MOD=2&TYP=0" rel="noopener" target="_blank">国土交通省 地価公示</a> — 公示地価データ</li>
      <li><a href="https://www.e-stat.go.jp/" rel="noopener" target="_blank">総務省 e-Stat</a> — 統計データ（人口・世帯数等）</li>
    </ul>

    <h2>免責事項</h2>
    <p>当サイトは注文住宅の土地探し・費用検討を支援する参考情報を提供するものであり、不動産取引に関する助言を行うものではありません。掲載情報の正確性には最大限の注意を払っていますが、実際の不動産購入にあたっては、必ず不動産会社・建築会社・金融機関等の専門家にご相談ください。</p>
    <p>土地価格・建築費等の数値は、公的データに基づく参考値であり、実際の取引価格とは異なる場合があります。</p>

    <h2>お問い合わせ</h2>
    <p>サイトに関するご意見・ご要望・データの修正依頼等がございましたら、以下までご連絡ください。</p>
    <p>お問い合わせ先の準備中です。</p>

    <p style="font-size:12px;color:#9ca3af;margin-top:32px;">最終更新: ${TODAY}</p>
  </main>

  <footer class="about-footer">
    <p><a href="/">注文住宅比較.com</a> | <a href="/area/mie/">三重県エリア比較</a> | <a href="/knowledge/">注文住宅の知識</a></p>
    <p style="margin-top: 8px;">&copy; 注文住宅比較.com</p>
  </footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Generate Knowledge Article Page
// ---------------------------------------------------------------------------
function generateKnowledgePage(article) {
  const faqJsonLd = article.faqs && article.faqs.length > 0 ? `
<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: article.faqs.map(f => ({
    '@type': 'Question',
    name: f.question,
    acceptedAnswer: { '@type': 'Answer', text: f.answer }
  }))
})}</script>` : '';

  const breadcrumbItems = [
    { name: 'トップ', url: '/' },
    { name: '注文住宅の知識', url: '/knowledge/' },
    { name: article.title.split('｜')[0], url: `/knowledge/${article.id}/` }
  ];

  const breadcrumbJsonLd = buildBreadcrumbJsonLd(breadcrumbItems);

  const articleJsonLd = `
<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: article.title,
  description: article.description,
  author: { '@type': 'Organization', name: '注文住宅比較.com', url: DOMAIN + '/about/' },
  publisher: { '@type': 'Organization', name: '注文住宅比較.com', url: DOMAIN + '/about/' },
  datePublished: TODAY,
  dateModified: TODAY,
  mainEntityOfPage: { '@type': 'WebPage', '@id': `${DOMAIN}/knowledge/${article.id}/` }
})}</script>`;

  const sectionsHtml = article.sections.map(s => `
  <section>
    <h2>${escHtml(s.heading)}</h2>
    <p>${escHtml(s.body)}</p>
  </section>`).join('\n');

  const faqHtml = (article.faqs || []).map(f => `
    <div class="knowledge-faq">
      <h3>${escHtml(f.question)}</h3>
      <p>${escHtml(f.answer)}</p>
    </div>`).join('');

  const otherArticles = knowledgeData.articles
    .filter(a => a.id !== article.id)
    .map(a => `<li><a href="/knowledge/${a.id}/">${escHtml(a.title.split('｜')[0])}</a></li>`)
    .join('\n        ');

  const breadcrumbHtml = `<nav class="knowledge-breadcrumb" aria-label="パンくずリスト">
    <a href="/">トップ</a> / <a href="/knowledge/">注文住宅の知識</a> / <span>${escHtml(article.title.split('｜')[0])}</span>
  </nav>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="google-site-verification" content="VBmM5Mikm2LrkY9dXa30MUHtT9KD2SpZFsoGHBuFPWM" />
<script async src="https://www.googletagmanager.com/gtag/js?id=G-SZV3XF0W0G"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-SZV3XF0W0G');
</script>
<title>${escHtml(article.title)} | 注文住宅比較.com</title>
<meta name="description" content="${escHtml(article.description)}">
<meta name="keywords" content="${escHtml(article.keywords)}">
<link rel="canonical" href="${DOMAIN}/knowledge/${article.id}/">
<meta property="og:title" content="${escHtml(article.title)}">
<meta property="og:description" content="${escHtml(article.description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${DOMAIN}/knowledge/${article.id}/">
<meta property="og:site_name" content="注文住宅比較.com">
<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(article.title)}">
<meta name="twitter:description" content="${escHtml(article.description)}">
${breadcrumbJsonLd}
${articleJsonLd}
${faqJsonLd}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Noto Sans JP', sans-serif; background: linear-gradient(135deg, #f0f4ff 0%, #e8f0fe 50%, #f5f0ff 100%); color: #374151; line-height: 1.8; min-height: 100vh; }
  .knowledge-header { background: white; border-bottom: 1px solid #e5e7eb; padding: 12px 16px; position: sticky; top: 0; z-index: 50; }
  .knowledge-header-inner { max-width: 800px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; }
  .knowledge-header a { text-decoration: none; color: #3b82f6; font-size: 13px; font-weight: 500; }
  .knowledge-header .site-name { font-size: 15px; font-weight: 700; color: #1f2937; }
  .knowledge-breadcrumb { max-width: 800px; margin: 0 auto; padding: 12px 16px; font-size: 12px; color: #9ca3af; }
  .knowledge-breadcrumb a { color: #3b82f6; text-decoration: none; }
  .knowledge-breadcrumb a:hover { text-decoration: underline; }
  .knowledge-article { max-width: 800px; margin: 0 auto; padding: 0 16px 48px; }
  .knowledge-article h1 { font-size: 1.5rem; font-weight: 700; color: #111827; margin: 16px 0; line-height: 1.4; }
  .knowledge-article .article-meta { font-size: 12px; color: #9ca3af; margin-bottom: 24px; }
  .knowledge-article h2 { font-size: 1.2rem; font-weight: 700; color: #1f2937; margin-top: 36px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 2px solid #3b82f6; }
  .knowledge-article h3 { font-size: 1rem; font-weight: 600; color: #374151; margin-top: 16px; margin-bottom: 8px; }
  .knowledge-article p { margin-bottom: 16px; font-size: 0.95rem; }
  .knowledge-article section { margin-bottom: 8px; }
  .knowledge-faq { margin-bottom: 16px; padding: 16px; background: #f9fafb; border-radius: 8px; border-left: 4px solid #3b82f6; }
  .knowledge-faq h3 { margin-top: 0; color: #1e40af; font-size: 0.95rem; }
  .knowledge-faq p { margin-bottom: 0; font-size: 0.9rem; color: #4b5563; }
  .knowledge-cta { margin: 32px 0; padding: 24px; background: linear-gradient(135deg, #eff6ff, #eef2ff); border: 1px solid #bfdbfe; border-radius: 12px; text-align: center; }
  .knowledge-cta p { font-size: 0.95rem; color: #374151; margin-bottom: 12px; }
  .knowledge-cta a { display: inline-block; padding: 10px 24px; background: #3b82f6; color: white; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.9rem; }
  .knowledge-cta a:hover { background: #2563eb; }
  .knowledge-related { margin-top: 32px; padding: 24px; background: white; border-radius: 12px; border: 1px solid #e5e7eb; }
  .knowledge-related h2 { border-bottom: none; margin-top: 0; font-size: 1rem; }
  .knowledge-related ul { padding-left: 20px; margin-top: 12px; }
  .knowledge-related li { margin-bottom: 8px; font-size: 0.9rem; }
  .knowledge-related a { color: #3b82f6; text-decoration: none; }
  .knowledge-related a:hover { text-decoration: underline; }
  .knowledge-footer { max-width: 800px; margin: 0 auto; padding: 24px 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; text-align: center; }
  .knowledge-footer a { color: #3b82f6; text-decoration: none; }
  .knowledge-toc { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; }
  .knowledge-toc h2 { font-size: 0.9rem; margin: 0 0 8px; padding: 0; border: none; color: #6b7280; }
  .knowledge-toc ol { padding-left: 20px; margin: 0; }
  .knowledge-toc li { font-size: 0.85rem; margin-bottom: 4px; }
  .knowledge-toc a { color: #3b82f6; text-decoration: none; }
  .knowledge-toc a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <header class="knowledge-header">
    <div class="knowledge-header-inner">
      <span class="site-name">注文住宅比較.com</span>
      <div>
        <a href="/knowledge/">知識一覧</a>
        <span style="margin: 0 6px; color: #d1d5db;">|</span>
        <a href="/area/mie/">エリア比較</a>
        <span style="margin: 0 6px; color: #d1d5db;">|</span>
        <a href="/">注文住宅比較.com</a>
      </div>
    </div>
  </header>

  ${breadcrumbHtml}

  <article class="knowledge-article">
    <h1>${escHtml(article.title)}</h1>
    <div class="article-meta">最終更新: ${TODAY} ｜ 監修: <a href="/about/" style="color:#3b82f6;text-decoration:none;">注文住宅比較.com</a> 編集部</div>

    <nav class="knowledge-toc">
      <h2>目次</h2>
      <ol>
        ${article.sections.map((s, i) => `<li><a href="#section-${i + 1}">${escHtml(s.heading)}</a></li>`).join('\n        ')}
        ${article.faqs && article.faqs.length > 0 ? '<li><a href="#faq">よくある質問</a></li>' : ''}
      </ol>
    </nav>

    ${article.sections.map((s, i) => `
    <section id="section-${i + 1}">
      <h2>${escHtml(s.heading)}</h2>
      <p>${escHtml(s.body)}</p>
    </section>`).join('\n')}

    ${article.faqs && article.faqs.length > 0 ? `
    <section id="faq">
      <h2>よくある質問</h2>
      ${faqHtml}
    </section>` : ''}

    <div class="knowledge-cta">
      <p>${escHtml(article.cta_text)}</p>
      <a href="${article.cta_url}">${escHtml(article.cta_label)} →</a>
    </div>

    <div style="display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;margin:24px 0;">
      <span style="font-size:12px;color:#9ca3af;">この記事をシェア:</span>
      <a href="https://twitter.com/intent/tweet?url=${encodeURIComponent(DOMAIN + '/knowledge/' + article.id + '/')}&text=${encodeURIComponent(article.title)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;background:#000;color:white;border-radius:6px;font-size:12px;font-weight:500;text-decoration:none;">𝕏 ポスト</a>
      <a href="https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(DOMAIN + '/knowledge/' + article.id + '/')}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;background:#06c755;color:white;border-radius:6px;font-size:12px;font-weight:500;text-decoration:none;">LINE 送る</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(DOMAIN + '/knowledge/' + article.id + '/')}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;padding:6px 14px;background:#1877f2;color:white;border-radius:6px;font-size:12px;font-weight:500;text-decoration:none;">Facebook</a>
    </div>

    <div class="knowledge-related">
      <h2>関連記事</h2>
      <ul>
        ${otherArticles}
      </ul>
    </div>
  </article>

  <footer class="knowledge-footer">
    <p><a href="/">注文住宅比較.com</a> | <a href="/area/mie/">三重県エリア比較</a> | <a href="/knowledge/">注文住宅の知識</a></p>
    <p style="margin-top: 8px;">データ出典: <a href="https://www.reinfolib.mlit.go.jp/" rel="noopener">国土交通省 不動産情報ライブラリ</a></p>
    <p style="margin-top: 4px;">&copy; 注文住宅比較.com</p>
  </footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Generate Knowledge Hub Page (/knowledge/index.html)
// ---------------------------------------------------------------------------
function generateKnowledgeHubPage() {
  const articles = knowledgeData.articles;

  const breadcrumbItems = [
    { name: 'トップ', url: '/' },
    { name: '注文住宅の知識', url: '/knowledge/' }
  ];
  const breadcrumbJsonLd = buildBreadcrumbJsonLd(breadcrumbItems);

  const articleCards = articles.map(a => `
    <a href="/knowledge/${a.id}/" class="knowledge-hub-card">
      <h2>${escHtml(a.title.split('｜')[0])}</h2>
      <p>${escHtml(a.description.substring(0, 100))}...</p>
    </a>`).join('\n');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="google-site-verification" content="VBmM5Mikm2LrkY9dXa30MUHtT9KD2SpZFsoGHBuFPWM" />
<script async src="https://www.googletagmanager.com/gtag/js?id=G-SZV3XF0W0G"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-SZV3XF0W0G');
</script>
<title>注文住宅の知識｜費用・流れ・土地選び・建蔽率容積率 | 注文住宅比較.com</title>
<meta name="description" content="注文住宅を建てる方に必要な知識を網羅。費用の内訳、家づくりの流れ、土地探しのコツ、建蔽率・容積率の基礎知識、三重県の住みやすい街ランキングなど、専門的な情報をわかりやすく解説します。">
<meta name="keywords" content="注文住宅,知識,費用,流れ,土地探し,建蔽率,容積率,三重県">
<link rel="canonical" href="${DOMAIN}/knowledge/">
<meta property="og:title" content="注文住宅の知識｜費用・流れ・土地選び・建蔽率容積率">
<meta property="og:description" content="注文住宅を建てる方に必要な知識を網羅。費用の内訳、家づくりの流れ、土地探しのコツ、建蔽率・容積率の基礎知識など。">
<meta property="og:type" content="website">
<meta property="og:url" content="${DOMAIN}/knowledge/">
<meta property="og:site_name" content="注文住宅比較.com">
<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="summary_large_image">
${breadcrumbJsonLd}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Noto Sans JP', sans-serif; background: linear-gradient(135deg, #f0f4ff 0%, #e8f0fe 50%, #f5f0ff 100%); color: #374151; line-height: 1.8; min-height: 100vh; }
  .knowledge-header { background: white; border-bottom: 1px solid #e5e7eb; padding: 12px 16px; position: sticky; top: 0; z-index: 50; }
  .knowledge-header-inner { max-width: 800px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; }
  .knowledge-header a { text-decoration: none; color: #3b82f6; font-size: 13px; font-weight: 500; }
  .knowledge-header .site-name { font-size: 15px; font-weight: 700; color: #1f2937; }
  .knowledge-hub { max-width: 800px; margin: 0 auto; padding: 24px 16px 48px; }
  .knowledge-hub h1 { font-size: 1.5rem; font-weight: 700; color: #111827; margin-bottom: 8px; }
  .knowledge-hub .hub-desc { font-size: 0.9rem; color: #6b7280; margin-bottom: 24px; }
  .knowledge-hub-card { display: block; background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; margin-bottom: 16px; text-decoration: none; transition: all 0.2s; }
  .knowledge-hub-card:hover { border-color: #93c5fd; box-shadow: 0 4px 12px rgba(59,130,246,0.1); transform: translateY(-2px); }
  .knowledge-hub-card h2 { font-size: 1.05rem; font-weight: 700; color: #1f2937; margin-bottom: 6px; }
  .knowledge-hub-card p { font-size: 0.85rem; color: #6b7280; margin: 0; }
  .knowledge-hub-cta { margin: 32px 0; padding: 24px; background: linear-gradient(135deg, #eff6ff, #eef2ff); border: 1px solid #bfdbfe; border-radius: 12px; text-align: center; }
  .knowledge-hub-cta p { font-size: 0.95rem; color: #374151; margin-bottom: 12px; }
  .knowledge-hub-cta a { display: inline-block; padding: 10px 24px; background: #3b82f6; color: white; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.9rem; margin: 4px; }
  .knowledge-hub-cta a:hover { background: #2563eb; }
  .knowledge-footer { max-width: 800px; margin: 0 auto; padding: 24px 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; text-align: center; }
  .knowledge-footer a { color: #3b82f6; text-decoration: none; }
</style>
</head>
<body>
  <header class="knowledge-header">
    <div class="knowledge-header-inner">
      <span class="site-name">注文住宅比較.com</span>
      <div>
        <a href="/area/mie/">エリア比較</a>
        <span style="margin: 0 6px; color: #d1d5db;">|</span>
        <a href="/">注文住宅比較.com</a>
      </div>
    </div>
  </header>

  <main class="knowledge-hub">
    <h1>注文住宅の知識</h1>
    <p class="hub-desc">注文住宅を建てる方に必要な知識を、費用・流れ・土地選び・法規制など分野別にまとめました。</p>

    ${articleCards}

    <div class="knowledge-hub-cta">
      <p>知識を身につけたら、実際のデータで検討を始めましょう</p>
      <a href="/area/mie/">三重県エリア比較 →</a>
      <a href="/" style="background:#10b981;">注文住宅比較.com →</a>
    </div>
  </main>

  <footer class="knowledge-footer">
    <p><a href="/">注文住宅比較.com</a> | <a href="/area/mie/">三重県エリア比較</a></p>
    <p style="margin-top: 8px;">&copy; 注文住宅比較.com</p>
  </footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Generate sitemap.xml
// ---------------------------------------------------------------------------
function generateSitemap() {
  const urls = [
    { loc: '/', priority: '1.0', changefreq: 'weekly' },
    { loc: '/area/mie/', priority: '0.9', changefreq: 'weekly' },
    ...CITIES.map(c => ({ loc: `/area/mie/${c.id}/`, priority: '0.8', changefreq: 'weekly' })),
    { loc: '/knowledge/', priority: '0.8', changefreq: 'monthly' },
    ...knowledgeData.articles.map(a => ({ loc: `/knowledge/${a.id}/`, priority: '0.7', changefreq: 'monthly' })),
    { loc: '/about/', priority: '0.3', changefreq: 'monthly' }
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${DOMAIN}${u.loc}</loc>
    <lastmod>${TODAY}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
  return xml;
}

// ---------------------------------------------------------------------------
// HTML minification (terser for inline JS, strip comments/whitespace)
// ---------------------------------------------------------------------------
async function minifyHtml(html) {
  // Minify inline <script> blocks (skip JSON-LD and external src scripts)
  const scriptRe = /<script(?![^>]*\btype\s*=\s*["']application\/ld\+json["'])(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;
  const matches = [...html.matchAll(scriptRe)];
  for (const m of matches) {
    const original = m[2];
    if (!original.trim()) continue;
    try {
      const result = await minify(original, {
        compress: true,
        mangle: false,  // onclick等のHTML属性で関数名を参照しているため
      });
      if (result.code) {
        html = html.replace(m[0], `<script${m[1]}>${result.code}</script>`);
      }
    } catch (e) {
      console.warn('  ⚠ terser minify warning:', e.message?.substring(0, 80));
    }
  }
  // Strip HTML comments (keep IE conditionals)
  html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
  // Collapse runs of whitespace between tags
  html = html.replace(/>\s{2,}</g, '> <');
  return html;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Building pages...');

  // Hub page
  const hubDir = join(ROOT, 'area', 'mie');
  ensureDir(hubDir);
  const hubHtml = await minifyHtml(generateHubPage());
  writeFileSync(join(hubDir, 'index.html'), hubHtml, 'utf-8');
  console.log('  ✓ area/mie/index.html');

  // City pages
  for (const city of CITIES) {
    const cityDir = join(hubDir, city.id);
    ensureDir(cityDir);
    const cityHtml = await minifyHtml(generateCityPage(city.id));
    writeFileSync(join(cityDir, 'index.html'), cityHtml, 'utf-8');
    console.log(`  ✓ area/mie/${city.id}/index.html`);
  }

  // Knowledge hub page
  const knowledgeDir = join(ROOT, 'knowledge');
  ensureDir(knowledgeDir);
  const knowledgeHubHtml = await minifyHtml(generateKnowledgeHubPage());
  writeFileSync(join(knowledgeDir, 'index.html'), knowledgeHubHtml, 'utf-8');
  console.log('  ✓ knowledge/index.html');

  // Knowledge article pages
  for (const article of knowledgeData.articles) {
    const articleDir = join(knowledgeDir, article.id);
    ensureDir(articleDir);
    const articleHtml = await minifyHtml(generateKnowledgePage(article));
    writeFileSync(join(articleDir, 'index.html'), articleHtml, 'utf-8');
    console.log(`  ✓ knowledge/${article.id}/index.html`);
  }

  // About page
  const aboutDir = join(ROOT, 'about');
  ensureDir(aboutDir);
  writeFileSync(join(aboutDir, 'index.html'), await minifyHtml(generateAboutPage()), 'utf-8');
  console.log('  ✓ about/index.html');

  // Sitemap
  const sitemap = generateSitemap();
  writeFileSync(join(ROOT, 'sitemap.xml'), sitemap, 'utf-8');
  console.log('  ✓ sitemap.xml');

  const articleCount = knowledgeData.articles.length;
  console.log(`Done! Generated 1 hub + 7 city pages + 1 knowledge hub + ${articleCount} articles + about + sitemap.`);
}

main();
