/**
 * 投稿履歴の読み書き・重複防止・エンゲージメント分析
 * マルチアカウント対応: account パラメータで履歴ファイルを切替
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const TRENDS_PATH = join(ROOT, 'data', 'threads-trends.json');
const REPLY_HISTORY_PATH = join(ROOT, 'data', 'threads-reply-history.json');

const HISTORY_RETENTION_DAYS = 90;
const TOPIC_COOLDOWN_DAYS = 14;
const CATEGORY_COOLDOWN_DAYS = 1;
const LEARNING_WINDOW_DAYS = 30;

// ============================================================
// アカウント別ファイルパス
// ============================================================

function getHistoryPath(account = null) {
  if (account && account !== 'business') {
    return join(ROOT, 'data', `threads-history-${account}.json`);
  }
  return join(ROOT, 'data', 'threads-history.json');
}

// ============================================================
// 履歴読み書き
// ============================================================

/**
 * 投稿履歴を読み込む
 * @param {string|null} account - アカウント ('a1','a2','a3','business',null)
 * @returns {{ posts: Array }}
 */
export function loadHistory(account = null) {
  const path = getHistoryPath(account);
  if (!existsSync(path)) {
    return { posts: [] };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { posts: [] };
  }
}

/**
 * 投稿履歴に追記して保存
 * @param {object} entry - { date, category, topicKey, text, threadId, charCount }
 * @param {string|null} account
 */
export function saveHistory(entry, account = null) {
  const history = loadHistory(account);
  history.posts.push(entry);

  // 古い履歴を削除（90日以前）
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - HISTORY_RETENTION_DAYS);
  history.posts = history.posts.filter(p => new Date(p.date) > cutoff);

  writeFileSync(getHistoryPath(account), JSON.stringify(history, null, 2), 'utf-8');
}

// ============================================================
// 重複チェック
// ============================================================

/**
 * 指定カテゴリが直近で使われたかチェック
 * @param {string} categoryId
 * @param {string|null} account
 * @returns {boolean} true = クールダウン中（使用不可）
 */
export function isCategoryCoolingDown(categoryId, account = null) {
  // トレンドカテゴリは連続OK（別トピックなので）
  if (categoryId === 'trend') return false;

  const history = loadHistory(account);
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
 * @param {string|null} account
 * @returns {boolean} true = クールダウン中（使用不可）
 */
export function isTopicCoolingDown(topicKey, account = null) {
  const history = loadHistory(account);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TOPIC_COOLDOWN_DAYS);

  return history.posts.some(p =>
    p.topicKey === topicKey && new Date(p.date) > cutoff
  );
}

// ============================================================
// トレンドデータ読み書き（共有・アカウント非依存）
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
 * 指定投稿IDに既に返信済みかチェック（投稿履歴ベース）
 * @param {string} threadId - 返信先の投稿ID
 * @param {string|null} account
 * @returns {boolean}
 */
export function hasRepliedTo(threadId, account = null) {
  const history = loadHistory(account);
  return history.posts.some(p => p.repliedTo === threadId);
}

// ============================================================
// 業者アカウント自動リプライ履歴
// ============================================================

/**
 * リプライ履歴を読み込む（業者→ステマ投稿への返信記録）
 * @returns {{ replies: Array }}
 */
export function loadReplyHistory() {
  if (!existsSync(REPLY_HISTORY_PATH)) {
    return { replies: [] };
  }
  try {
    return JSON.parse(readFileSync(REPLY_HISTORY_PATH, 'utf-8'));
  } catch {
    return { replies: [] };
  }
}

/**
 * リプライ履歴に追記して保存
 * @param {object} entry - { date, targetThreadId, targetAccount, replyThreadId, replyText, buzzLevel }
 */
export function saveReplyHistory(entry) {
  const history = loadReplyHistory();
  history.replies.push(entry);

  // 90日以前の履歴を削除
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - HISTORY_RETENTION_DAYS);
  history.replies = history.replies.filter(r => new Date(r.date) > cutoff);

  writeFileSync(REPLY_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
}

/**
 * 指定投稿IDに業者アカウントから既にリプライ済みかチェック
 * @param {string} threadId
 * @returns {boolean}
 */
export function hasRepliedToPost(threadId) {
  const history = loadReplyHistory();
  return history.replies.some(r => r.targetThreadId === threadId);
}

/**
 * 今日の業者リプライ件数を取得（1日上限チェック用）
 * @returns {number}
 */
export function getTodayReplyCount() {
  const history = loadReplyHistory();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return history.replies.filter(r => new Date(r.date) >= today).length;
}

// ============================================================
// エンゲージメント追跡・自己学習
// ============================================================

/**
 * 投稿のエンゲージメントデータを更新
 * @param {string} threadId - 投稿ID
 * @param {object} engagement - { views, likes, replies, reposts, quotes }
 * @param {string|null} account
 */
export function updatePostEngagement(threadId, engagement, account = null) {
  const history = loadHistory(account);
  const post = history.posts.find(p => p.threadId === threadId);
  if (post) {
    post.engagement = engagement;
    post.engagementScore = calcEngagementScore(engagement);
    post.engagementUpdatedAt = new Date().toISOString();
    writeFileSync(getHistoryPath(account), JSON.stringify(history, null, 2), 'utf-8');
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
 * @param {string|null} account
 * @returns {Array} エンゲージメント未取得の投稿
 */
export function getPostsNeedingEngagement(account = null) {
  const history = loadHistory(account);
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
 * @param {string|null} account
 * @returns {object} { categoryId: { avgScore, postCount, topPatterns } }
 */
export function analyzeCategoryPerformance(account = null) {
  const history = loadHistory(account);
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
 * @param {object} baseCategories - 基本カテゴリ配列
 * @param {string|null} account
 * @returns {Array} 重み調整済みカテゴリ配列
 */
export function getAdjustedWeights(baseCategories, account = null) {
  const perf = analyzeCategoryPerformance(account);
  if (!perf) return baseCategories;

  const allScores = Object.values(perf);
  if (allScores.length < 3) return baseCategories;

  const totalAvg = allScores.reduce((sum, s) => sum + s.avgScore, 0) / allScores.length;
  if (totalAvg === 0) return baseCategories;

  return baseCategories.map(cat => {
    const catPerf = perf[cat.id];
    if (!catPerf || catPerf.postCount < 2) return cat;

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
 * @param {string|null} account
 * @returns {string} コンテキスト文字列（投稿がなければ空文字）
 */
export function getRecentPostsContext(account = null) {
  const history = loadHistory(account);
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
 * @param {number} limit
 * @param {string|null} account
 * @returns {Array}
 */
export function getHighEngagementPosts(limit = 5, account = null) {
  const history = loadHistory(account);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  return history.posts
    .filter(p => !p.repliedTo && p.engagementScore > 0 && new Date(p.date) > cutoff)
    .sort((a, b) => (b.engagementScore || 0) - (a.engagementScore || 0))
    .slice(0, limit);
}

/**
 * 高パフォーマンス投稿のパターンヒントを生成
 * @param {string} categoryId
 * @param {string|null} account
 * @returns {string|null}
 */
export function getPerformanceHint(categoryId, account = null) {
  const perf = analyzeCategoryPerformance(account);
  if (!perf || !perf[categoryId]) return null;

  const topPosts = perf[categoryId].topPosts;
  if (!topPosts || topPosts.length === 0) return null;

  const goodPosts = topPosts.filter(p => p.score >= 5);
  if (goodPosts.length === 0) return null;

  const examples = goodPosts
    .slice(0, 2)
    .map(p => `「${p.text.replace(/\n.*$/s, '').slice(0, 60)}」(スコア${p.score})`)
    .join('\n');

  const avgCharCount = goodPosts.reduce((sum, p) => sum + p.charCount, 0) / goodPosts.length;
  const lengthHint = avgCharCount < 50 ? '短い投稿' : avgCharCount < 120 ? '中くらいの長さ' : '少し長めの投稿';

  return `\n\n【学習データ】このカテゴリで反応が良かった投稿:\n${examples}\n→ ${lengthHint}が反応良い傾向。同じような構造・トーンで書いて。`;
}
