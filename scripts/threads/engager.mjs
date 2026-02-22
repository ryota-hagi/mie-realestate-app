#!/usr/bin/env node
/**
 * Threads 検索エンゲージメントスクリプト
 * 住宅関連のキーワードで検索し、盛り上がっている投稿にAIコメントを投稿
 *
 * GitHub Actions で毎日 18:00 JST に実行
 */

import { keywordSearch, getInsights, publishReply, checkAndRefreshToken } from './lib/threads-api.mjs';
import { generateReply } from './lib/ai-generator.mjs';
import { loadHistory, saveHistory, hasRepliedTo, loadTrends } from './lib/history.mjs';
import { SEARCH_KEYWORDS } from './lib/config.mjs';
import { randomChoice } from './lib/data-loader.mjs';

const DRY_RUN = process.env.DRY_RUN === 'true';
const MAX_COMMENTS_PER_RUN = parseInt(process.env.MAX_COMMENTS || '10', 10);

// ============================================================
// エンゲージメント対象の投稿を探す
// ============================================================

async function findEngageableThreads() {
  // まずトレンドスキャン結果があればそこから取得
  const trends = loadTrends();
  const candidateThreads = [];

  // トレンドデータからスコアの高い投稿を収集
  if (trends.keywords) {
    for (const [keyword, data] of Object.entries(trends.keywords)) {
      for (const post of (data.topPosts || [])) {
        if (post.score > 5 && post.text && post.text.length > 10) {
          candidateThreads.push({
            ...post,
            keyword,
            source: 'trend',
          });
        }
      }
    }
  }

  // トレンドデータが足りない場合、追加検索
  if (candidateThreads.length < MAX_COMMENTS_PER_RUN) {
    const searchKeywords = [
      ...SEARCH_KEYWORDS.housing.slice(0, 3),
      ...SEARCH_KEYWORDS.local.slice(0, 2),
    ];
    const keyword = randomChoice(searchKeywords);

    console.log(`🔎 追加検索: "${keyword}"`);
    try {
      const since = new Date();
      since.setHours(since.getHours() - 48);
      const posts = await keywordSearch(keyword, {
        since: since.toISOString().split('T')[0],
        limit: 10,
      });

      for (const post of posts) {
        if (post.text && post.text.length > 10) {
          const insights = await getInsights(post.id);
          const score = (insights.replies || 0) * 4 + (insights.reposts || 0) * 2 + (insights.likes || 0);
          candidateThreads.push({
            ...post,
            insights,
            score,
            keyword,
            source: 'search',
          });
        }
      }
    } catch (e) {
      console.warn(`⚠️ 追加検索失敗: ${e.message}`);
    }
  }

  // スコア順にソートして重複除去
  const seen = new Set();
  const unique = candidateThreads
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .filter(post => {
      if (seen.has(post.id)) return false;
      seen.add(post.id);
      return true;
    });

  return unique;
}

// ============================================================
// メイン
// ============================================================

async function main() {
  console.log('🧵 Threads検索エンゲージメント 開始');
  console.log(`📅 ${new Date().toISOString()}`);
  if (DRY_RUN) console.log('🏃 DRY RUN モード');

  // トークンチェック
  if (!DRY_RUN) {
    const tokenStatus = await checkAndRefreshToken();
    if (!tokenStatus.valid) {
      console.error('❌ Threadsトークンが無効です。');
      process.exit(1);
    }
  }

  // エンゲージ対象の投稿を探す
  console.log('🔍 エンゲージ対象の投稿を探索中...');
  const threads = await findEngageableThreads();
  console.log(`   ${threads.length}件の候補を発見`);

  let commentsPosted = 0;

  for (const thread of threads) {
    if (commentsPosted >= MAX_COMMENTS_PER_RUN) {
      console.log(`🛑 コメント上限 (${MAX_COMMENTS_PER_RUN}件) に到達`);
      break;
    }

    // 既にコメント済みならスキップ
    if (hasRepliedTo(thread.id)) {
      console.log(`   ⏭️ 既にコメント済み: ${thread.id}`);
      continue;
    }

    console.log(`   💬 [${thread.keyword}] スコア${thread.score || '?'}: "${thread.text.slice(0, 50)}..."`);

    try {
      // AIでコメント生成
      const context = `検索キーワード「${thread.keyword}」でヒットした投稿です。三重県での住宅購入経験者として自然にコメントしてください。`;
      const commentText = await generateReply(thread.text, context);

      console.log(`   ✅ 生成 (${commentText.length}文字): "${commentText.slice(0, 50)}..."`);

      // 投稿
      let commentId = 'dry-run';
      if (!DRY_RUN) {
        const result = await publishReply(thread.id, commentText);
        commentId = result.id;
        console.log(`   🧵 コメント投稿完了: ${commentId}`);

        // API呼出間にちょっと待つ（スパム防止）
        await new Promise(r => setTimeout(r, 3000));
      }

      // 履歴保存
      saveHistory({
        date: new Date().toISOString(),
        category: 'engage',
        topicKey: `engage:${thread.id}`,
        text: commentText,
        threadId: commentId,
        repliedTo: thread.id,
        keyword: thread.keyword,
        charCount: commentText.length,
      });

      commentsPosted++;
    } catch (e) {
      console.warn(`   ⚠️ コメント失敗: ${e.message}`);
      // 400エラーは権限問題の可能性が高いのでスキップ
      if (e.status === 400) continue;
    }
  }

  console.log(`✅ 完了: ${commentsPosted}件のコメントを投稿`);
}

main().catch(e => {
  console.error('💥 致命的エラー:', e);
  process.exit(1);
});
