/**
 * 投稿履歴の読み書き・重複防止
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
