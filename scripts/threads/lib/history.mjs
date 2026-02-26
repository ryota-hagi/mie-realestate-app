/**
 * 投稿履歴の読み書き・重複防止・エンゲージメント分析
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const HISTORY_PATH = join(ROOT, 'data', 'threads-history.json');
const TRENDS_PATH = join(ROOT, 'data', 'threads-trends.json');

const HISTORY_RETENTION_DAYS = 90;
const TOPIC_COOLDOWN_DAYS = 14;
const CATEGORY_COOLDOWN_DAYS = 1;
const LEARNING_WINDOW_DAYS = 30;

// ============================================================
// 履歴読み書き
// ============================================================

/**
 * 投稿履歴を読み込む
 * @returns {{ posts: Array }}
 */
export function loadHistory() {
  if (!existsSync(HISTORY_PATH)) {
    return { posts: [] };
  }
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'));
  } catch {
    return { posts: [] };
  }
}

/**
 * 投稿履歴に追記して保存
 * @param {object} entry - { date, category, topicKey, text, threadId, charCount }
 */
export function saveHistory(entry) {
  const history = loadHistory();
  history.posts.push(entry);

  // 古い履歴を削除（90日以前）
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - HISTORY_RETENTION_DAYS);
  history.posts = history.posts.filter(p => new Date(p.date) > cutoff);

  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
}

// ============================================================
// 重複チェック
// ============================================================

/**
 * 指定カテゴリが直近で使われたかチェック
 * @param {string} categoryId
 * @returns {boolean} true = クールダウン中（使用不可）
 */
export function isCategoryCoolingDown(categoryId) {
  // トレンドカテゴリは連続OK（別トピックなので）
  if (categoryId === 'trend') return false;

  const history = loadHistory();
  if (history.posts.length === 0) return false;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CATEGORY_COOLDOWN_DAYS);

  return history.posts.some(p =>
    p.category === categoryId && new Date(p.date) > cutoff
  );
}

/**
 * 指定トピックキーが直近14日以内に使われたかチェック
 * @param {string} topicKey
 * @returns {boolean} true = クールダウン中（使用不可）
 */
export function isTopicCoolingDown(topicKey) {
  const history = loadHistory();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TOPIC_COOLDOWN_DAYS);

  return history.posts.some(p =>
    p.topicKey === topicKey && new Date(p.date) > cutoff
  );
}

// ============================================================
// トレンドデータ読み書き
// ============================================================

/**
 * トレンドスキャン結果を読み込む
 * @returns {{ scannedAt: string, keywords: object }}
 */
export function loadTrends() {
  if (!existsSync(TRENDS_PATH)) {
    return { scannedAt: null, keywords: {} };
  }
  try {
    return JSON.parse(readFileSync(TRENDS_PATH, 'utf-8'));
  } catch {
    return { scannedAt: null, keywords: {} };
  }
}

/**
 * トレンドスキャン結果を保存
 * @param {object} trends - { scannedAt, keywords }
 */
export function saveTrends(trends) {
  writeFileSync(TRENDS_PATH, JSON.stringify(trends, null, 2), 'utf-8');
}

// ============================================================
// 返信履歴（同じ投稿に二重返信しない）
// ============================================================

/**
 * 指定投稿IDに既に返信済みかチェック
 * @param {string} threadId - 返信先の投稿ID
 * @returns {boolean}
 */
export function hasRepliedTo(threadId) {
  const history = loadHistory();
  return history.posts.some(p => p.repliedTo === threadId);
}

// ============================================================
// エンゲージメント追跡・自己学習
// ============================================================

/**
 * 投稿のエンゲージメントデータを更新
 * @param {string} threadId - 投稿ID
 * @param {object} engagement - { views, likes, replies, reposts, quotes }
 */
export function updatePostEngagement(threadId, engagement) {
  const history = loadHistory();
  const post = history.posts.find(p => p.threadId === threadId);
  if (post) {
    post.engagement = engagement;
    post.engagementScore = calcEngagementScore(engagement);
    post.engagementUpdatedAt = new Date().toISOString();
    writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
  }
}

/**
 * エンゲージメントスコアを計算
 */
function calcEngagementScore(engagement) {
  return (
    (engagement.replies || 0) * 4 +
    (engagement.reposts || 0) * 2 +
    (engagement.quotes || 0) * 3 +
    (engagement.likes || 0) * 1
  );
}

/**
 * エンゲージメント未取得の投稿一覧（24時間以上前の投稿）
 * @returns {Array} エンゲージメント未取得の投稿
 */
export function getPostsNeedingEngagement() {
  const history = loadHistory();
  const oneDayAgo = new Date();
  oneDayAgo.setHours(oneDayAgo.getHours() - 24);

  return history.posts.filter(p =>
    p.threadId &&
    p.threadId !== 'dry-run' &&
    !p.repliedTo &&
    !p.engagement &&
    new Date(p.date) < oneDayAgo
  );
}

/**
 * カテゴリ別のエンゲージメント分析
 * 直近30日のデータから、各カテゴリの平均エンゲージメントスコアを算出
 * @returns {object} { categoryId: { avgScore, postCount, topPatterns } }
 */
export function analyzeCategoryPerformance() {
  const history = loadHistory();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LEARNING_WINDOW_DAYS);

  // エンゲージメントデータがある投稿のみ対象
  const recentWithEngagement = history.posts.filter(p =>
    new Date(p.date) > cutoff &&
    p.engagement &&
    !p.repliedTo
  );

  if (recentWithEngagement.length === 0) {
    return null;
  }

  const categoryStats = {};

  for (const post of recentWithEngagement) {
    if (!categoryStats[post.category]) {
      categoryStats[post.category] = {
        totalScore: 0,
        postCount: 0,
        posts: [],
      };
    }
    const stat = categoryStats[post.category];
    stat.totalScore += post.engagementScore || 0;
    stat.postCount++;
    stat.posts.push({
      text: post.text,
      score: post.engagementScore || 0,
      charCount: post.charCount,
    });
  }

  // 平均スコアを算出し、上位投稿パターンを抽出
  const result = {};
  for (const [catId, stat] of Object.entries(categoryStats)) {
    stat.posts.sort((a, b) => b.score - a.score);
    result[catId] = {
      avgScore: stat.postCount > 0 ? stat.totalScore / stat.postCount : 0,
      postCount: stat.postCount,
      topPosts: stat.posts.slice(0, 3),
    };
  }

  return result;
}

/**
 * エンゲージメント分析に基づくカテゴリ重みボーナスを算出
 * 平均以上のカテゴリはボーナスを得て、平均以下はペナルティ
 * @param {object} baseCategories - 基本カテゴリ配列
 * @returns {Array} 重み調整済みカテゴリ配列
 */
export function getAdjustedWeights(baseCategories) {
  const perf = analyzeCategoryPerformance();
  if (!perf) return baseCategories;

  // 全体平均を算出
  const allScores = Object.values(perf);
  if (allScores.length < 3) return baseCategories; // データ不足

  const totalAvg = allScores.reduce((sum, s) => sum + s.avgScore, 0) / allScores.length;
  if (totalAvg === 0) return baseCategories;

  return baseCategories.map(cat => {
    const catPerf = perf[cat.id];
    if (!catPerf || catPerf.postCount < 2) return cat; // データ不足のカテゴリは変更なし

    // 平均比で重みを調整（±50%の範囲内）
    const ratio = catPerf.avgScore / totalAvg;
    const multiplier = Math.max(0.5, Math.min(1.5, ratio));
    const adjustedWeight = Math.round(cat.weight * multiplier);

    if (multiplier !== 1) {
      console.log(`   📊 ${cat.id}: 重み ${cat.weight} → ${adjustedWeight} (平均スコア: ${catPerf.avgScore.toFixed(1)}, 全体平均: ${totalAvg.toFixed(1)})`);
    }

    return { ...cat, weight: adjustedWeight };
  });
}

// ============================================================
// 投稿履歴コンテキスト（AI生成時に渡す）
// ============================================================

/**
 * 直近の投稿履歴をAIコンテキスト用に整形して返す
 * - 直近7日の投稿（最大20件）を時系列で取得
 * - エンゲージメントスコアが高い投稿に★マーク
 * @returns {string} コンテキスト文字列（投稿がなければ空文字）
 */
export function getRecentPostsContext() {
  const history = loadHistory();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);

  const recentPosts = history.posts
    .filter(p => !p.repliedTo && new Date(p.date) > cutoff)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 20);

  if (recentPosts.length === 0) return '';

  const lines = recentPosts.map(p => {
    const d = new Date(p.date);
    const dateStr = `${d.getMonth() + 1}/${d.getDate()}`;
    const firstLine = (p.text || '').split('\n')[0].slice(0, 60);
    const score = p.engagementScore || 0;
    const star = score >= 30 ? ` ★反応良(スコア${score})` : '';
    return `[${dateStr} ${p.category}] ${firstLine}${star}`;
  });

  return `\n\n【直近の投稿履歴】同じ話を繰り返すな。矛盾した発言をするな。★マークの投稿は反応が良かったので「前も言ったけど」等で触れてもOK。\n${lines.join('\n')}`;
}

/**
 * 直近30日でエンゲージメントスコア上位の投稿を返す
 * @param {number} limit - 取得件数（デフォルト5）
 * @returns {Array} 上位投稿の配列
 */
export function getHighEngagementPosts(limit = 5) {
  const history = loadHistory();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  return history.posts
    .filter(p => !p.repliedTo && p.engagementScore > 0 && new Date(p.date) > cutoff)
    .sort((a, b) => (b.engagementScore || 0) - (a.engagementScore || 0))
    .slice(0, limit);
}

/**
 * 高パフォーマンス投稿のパターンをプロンプトに反映するためのヒントを生成
 * @param {string} categoryId - カテゴリID
 * @returns {string|null} パフォーマンスヒント文字列
 */
export function getPerformanceHint(categoryId) {
  const perf = analyzeCategoryPerformance();
  if (!perf || !perf[categoryId]) return null;

  const topPosts = perf[categoryId].topPosts;
  if (!topPosts || topPosts.length === 0) return null;

  // スコアが高い投稿のみ（スコア5以上）
  const goodPosts = topPosts.filter(p => p.score >= 5);
  if (goodPosts.length === 0) return null;

  const examples = goodPosts
    .slice(0, 2)
    .map(p => `「${p.text.replace(/\n.*$/s, '').slice(0, 60)}」(スコア${p.score})`)
    .join('\n');

  // 長さパターン分析
  const avgCharCount = goodPosts.reduce((sum, p) => sum + p.charCount, 0) / goodPosts.length;
  const lengthHint = avgCharCount < 50 ? '短い投稿' : avgCharCount < 120 ? '中くらいの長さ' : '少し長めの投稿';

  return `\n\n【学習データ】このカテゴリで反応が良かった投稿:\n${examples}\n→ ${lengthHint}が反応良い傾向。同じような構造・トーンで書いて。`;
}
