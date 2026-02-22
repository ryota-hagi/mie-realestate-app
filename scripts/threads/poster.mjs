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
// 投稿の長さをランダムに決める（人間はいつも同じ長さで書かない）
// ============================================================

function getRandomLength() {
  const r = Math.random();
  if (r < 0.25) return '超短く。10〜30文字。単語か一言で終われ。文章にするな。';
  if (r < 0.55) return '短く。50〜100文字。1〜2文で終われ。';
  return '普通の長さ。100〜200文字。2〜3文。';
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
        userPrompt: `${topic.city}で自分が家建てた時の経験を1つ投稿して。

ネタ: ${topic.tip?.title || '住宅事情'} - ${topic.tip?.body || 'この地域で家を建てた経験'}

詳しい人として、具体的な数字や仕様を交えて語れ。良かったことも後悔も正直に。

長さ: ${getRandomLength()}`,
        topicKey: topic.topicKey,
      };
    }

    case 'mame': {
      const topic = getMameTopic(knowledgeData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'taiken', label: '体験談' }, dataSources, trendResult);
      return {
        userPrompt: `家づくりで意外と知られてないことを1つ投稿して。

ネタ: ${topic.section?.heading || '住宅の豆知識'} - ${(topic.section?.body || '注文住宅に関する知識').slice(0, 200)}

「これ知らない人多いけど」「意外と見落とされがちだけど」くらいの切り口で。詳しい人として語れ。

長さ: ${getRandomLength()}`,
        topicKey: topic.topicKey,
      };
    }

    case 'data': {
      const topic = getDataTopic(liveData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'mame', label: '豆知識' }, dataSources, trendResult);
      return {
        userPrompt: `土地や不動産のデータから気づいたことを1つ投稿して。

データ: ${topic.insight.text}

数字を使って具体的に。詳しい人がデータを見て思ったこと・気づきとして。長い分析はするな。

長さ: ${getRandomLength()}`,
        topicKey: topic.topicKey,
      };
    }

    case 'kiji': {
      const topic = getKijiTopic(knowledgeData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'mame', label: '豆知識' }, dataSources, trendResult);
      return {
        userPrompt: `この記事について自分の意見を1つ投稿して。URLも貼れ。

記事: ${topic.article.title} - ${topic.article.description || ''}
URL: ${topic.url}

詳しい人として「これ読んだけど、実際は〜」のように自分の経験と絡めた感想を。記事の要約はするな。

長さ: ${getRandomLength()}`,
        topicKey: topic.topicKey,
        isArticle: true,
      };
    }

    case 'area': {
      const topic = getAreaTopic(cityData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'taiken', label: '体験談' }, dataSources, trendResult);
      const overview = topic.city.seo_sections?.overview || '';
      return {
        userPrompt: `${topic.city.nameJa}の土地事情や住環境について1つ投稿して。

参考: ${overview.slice(0, 200)}

坪単価、利便性、ハザードマップ等の具体的な情報を交えろ。良いことも微妙なことも正直に。

長さ: ${getRandomLength()}`,
        topicKey: topic.topicKey,
      };
    }

    case 'shippai': {
      const topic = getShippaiTopic(cityData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'taiken', label: '体験談' }, dataSources, trendResult);
      return {
        userPrompt: `あれだけ調べたのに失敗したことを1つ投稿して。

ネタ: ${(topic.mistakes || '間取りの失敗、収納不足、日当たりの問題など').slice(0, 300)}

詳しい人でも見落とす盲点として語れ。「調べまくったのに」「わかってたはずなのに」的な悔しさを出せ。

長さ: ${getRandomLength()}`,
        topicKey: topic.topicKey,
      };
    }

    case 'loan': {
      const topic = getLoanTopic(knowledgeData);
      if (isTopicCoolingDown(topic.topicKey)) return buildPrompt({ id: 'mame', label: '豆知識' }, dataSources, trendResult);
      const sectionHeading = topic.section?.heading || '住宅ローン・資金計画';
      const sectionBody = topic.section?.body || '注文住宅を建てるときの費用や住宅ローンの選び方について';
      return {
        userPrompt: `住宅ローンや資金計画について1つ投稿して。

ネタ: ${sectionHeading} - ${sectionBody.slice(0, 200)}

金利、月々の返済額、繰上げ返済計画など具体的な数字を使え。詳しい人として自分の判断や計算を語れ。

長さ: ${getRandomLength()}`,
        topicKey: topic.topicKey,
      };
    }

    case 'kisetsu': {
      const month = new Date().getMonth() + 1;
      const topics = SEASONAL_TOPICS[month] || SEASONAL_TOPICS[1];
      const topicText = randomChoice(topics);
      const topicKey = `kisetsu:${month}:${topics.indexOf(topicText)}`;
      const lengthInstruction = getRandomLength();
      if (isTopicCoolingDown(topicKey)) {
        const altText = topics.find((t, i) => !isTopicCoolingDown(`kisetsu:${month}:${i}`)) || topicText;
        return {
          userPrompt: `この時期の家づくり・住まいについて1つ投稿して。

ネタ: ${altText}

季節と住宅性能（断熱、気密、換気等）を絡めて、詳しい人として具体的に。

長さ: ${lengthInstruction}`,
          topicKey: `kisetsu:${month}:${topics.indexOf(altText)}`,
        };
      }
      return {
        userPrompt: `この時期の家づくり・住まいについて1つ投稿して。

ネタ: ${topicText}

季節と住宅性能（断熱、気密、換気等）を絡めて、詳しい人として具体的に。

長さ: ${lengthInstruction}`,
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
  // 長さ指示をログに出力（デバッグ用）
  const lengthMatch = userPrompt.match(/長さ: (.+)/);
  if (lengthMatch) console.log(`📏 長さ指示: ${lengthMatch[1]}`);

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
