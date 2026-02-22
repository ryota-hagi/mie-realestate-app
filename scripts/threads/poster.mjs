#!/usr/bin/env node
/**
 * Threads 自動投稿スクリプト
 * 1. トレンドスキャン (Threads keyword_search)
 * 2. カテゴリ選択 (トレンド40% / 自社データ60%)
 * 3. Claude Haiku で投稿文生成
 * 4. Threads API で投稿
 *
 * GitHub Actions で毎日 06:00 JST に実行
 */

import { publishPost, checkAndRefreshToken } from './lib/threads-api.mjs';
import { generatePost, generateArticlePost } from './lib/ai-generator.mjs';
import { loadAllData, randomChoice, getTaikenTopic, getMameTopic, getDataTopic, getKijiTopic, getAreaTopic, getShippaiTopic, getLoanTopic } from './lib/data-loader.mjs';
import { scanTrends, buildTrendPrompt } from './lib/trend-scanner.mjs';
import { loadHistory, saveHistory, isCategoryCoolingDown, isTopicCoolingDown } from './lib/history.mjs';
import { CATEGORIES, SEASONAL_TOPICS, HASHTAGS, SITE_URL } from './lib/config.mjs';

const DRY_RUN = process.env.DRY_RUN === 'true';
const FORCE_CATEGORY = process.env.FORCE_CATEGORY || null;

// ============================================================
// カテゴリ選択
// ============================================================

function selectCategory(trendAvailable) {
  if (FORCE_CATEGORY) {
    const forced = CATEGORIES.find(c => c.id === FORCE_CATEGORY);
    if (forced) {
      console.log(`🎯 強制カテゴリ: ${forced.id} (${forced.label})`);
      return forced;
    }
    console.warn(`⚠️ 不明なカテゴリ: ${FORCE_CATEGORY}. ランダム選択にフォールバック。`);
  }

  // トレンドが検出されなかった場合、トレンドカテゴリの重みを0にする
  const categories = CATEGORIES.map(c => ({
    ...c,
    weight: (c.id === 'trend' && !trendAvailable) ? 0 : c.weight,
  })).filter(c => c.weight > 0);

  // クールダウン中のカテゴリを除外
  const available = categories.filter(c => !isCategoryCoolingDown(c.id));

  if (available.length === 0) {
    // 全部クールダウン中なら制限解除して選択
    return categories[Math.floor(Math.random() * categories.length)];
  }

  // 重み付きランダム選択
  const totalWeight = available.reduce((sum, c) => sum + c.weight, 0);
  let random = Math.random() * totalWeight;
  for (const cat of available) {
    random -= cat.weight;
    if (random <= 0) return cat;
  }

  return available[available.length - 1];
}

// ============================================================
// プロンプト構築
// ============================================================

function buildPrompt(category, dataSources, trendResult) {
  const { cityData, knowledgeData, liveData } = dataSources;

  switch (category.id) {
    case 'trend': {
      const trend = trendResult.trending[0];
      return buildTrendPrompt(trend);
    }

    case 'taiken': {
      const topic = getTaikenTopic(cityData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'mame', label: '豆知識' }, dataSources, trendResult);
      return {
        userPrompt: `以下の情報をもとに、自分の体験談のようなThreads投稿を書いてください。
まるで自分が実際にその土地で家を建てた人のように語ってください。

情報: ${topic.city}の${topic.tip?.title || '住宅事情'} - ${topic.tip?.body || 'この地域で家を建てた経験'}

投稿には「${topic.city}」を含めてください。`,
        topicKey: topic.topicKey,
      };
    }

    case 'mame': {
      const topic = getMameTopic(knowledgeData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'taiken', label: '体験談' }, dataSources, trendResult);
      return {
        userPrompt: `以下の情報から、「へぇ〜知らなかった！」と思わせる豆知識投稿を書いてください。
友達に教えるように、驚きや発見を共有する感じで。

情報: ${topic.section?.heading || '住宅の豆知識'} - ${(topic.section?.body || '注文住宅に関する知識').slice(0, 300)}

「〜って知ってた？」「マジでこれ知らなかった」のような切り出しがおすすめ。`,
        topicKey: topic.topicKey,
      };
    }

    case 'data': {
      const topic = getDataTopic(liveData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'mame', label: '豆知識' }, dataSources, trendResult);
      return {
        userPrompt: `以下の実際の取引データを元に、「へぇ〜そうなんだ」と思わせるThreads投稿を書いてください。

データ: ${topic.insight.text}

数字を自然に会話に織り込んでください。出典は「国交省の取引データ」とさりげなく触れてOK。
「調べてみたらこうだった」「先輩からこんな話聞いた」のような切り口で。`,
        topicKey: topic.topicKey,
      };
    }

    case 'kiji': {
      const topic = getKijiTopic(knowledgeData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'mame', label: '豆知識' }, dataSources, trendResult);
      return {
        userPrompt: `以下のナレッジ記事を、友達に「これ読んでみて」とすすめるような投稿を書いてください。

記事タイトル: ${topic.article.title}
記事概要: ${topic.article.description}
URL: ${topic.url}

URLは投稿の後半に自然に入れてください。
「詳しくはこちら」のような企業っぽい誘導はNG。
「まとめた記事あるから見てみて」くらいのカジュアルさで。`,
        topicKey: topic.topicKey,
        isArticle: true,
      };
    }

    case 'area': {
      const topic = getAreaTopic(cityData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'taiken', label: '体験談' }, dataSources, trendResult);
      const overview = topic.city.seo_sections?.overview || '';
      return {
        userPrompt: `以下のエリア情報をもとに、「このエリア、実は穴場かも」と思わせるThreads投稿を書いてください。

エリア: ${topic.city.nameJa}
概要: ${overview.slice(0, 300)}

実際に住んでいる人の目線で、具体的なエピソードを交えて。`,
        topicKey: topic.topicKey,
      };
    }

    case 'shippai': {
      const topic = getShippaiTopic(cityData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'taiken', label: '体験談' }, dataSources, trendResult);
      return {
        userPrompt: `以下の失敗事例から1つ選んで、自分が実際に体験したかのような失敗談投稿を書いてください。

エリア: ${topic.city}
よくある失敗: ${(topic.mistakes || '間取りの失敗、収納不足、日当たりの問題など').slice(0, 400)}

「こうしておけばよかった…」「これはマジで後悔」のような切り口で。
最後に読者への注意喚起を自然に入れてください。`,
        topicKey: topic.topicKey,
      };
    }

    case 'loan': {
      const topic = getLoanTopic(knowledgeData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'mame', label: '豆知識' }, dataSources, trendResult);
      const sectionHeading = topic.section?.heading || '住宅ローン・資金計画';
      const sectionBody = topic.section?.body || '注文住宅を建てるときの費用や住宅ローンの選び方について';
      return {
        userPrompt: `以下の住宅費用・ローン情報をもとに、自分の体験として語る投稿を書いてください。

情報: ${sectionHeading} - ${sectionBody.slice(0, 300)}

「住宅ローンがこうだった」「資金計画でこう考えた」のような切り口で。
具体的な金額を自然に交えてリアリティを出してください。`,
        topicKey: topic.topicKey,
      };
    }

    case 'kisetsu': {
      const month = new Date().getMonth() + 1;
      const topics = SEASONAL_TOPICS[month] || SEASONAL_TOPICS[1];
      const topicText = randomChoice(topics);
      const topicKey = `kisetsu:${month}:${topics.indexOf(topicText)}`;
      if (isTopicCoolingDown(topicKey)) {
        const altText = topics.find((t, i) => !isTopicCoolingDown(`kisetsu:${month}:${i}`)) || topicText;
        return {
          userPrompt: `以下のテーマでThreads投稿を書いてください。

テーマ: ${altText}

今の時期ならではの住宅ネタとして、自分の体験を交えて語ってください。`,
          topicKey: `kisetsu:${month}:${topics.indexOf(altText)}`,
        };
      }
      return {
        userPrompt: `以下のテーマでThreads投稿を書いてください。

テーマ: ${topicText}

今の時期ならではの住宅ネタとして、自分の体験を交えて語ってください。`,
        topicKey,
      };
    }

    default:
      throw new Error(`未知のカテゴリ: ${category.id}`);
  }
}

// ============================================================
// メイン
// ============================================================

async function main() {
  console.log('🧵 Threads自動投稿 開始');
  console.log(`📅 ${new Date().toISOString()}`);
  if (DRY_RUN) console.log('🏃 DRY RUN モード（投稿はスキップ）');

  // トークンチェック
  if (!DRY_RUN) {
    const tokenStatus = await checkAndRefreshToken();
    if (!tokenStatus.valid) {
      console.error('❌ Threadsトークンが無効です。手動で更新してください。');
      process.exit(1);
    }
  }

  // データ読込
  const dataSources = loadAllData();
  console.log('📊 データソース読込完了');

  // トレンドスキャン
  let trendResult = { trending: [] };
  if (!DRY_RUN) {
    try {
      trendResult = await scanTrends();
    } catch (e) {
      console.warn(`⚠️ トレンドスキャン失敗（フォールバック）: ${e.message}`);
    }
  }

  // カテゴリ選択
  const trendAvailable = trendResult.trending.length > 0;
  const category = selectCategory(trendAvailable);
  console.log(`📝 カテゴリ: ${category.id} (${category.label})`);

  // プロンプト構築
  const { userPrompt, topicKey, isArticle } = buildPrompt(category, dataSources, trendResult);
  console.log(`🔑 トピックキー: ${topicKey}`);

  // AI生成
  console.log('🤖 投稿文生成中...');
  const postText = isArticle
    ? await generateArticlePost(userPrompt)
    : await generatePost(userPrompt);

  console.log(`✅ 生成テキスト (${postText.length}文字):`);
  console.log('---');
  console.log(postText);
  console.log('---');

  // 投稿
  let threadId = 'dry-run';
  if (!DRY_RUN) {
    console.log('📤 Threads投稿中...');
    const result = await publishPost(postText);
    threadId = result.id;
    console.log(`🧵 投稿完了: ID=${threadId}`);
  } else {
    console.log('🏃 DRY RUN: 投稿スキップ');
  }

  // 履歴保存
  saveHistory({
    date: new Date().toISOString(),
    category: category.id,
    topicKey,
    text: postText,
    threadId,
    charCount: postText.length,
  });
  console.log('💾 履歴保存完了');

  console.log('✅ 完了');
}

main().catch(e => {
  console.error('💥 Fatal error:', e);
  process.exit(1);
});
