#!/usr/bin/env node
/**
 * バッチ不動産データ取得スクリプト
 * GitHub Actionsで週1回実行し、MCP経由で取引データを取得 → data/live-data.json に保存
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'data', 'live-data.json');

// ============================================================
// Configuration
// ============================================================
const CONFIG = {
  PROXY_URL: 'https://jvfmvitknqnmuduyscnl.supabase.co/functions/v1/mcp-proxy',
  MCP_REINFO: 'https://mcp.n-3.ai/mcp?tools=get-time,reinfolib-real-estate-price,reinfolib-city-list',
};

const AREAS = [
  { id: 'yokkaichi', name: '四日市市', cityCode: '24202' },
  { id: 'kuwana',    name: '桑名市',   cityCode: '24205' },
  { id: 'suzuka',    name: '鈴鹿市',   cityCode: '24207' },
  { id: 'inabe',     name: 'いなべ市', cityCode: '24212' },
  { id: 'kameyama',  name: '亀山市',   cityCode: '24210' },
  { id: 'komono',    name: '菰野町',   cityCode: '24341' },
  { id: 'toin',      name: '東員町',   cityCode: '24343' },
];

const YEAR_QUARTERS = [
  { year: '2024', quarter: '4' }, { year: '2024', quarter: '3' },
  { year: '2024', quarter: '2' }, { year: '2024', quarter: '1' },
  { year: '2023', quarter: '4' }, { year: '2023', quarter: '3' },
  { year: '2023', quarter: '2' }, { year: '2023', quarter: '1' },
  { year: '2022', quarter: '4' }, { year: '2022', quarter: '3' },
  { year: '2022', quarter: '2' }, { year: '2022', quarter: '1' },
  { year: '2021', quarter: '4' }, { year: '2021', quarter: '3' },
  { year: '2021', quarter: '2' }, { year: '2021', quarter: '1' },
  { year: '2020', quarter: '4' }, { year: '2020', quarter: '3' },
  { year: '2020', quarter: '2' }, { year: '2020', quarter: '1' },
];

// ============================================================
// MCP Client (Node.js port)
// ============================================================
class MCPClient {
  constructor(mcpUrl, proxyUrl) {
    this.mcpUrl = mcpUrl;
    this.proxyUrl = proxyUrl;
    this.sessionId = null;
    this.requestId = 0;
    this.connected = false;
    this.useProxy = !!proxyUrl;
  }

  _buildFetchUrl() {
    if (this.useProxy) {
      return `${this.proxyUrl}?url=${encodeURIComponent(this.mcpUrl)}`;
    }
    return this.mcpUrl;
  }

  async initialize() {
    const attempts = this.useProxy ? [true, false] : [false];
    let lastError;

    for (const viaProxy of attempts) {
      try {
        this.useProxy = viaProxy;
        const url = this._buildFetchUrl();

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++this.requestId,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'mie-realestate-batch', version: '1.0.0' }
            }
          })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const sid = res.headers.get('Mcp-Session-Id') || res.headers.get('mcp-session-id');
        if (sid) this.sessionId = sid;

        const data = await this._parseResponse(res);

        // Send initialized notification
        const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

        await fetch(this._buildFetchUrl(), {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
        });

        this.connected = true;
        console.log(`✅ MCP connected via ${viaProxy ? 'proxy' : 'direct'}`);
        return data;
      } catch (e) {
        lastError = e;
        console.warn(`⚠️ MCP ${viaProxy ? 'proxy' : 'direct'} failed:`, e.message);
      }
    }
    this.connected = false;
    throw lastError;
  }

  async listTools() {
    const data = await this._request('tools/list', {});
    if (data && data.tools) return data.tools;
    return [];
  }

  async callTool(name, args = {}) {
    return this._request('tools/call', { name, arguments: args });
  }

  async _request(method, params) {
    const url = this._buildFetchUrl();
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return this._parseResponse(res);
  }

  async _parseResponse(res) {
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('text/event-stream')) {
      const text = await res.text();
      const lines = text.split('\n');
      let lastData = null;
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { lastData = JSON.parse(line.slice(6)); } catch {}
        }
      }
      return lastData?.result || lastData;
    }
    const json = await res.json();
    return json.result || json;
  }
}

// ============================================================
// Data Processing (same logic as browser version)
// ============================================================
function extractTransactionsFromMCPResponse(data) {
  let content = data;
  if (content && content.content) content = content.content;
  if (!Array.isArray(content)) {
    if (content && content.data && Array.isArray(content.data)) return content.data;
    if (content && typeof content === 'string') {
      try {
        const p = JSON.parse(content);
        if (p.data && Array.isArray(p.data)) return p.data;
      } catch {}
    }
    return [];
  }
  const textContent = content.find(c => c.type === 'text');
  if (!textContent) return [];
  try {
    const parsed = JSON.parse(textContent.text);
    if (parsed.data && Array.isArray(parsed.data)) return parsed.data;
    for (const key of Object.keys(parsed)) {
      if (Array.isArray(parsed[key]) && parsed[key].length > 0) return parsed[key];
    }
  } catch {}
  return [];
}

function deduplicateRecords(records) {
  const seen = new Set();
  return records.filter(d => {
    const key = [
      d.TradePrice || '',
      d.DistrictName || d.Region || '',
      d.Area || '',
      d.Period || '',
      d.Type || d.TradeType || '',
      d.BuildingYear || '',
      d.NearestStation || '',
      d.FloorPlan || '',
      d.Structure || ''
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTransactions(records) {
  return records.map(d => ({
    TradePrice: (d.TradePrice != null && d.TradePrice !== '') ? parseInt(d.TradePrice) : null,
    Type: d.Type || d.TradeType || '',
    Area: d.Area ? parseFloat(d.Area) : null,
    FloorPlan: d.FloorPlan || '',
    BuildingYear: d.BuildingYear || '',
    NearestStation: d.NearestStation || '',
    DistanceToStation: d.TimeToNearestStation || d.DistanceToStation || '',
    Use: d.Use || d.Purpose || '',
    District: d.DistrictName || d.Region || '',
    Structure: d.Structure || '',
    CityPlanning: d.CityPlanning || '',
    Period: d.Period || '',
  }));
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('🏠 三重県北部 不動産データ バッチ取得開始');
  console.log(`📅 ${new Date().toISOString()}`);
  console.log(`📍 対象エリア: ${AREAS.map(a => a.name).join(', ')}`);
  console.log(`📊 取得期間: ${YEAR_QUARTERS.length}四半期 (2020Q1 - 2024Q4)`);
  console.log('');

  // MCP接続（リトライ3回）
  let client;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      client = new MCPClient(CONFIG.MCP_REINFO, CONFIG.PROXY_URL);
      await client.initialize();
      const tools = await client.listTools();
      console.log(`🔧 利用可能ツール: ${tools.map(t => t.name).join(', ')}`);
      break;
    } catch (e) {
      console.error(`❌ MCP接続失敗 (${attempt}/3): ${e.message}`);
      if (attempt === 3) {
        console.error('💥 MCP接続に3回失敗しました。終了します。');
        process.exit(1);
      }
      // 5秒待ってリトライ
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  const result = {
    fetchedAt: new Date().toISOString(),
    areas: {}
  };

  // 全エリアのデータ取得
  for (const area of AREAS) {
    console.log(`\n📍 ${area.name} (${area.cityCode}) のデータ取得開始...`);

    const allRecords = [];
    let successCount = 0;
    let failCount = 0;

    for (const yq of YEAR_QUARTERS) {
      try {
        const priceData = await client.callTool('reinfolib-real-estate-price', {
          year: yq.year,
          quarter: yq.quarter,
          area: '24',
          city: area.cityCode
        });
        const records = extractTransactionsFromMCPResponse(priceData);
        allRecords.push(...records);
        successCount++;

        // レート制限回避（100msウェイト）
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        failCount++;
        console.warn(`  ⚠️ ${yq.year}Q${yq.quarter} 失敗: ${e.message}`);
      }
    }

    console.log(`  📊 ${successCount}/${YEAR_QUARTERS.length} 四半期取得成功 (${failCount}件失敗)`);

    // 重複排除 → 正規化
    const unique = deduplicateRecords(allRecords);
    const transactions = normalizeTransactions(unique);

    console.log(`  📋 ${allRecords.length} → ${unique.length} 件（重複排除後）`);

    // 平均取引価格
    const prices = transactions.filter(t => t.TradePrice != null).map(t => t.TradePrice);
    const avgTradePrice = prices.length > 0
      ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
      : null;

    result.areas[area.id] = {
      cityCode: area.cityCode,
      name: area.name,
      transactions,
      avgTradePrice,
      transactionCount: transactions.length,
    };

    console.log(`  ✅ ${area.name}: ${transactions.length}件, 平均${avgTradePrice ? (avgTradePrice / 10000).toFixed(0) + '万円' : 'N/A'}`);
  }

  // 書き出し
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2), 'utf-8');

  // サマリー
  const totalTx = Object.values(result.areas).reduce((sum, a) => sum + a.transactionCount, 0);
  console.log('\n' + '='.repeat(50));
  console.log(`✅ 全エリア取得完了`);
  console.log(`📊 合計: ${totalTx.toLocaleString()} 件`);
  console.log(`💾 保存先: ${OUTPUT_PATH}`);
  console.log(`📅 取得日時: ${result.fetchedAt}`);

  for (const area of AREAS) {
    const d = result.areas[area.id];
    console.log(`   ${area.name}: ${d.transactionCount}件`);
  }
}

main().catch(e => {
  console.error('💥 Fatal error:', e);
  process.exit(1);
});
