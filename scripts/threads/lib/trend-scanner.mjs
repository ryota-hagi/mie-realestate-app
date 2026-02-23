/**
 * トレンド調査モジュール
 * Threads keyword_search を使って住宅関連の盛り上がりトピックを検出
 */

import { keywordSearch, getInsights } from './threads-api.mjs';
import { SEARCH_KEYWORDS } from './config.mjs';
import { loadTrends, saveTrends } from './history.mjs';

// ============================================================
// キーワード選択
// ============================================================

/**
 * 今日検索するキーワード一覧を取得（最大10個）
 * 住宅系メインから6個 + ローカルから2個 + 季節から2個
 */
function selectKeywords() {
  const month = new Date().getMonth() + 1;
  const keywords = [];

  // 住宅系からランダムに6個
  const housing = [...SEARCH_KEYWORDS.housing];
  for (let i = 0; i < 6 && housing.length > 0; i++) {
    const idx = Math.floor(Math.random() * housing.length);
    keywords.push(housing.splice(idx, 1)[0]);
  }

  // ローカルからランダムに2個
  const local = [...SEARCH_KEYWORDS.local];
  for (let i = 0; i < 2 && local.length > 0; i++) {
    const idx = Math.floor(Math.random() * local.length);
    keywords.push(local.splice(idx, 1)[0]);
  }

  // 季節キーワードから2個
  const seasonal = SEARCH_KEYWORDS.seasonal[month] || [];
  const seasonalCopy = [...seasonal];
  for (let i = 0; i < 2 && seasonalCopy.length > 0; i++) {
    const idx = Math.floor(Math.random() * seasonalCopy.length);
    keywords.push(seasonalCopy.splice(idx, 1)[0]);
  }

  return keywords;
}

// ============================================================
// エンゲージメントスコア
// ============================================================

function calcEngagementScore(insights) {
  return (
    (insights.replies || 0) * 4 +
    (insights.reposts || 0) * 2 +
    (insights.quotes || 0) * 3 +
    (insights.likes || 0) * 1
  );
}

// ============================================================
// トレンドスキャン
// ============================================================

/**
 * トレンドスキャンを実行
 * @returns {{ trending: Array, topPosts: Array, keywords: object }}
 */
export async function scanTrends() {
  console.log('🔍 トレンドスキャン開始...');
  const keywords = selectKeywords();
  console.log(`   検索キーワード: ${keywords.join(', ')}`);

  const since = new Date();
  since.setHours(since.getHours() - 24);
  const sinceStr = since.toISOString().split('T')[0];

  const prevTrends = loadTrends();
  const newKeywordData = {};

  for (const keyword of keywords) {
    try {
      console.log(`   🔎 "${keyword}" を検索中...`);
      const posts = await keywordSearch(keyword, { since: sinceStr, limit: 10 });
      console.log(`      → ${posts.length}件ヒット`);

      // 上位5件のエンゲージメントを取得
      const topPosts = posts.slice(0, 5);
      let totalScore = 0;
      const enrichedPosts = [];

      for (const post of topPosts) {
        const insights = await getInsights(post.id);
        const score = calcEngagementScore(insights);
        totalScore += score;
        enrichedPosts.push({ ...post, insights, score });
      }

      newKeywordData[keyword] = {
        resultCount: posts.length,
        totalScore,
        avgScore: topPosts.length > 0 ? totalScore / topPosts.length : 0,
        topPosts: enrichedPosts.sort((a, b) => b.score - a.score).slice(0, 3),
      };

      // API呼出間にちょっと待つ
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.warn(`   ⚠️ "${keyword}" 検索失敗: ${e.message}`);
      newKeywordData[keyword] = { resultCount: 0, totalScore: 0, avgScore: 0, topPosts: [] };
    }
  }

  // 前回との比較でトレンド検出
  const trending = [];

  for (const [keyword, data] of Object.entries(newKeywordData)) {
    const prevData = prevTrends.keywords?.[keyword];

    const isTrending =
      // スコアが前回の2倍以上
      (prevData && prevData.totalScore > 0 && data.totalScore >= prevData.totalScore * 2) ||
      // 新規で高スコア（前回データなし）
      (!prevData && data.totalScore >= 20) ||
      // 絶対値として高スコア
      data.totalScore >= 50;

    if (isTrending && data.topPosts.length > 0) {
      trending.push({
        keyword,
        totalScore: data.totalScore,
        prevScore: prevData?.totalScore || 0,
        topPosts: data.topPosts,
      });
    }
  }

  // スコア順にソート
  trending.sort((a, b) => b.totalScore - a.totalScore);

  // トレンドデータを保存
  const trendsData = {
    scannedAt: new Date().toISOString(),
    keywords: newKeywordData,
  };
  saveTrends(trendsData);

  console.log(`✅ トレンドスキャン完了: ${trending.length}件のトレンド検出`);
  for (const t of trending) {
    console.log(`   📈 "${t.keyword}" スコア: ${t.totalScore} (前回: ${t.prevScore})`);
  }

  return {
    trending,
    allKeywordData: newKeywordData,
  };
}

/**
 * トレンド結果から投稿プロンプト用のコンテキストを生成
 * @param {object} trend - trending配列の1要素
 * @returns {{ userPrompt: string, topicKey: string }}
 */
export function buildTrendPrompt(trend) {
  const topPostsSummary = trend.topPosts
    .filter(p => p.text)
    .slice(0, 3)
    .map(p => {
      const likes = p.insights?.likes || 0;
      const replies = p.insights?.replies || 0;
      return `「${p.text.slice(0, 80)}${p.text.length > 80 ? '...' : ''}」(いいね${likes}, 返信${replies})`;
    })
    .join('\n  ');

  const userPrompt = `以下はThreadsで今盛り上がっているトピックです:
- キーワード「${trend.keyword}」の投稿が直近24時間で盛り上がっている
- 特に反応が多い投稿:
  ${topPostsSummary}

この話題に自然に乗れるThreads投稿を書いて。
自分の体験や気持ちとして語って。専門用語は使うな。
元の投稿をコピーしたり直接言及しないこと。
「わかる」「うちもそうだった」「自分もそれで悩んだ」みたいな共感ベースで。
読んだ人が「この人も同じなんだ」って思えるように。`;

  return {
    userPrompt,
    topicKey: `trend:${trend.keyword}:${new Date().toISOString().split('T')[0]}`,
  };
}
