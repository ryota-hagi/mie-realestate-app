#!/usr/bin/env node
/**
 * Threads 週次分析レポート
 * - 全アカウントのエンゲージメントを集計
 * - バズ投稿・ワースト投稿の特徴を抽出
 * - Claude で改善提案を生成
 * - Telegram に送信
 *
 * 実行: node scripts/threads/analyzer.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../../data');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '6981924809';

// ============================================================
// データ読み込み
// ============================================================

function loadHistory(account) {
  const path = resolve(DATA_DIR, `threads-history-${account}.json`);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.posts || []);
  } catch {
    return [];
  }
}

// ============================================================
// 集計ロジック
// ============================================================

function analyzeAccount(posts, account) {
  const withEng = posts.filter(p => p.engagement?.views > 0);
  if (withEng.length === 0) return null;

  const totalViews = withEng.reduce((s, p) => s + (p.engagement?.views || 0), 0);
  const totalLikes = withEng.reduce((s, p) => s + (p.engagement?.likes || 0), 0);
  const totalReplies = withEng.reduce((s, p) => s + (p.engagement?.replies || 0), 0);
  const avgViews = Math.round(totalViews / withEng.length);

  const sorted = [...withEng].sort((a, b) => (b.engagement?.views || 0) - (a.engagement?.views || 0));
  const top3 = sorted.slice(0, 3);
  const worst3 = sorted.slice(-3).reverse();

  // カテゴリ別パフォーマンス
  const catStats = {};
  for (const p of withEng) {
    const cat = p.category || 'unknown';
    if (!catStats[cat]) catStats[cat] = { views: 0, count: 0 };
    catStats[cat].views += p.engagement?.views || 0;
    catStats[cat].count++;
  }
  const catRanking = Object.entries(catStats)
    .map(([cat, s]) => ({ cat, avg: Math.round(s.views / s.count) }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 3);

  // 文字数分析
  const buzzAvgChars = Math.round(top3.reduce((s, p) => s + (p.charCount || p.text?.length || 0), 0) / top3.length);

  return {
    account,
    postCount: withEng.length,
    totalViews, totalLikes, totalReplies, avgViews,
    top3, worst3, catRanking, buzzAvgChars,
  };
}

// ============================================================
// Claude で改善提案生成
// ============================================================

async function generateInsights(allStats) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('[analyzer] ANTHROPIC_API_KEY なし。改善提案をスキップ');
    return null;
  }

  const summary = allStats.map(s => {
    if (!s) return '';
    const topPosts = s.top3.map(p =>
      `  - views:${p.engagement.views} likes:${p.engagement.likes} [${p.category}] "${p.text?.slice(0, 60)}"`
    ).join('\n');
    const worstPosts = s.worst3.map(p =>
      `  - views:${p.engagement.views} [${p.category}] "${p.text?.slice(0, 40)}"`
    ).join('\n');
    const cats = s.catRanking.map(c => `${c.cat}(avg ${c.avg})`).join(' > ');
    return `【${s.account}】投稿${s.postCount}件 avgViews:${s.avgViews} totalViews:${s.totalViews}
バズTOP3:\n${topPosts}
ワースト3:\n${worstPosts}
カテゴリ強い順: ${cats}
バズ投稿の平均文字数: ${s.buzzAvgChars}文字`;
  }).join('\n\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `以下はThreadsの各アカウントのエンゲージメントデータです。
分析して改善提案を3点以内・日本語・箇条書きで簡潔にまとめてください。
「来週の投稿でこう変えるべき」という実践的なアドバイスのみ。

${summary}`,
      }],
    }),
  });

  const data = await res.json();
  return data.content?.[0]?.text || null;
}

// ============================================================
// 構造化インサイト生成（poster.mjs へのフィードバック用）
// ============================================================

function buildSummaryText(allStats) {
  return allStats.map(s => {
    if (!s) return '';
    const topPosts = s.top3.map(p =>
      `  - views:${p.engagement.views} likes:${p.engagement.likes} replies:${p.engagement.replies || 0} [${p.category}] "${p.text?.slice(0, 80)}"`
    ).join('\n');
    const worstPosts = s.worst3.map(p =>
      `  - views:${p.engagement.views} [${p.category}] "${p.text?.slice(0, 60)}"`
    ).join('\n');
    const cats = s.catRanking.map(c => `${c.cat}(avg ${c.avg})`).join(' > ');
    return `【${s.account}】投稿${s.postCount}件 avgViews:${s.avgViews}
バズTOP3:\n${topPosts}
ワースト3:\n${worstPosts}
カテゴリ強い順: ${cats}
バズ投稿の平均文字数: ${s.buzzAvgChars}文字`;
  }).join('\n\n');
}

async function generateStructuredInsights(allStats) {
  if (!ANTHROPIC_API_KEY) return null;

  const summary = buildSummaryText(allStats);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      tool_choice: { type: 'tool', name: 'save_insights' },
      tools: [{
        name: 'save_insights',
        description: '週次分析のインサイトを保存する',
        input_schema: {
          type: 'object',
          required: ['accounts'],
          properties: {
            accounts: {
              type: 'object',
              description: 'アカウント別のインサイト。キーはアカウント名（a1, a2, a3等）',
              additionalProperties: {
                type: 'object',
                required: ['strategy', 'categoryTips', 'contentPatterns'],
                properties: {
                  strategy: { type: 'string', description: 'このアカウントの来週の全体方針（1文）' },
                  categoryTips: {
                    type: 'object',
                    description: 'カテゴリ別改善アドバイス（最大3カテゴリ）。キーはカテゴリID',
                    additionalProperties: { type: 'string' },
                  },
                  contentPatterns: {
                    type: 'object',
                    required: ['toneAdvice', 'endingAdvice'],
                    properties: {
                      toneAdvice: { type: 'string', description: 'トーンに関するアドバイス（1文）' },
                      endingAdvice: { type: 'string', description: '締め方のアドバイス（1文）' },
                    },
                  },
                },
              },
            },
          },
        },
      }],
      messages: [{
        role: 'user',
        content: `以下はThreadsの各アカウントのエンゲージメント分析データです。
各アカウント別に「来週の投稿をどう改善すべきか」を分析してください。

注意:
- categoryTipsは反応が良かったカテゴリと悪かったカテゴリの両方について書く（最大3カテゴリ）
- バズった投稿の共通パターンから具体的に学べることを書く
- 抽象的なアドバイスではなく「〜で終わる投稿を増やす」「〜文字以内にする」等の実践的な指示にする

データ:
${summary}`,
      }],
    }),
  });

  const data = await res.json();
  if (data.error) {
    console.warn('[analyzer] API error:', JSON.stringify(data.error));
    return null;
  }
  const toolBlock = data.content?.find(b => b.type === 'tool_use');
  if (!toolBlock?.input?.accounts) {
    console.warn('[analyzer] tool_use応答なし');
    return null;
  }

  return {
    generatedAt: new Date().toISOString(),
    accounts: toolBlock.input.accounts,
  };
}

// ============================================================
// Telegram 送信
// ============================================================

async function sendTelegram(text) {
  // bot token がなければ env ファイルから取得を試みる
  let token = TELEGRAM_BOT_TOKEN;
  if (!token) {
    try {
      const envPath = '/Users/arigat-office/.openclaw/pipeline-watchdog/secrets/pipeline.env';
      const envRaw = readFileSync(envPath, 'utf8');
      const match = envRaw.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
      if (match) token = match[1].trim();
    } catch { /* ignore */ }
  }
  if (!token) {
    console.log('[analyzer] Telegram token なし。標準出力に出力します\n');
    console.log(text);
    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram送信失敗: ${JSON.stringify(data)}`);
}

// ============================================================
// レポート組み立て
// ============================================================

function buildReport(allStats, insights) {
  const now = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
  let report = `📊 <b>Threads週次レポート ${now}</b>\n\n`;

  for (const s of allStats) {
    if (!s) continue;
    const accLabel = { a1: 'みえマイホーム日記', a2: 'ミニマル家づくり', a3: 'アラフォー二世帯' }[s.account] || s.account;
    report += `<b>【${accLabel}】</b>\n`;
    report += `投稿${s.postCount}件 / 累計${s.totalViews.toLocaleString()}views / likes${s.totalLikes}\n`;
    report += `平均 ${s.avgViews.toLocaleString()}views/投稿\n`;
    if (s.top3.length > 0) {
      const top = s.top3[0];
      report += `🔥 最高: ${top.engagement.views.toLocaleString()}views「${top.text?.slice(0, 30)}…」\n`;
    }
    report += `強カテゴリ: ${s.catRanking.map(c => c.cat).join(' > ')}\n\n`;
  }

  if (insights) {
    report += `<b>💡 改善提案（Claude分析）</b>\n${insights}\n`;
  }

  return report.trim();
}

// ============================================================
// メイン
// ============================================================

async function main() {
  console.log('[analyzer] 分析開始');

  const accounts = ['a1', 'a2', 'a3'];
  const allStats = accounts.map(acc => {
    const posts = loadHistory(acc);
    const stats = analyzeAccount(posts, acc);
    if (stats) {
      console.log(`[analyzer] ${acc}: ${stats.postCount}件 avgViews:${stats.avgViews}`);
    } else {
      console.log(`[analyzer] ${acc}: engagementデータなし`);
    }
    return stats;
  });

  const validStats = allStats.filter(Boolean);
  if (validStats.length === 0) {
    console.log('[analyzer] 分析できるデータなし。終了');
    return;
  }

  console.log('[analyzer] Claude で改善提案を生成中...');
  const insights = await generateInsights(validStats);

  const report = buildReport(validStats, insights);
  console.log('[analyzer] レポート生成完了\n', report);

  // 構造化インサイトを生成・保存（poster.mjs へのフィードバック）
  console.log('[analyzer] 構造化インサイトを生成中...');
  const structuredInsights = await generateStructuredInsights(validStats);
  if (structuredInsights) {
    const insightsPath = resolve(DATA_DIR, 'threads-insights.json');
    writeFileSync(insightsPath, JSON.stringify(structuredInsights, null, 2), 'utf-8');
    console.log('[analyzer] 構造化インサイト保存完了:', insightsPath);
  } else {
    console.warn('[analyzer] 構造化インサイト生成失敗。スキップ');
  }

  console.log('[analyzer] Telegram送信中...');
  await sendTelegram(report);
  console.log('[analyzer] 完了');
}

main().catch(err => {
  console.error('[analyzer] エラー:', err);
  process.exit(1);
});
