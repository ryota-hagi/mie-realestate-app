#!/usr/bin/env node
/**
 * Threads 自動投稿スクリプト（マルチアカウント対応）
 * --account=a1|a2|a3|business で切替
 *
 * 1. エンゲージメント回収（過去投稿の反応を記録）
 * 2. 自己学習（反応が良いパターンを分析）
 * 3. トレンドスキャン (Threads keyword_search)
 * 4. カテゴリ選択（ペルソナ別重み or 学習データで重み調整）
 * 5. Claude で投稿文生成
 * 6. Threads API で投稿
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { publishPost, checkAndRefreshToken, getInsights } from './lib/threads-api.mjs';
import { generatePost, generateArticlePost } from './lib/ai-generator.mjs';
import { loadAllData, randomChoice, getTaikenTopic, getMameTopic, getKijiTopic, getLoanTopic, getAruaruTopic, getMomegotoTopic, getKoukaiTopic, getNewsTopic, getSitePrTopic, getHikakuTopic, getKinshiTopic, getGyakusetsuTopic } from './lib/data-loader.mjs';
import { scanTrends, buildTrendPrompt } from './lib/trend-scanner.mjs';
import { loadHistory, saveHistory, isCategoryCoolingDown, isTopicCoolingDown, getPostsNeedingEngagement, updatePostEngagement, getAdjustedWeights, getPerformanceHint, getRecentPostsContext } from './lib/history.mjs';
import { CATEGORIES, SEASONAL_TOPICS, PERSONA_SYSTEM_PROMPTS } from './lib/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../../data');

const DRY_RUN = process.env.DRY_RUN === 'true';
const FORCE_CATEGORY = process.env.FORCE_CATEGORY || null;

// --account パラメータ解析
const accountArg = process.argv.find(a => a.startsWith('--account='));
const ACCOUNT = accountArg ? accountArg.split('=')[1] : 'business';
const IS_STEALTH = ['a1', 'a2', 'a3'].includes(ACCOUNT);

// ============================================================
// ペルソナ読込（ステルスアカウント用）
// ============================================================

let PERSONA = null;

function loadPersona(account) {
  if (!IS_STEALTH) return null;
  try {
    const raw = readFileSync(resolve(DATA_DIR, `threads-persona-${account}.json`), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`❌ ペルソナ読込失敗: ${account}`, e.message);
    process.exit(1);
  }
}

// ============================================================
// エンゲージメント回収（自己学習用）
// ============================================================

async function collectEngagement() {
  console.log('📊 エンゲージメント回収...');
  const postsToCheck = getPostsNeedingEngagement(ACCOUNT);

  if (postsToCheck.length === 0) {
    console.log('   回収対象なし');
    return;
  }

  console.log(`   ${postsToCheck.length}件の投稿をチェック`);
  let collected = 0;

  for (const post of postsToCheck.slice(0, 10)) {
    try {
      const insights = await getInsights(post.threadId, ACCOUNT);
      updatePostEngagement(post.threadId, insights, ACCOUNT);
      collected++;
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.warn(`   ⚠️ ${post.threadId} の回収失敗: ${e.message}`);
    }
  }

  console.log(`   ✅ ${collected}件回収完了`);
}

// ============================================================
// カテゴリ選択（ペルソナ別 or 学習データで重み調整）
// ============================================================

function getPersonaCategories() {
  if (!PERSONA || !PERSONA.categories) return null;

  // ペルソナのカテゴリ比率をCATEGORIES形式に変換
  return Object.entries(PERSONA.categories).map(([id, weight]) => {
    const base = CATEGORIES.find(c => c.id === id);
    return {
      id,
      label: base ? base.label : id,
      weight,
    };
  });
}

function selectCategory(trendAvailable) {
  if (FORCE_CATEGORY) {
    const forced = CATEGORIES.find(c => c.id === FORCE_CATEGORY);
    if (forced) {
      console.log(`🎯 強制カテゴリ: ${forced.id} (${forced.label})`);
      return forced;
    }
    console.warn(`⚠️ 不明なカテゴリ: ${FORCE_CATEGORY}. ランダム選択にフォールバック。`);
  }

  // ステルスアカウントはペルソナ別カテゴリを使用
  const personaCategories = getPersonaCategories();
  let categories;

  if (personaCategories) {
    // ステルスアカウント: site/kiji は除外（業者バレする）
    categories = personaCategories.filter(c => c.id !== 'site' && c.id !== 'kiji');
    // トレンドカテゴリの重みを0にする（ステルスはトレンド不要）
    categories = categories.map(c => ({
      ...c,
      weight: (c.id === 'trend' && !trendAvailable) ? 0 : c.weight,
    })).filter(c => c.weight > 0);
  } else {
    // 業者アカウント: 既存の学習データベース重み調整
    const adjustedCategories = getAdjustedWeights(CATEGORIES, ACCOUNT);
    categories = adjustedCategories.map(c => ({
      ...c,
      weight: (c.id === 'trend' && !trendAvailable) ? 0 : c.weight,
    })).filter(c => c.weight > 0);
  }

  // クールダウン中のカテゴリを除外
  const available = categories.filter(c => !isCategoryCoolingDown(c.id, ACCOUNT));

  if (available.length === 0) {
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
// 投稿の長さ（ペルソナ別分布 or デフォルト）
// ============================================================

function getRandomLength() {
  if (PERSONA && PERSONA.lengthDistribution) {
    const dist = PERSONA.lengthDistribution;
    const r = Math.random();
    let cumulative = 0;

    cumulative += dist.superShort || 0;
    if (r < cumulative) return '超短く。10〜30文字。一言で終われ。';

    cumulative += dist.short || 0;
    if (r < cumulative) return '短く。50〜100文字。1〜2文で終われ。';

    cumulative += dist.normal || 0;
    if (r < cumulative) return '普通の長さ。100〜200文字。2〜4文。';

    return '少し長め。200〜300文字。4〜6文。でも500文字は超えるな。';
  }

  // デフォルト（業者アカウント）
  const r = Math.random();
  if (r < 0.15) return '超短く。10〜30文字。一言で終われ。';
  if (r < 0.35) return '短く。50〜100文字。1〜2文で終われ。';
  return '普通の長さ。100〜200文字。2〜4文。バズの再現性が最も高い長さ。';
}

// ============================================================
// ステルス用: プロンプトから業者感フレーズを除去
// ============================================================

function adaptPromptForPersona(prompt) {
  if (!IS_STEALTH) return prompt;

  let adapted = prompt;
  // 業者感フレーズを個人体験に変換
  adapted = adapted.replace(/相談で[多一]い[のは声]/g, '');
  adapted = adapted.replace(/「相談で聞く[のは声]/g, '「');
  adapted = adapted.replace(/みんなの声として伝えて/g, '自分の体験として語れ');
  adapted = adapted.replace(/体感[0-9]+割/g, '');
  adapted = adapted.replace(/話聞いてると/g, '');
  adapted = adapted.replace(/相談者に/g, '');
  adapted = adapted.replace(/情報を集めてる立場/g, '家を建てた当事者の立場');
  adapted = adapted.replace(/「[^」]*相談[^」]*」[^。]*。?/g, '');
  adapted = adapted.replace(/「[^」]*サイト[^」]*」[^。]*。?/g, '');
  adapted = adapted.replace(/比較サイト運営してて/g, '');
  adapted = adapted.replace(/声で多いのは/g, '');

  return adapted;
}

// ============================================================
// プロンプト構築（共感ベース）
// ============================================================

function buildPrompt(category, dataSources, trendResult) {
  const { cityData, knowledgeData, liveData } = dataSources;
  const performanceHint = getPerformanceHint(category.id, ACCOUNT) || '';
  const recentContext = getRecentPostsContext(ACCOUNT);

  switch (category.id) {
    case 'trend': {
      const trend = trendResult.trending[0];
      const result = buildTrendPrompt(trend);
      result.userPrompt = adaptPromptForPersona(result.userPrompt) + performanceHint + recentContext;
      return result;
    }

    case 'aruaru': {
      const topic = getAruaruTopic();
      if (isTopicCoolingDown(topic.topicKey, ACCOUNT)) {
        const alt = getAruaruTopic();
        if (isTopicCoolingDown(alt.topicKey, ACCOUNT)) return buildPrompt({ id: 'koukai', label: '後悔パターン' }, dataSources, trendResult);
        return buildAruaruPrompt(alt, performanceHint, recentContext);
      }
      return buildAruaruPrompt(topic, performanceHint, recentContext);
    }

    case 'koukai': {
      const topic = getKoukaiTopic();
      if (isTopicCoolingDown(topic.topicKey, ACCOUNT)) {
        const alt = getKoukaiTopic();
        if (isTopicCoolingDown(alt.topicKey, ACCOUNT)) return buildPrompt({ id: 'aruaru', label: 'あるあるネタ' }, dataSources, trendResult);
        return buildKoukaiPrompt(alt, performanceHint, recentContext);
      }
      return buildKoukaiPrompt(topic, performanceHint, recentContext);
    }

    case 'momegoto': {
      const topic = getMomegotoTopic();
      if (isTopicCoolingDown(topic.topicKey, ACCOUNT)) {
        const alt = getMomegotoTopic();
        if (isTopicCoolingDown(alt.topicKey, ACCOUNT)) return buildPrompt({ id: 'aruaru', label: 'あるあるネタ' }, dataSources, trendResult);
        return buildMomegotoPrompt(alt, performanceHint, recentContext);
      }
      return buildMomegotoPrompt(topic, performanceHint, recentContext);
    }

    case 'news': {
      const topic = getNewsTopic();
      if (isTopicCoolingDown(topic.topicKey, ACCOUNT)) {
        const alt = getNewsTopic();
        if (isTopicCoolingDown(alt.topicKey, ACCOUNT)) return buildPrompt({ id: 'aruaru', label: 'あるあるネタ' }, dataSources, trendResult);
        return buildNewsPrompt(alt, performanceHint, recentContext);
      }
      return buildNewsPrompt(topic, performanceHint, recentContext);
    }

    case 'hikaku': {
      const topic = getHikakuTopic();
      if (isTopicCoolingDown(topic.topicKey, ACCOUNT)) {
        const alt = getHikakuTopic();
        if (isTopicCoolingDown(alt.topicKey, ACCOUNT)) return buildPrompt({ id: 'koukai', label: '後悔パターン' }, dataSources, trendResult);
        return buildHikakuPrompt(alt, performanceHint, recentContext);
      }
      return buildHikakuPrompt(topic, performanceHint, recentContext);
    }

    case 'kinshi': {
      const topic = getKinshiTopic();
      if (isTopicCoolingDown(topic.topicKey, ACCOUNT)) {
        const alt = getKinshiTopic();
        if (isTopicCoolingDown(alt.topicKey, ACCOUNT)) return buildPrompt({ id: 'koukai', label: '後悔パターン' }, dataSources, trendResult);
        return buildKinshiPrompt(alt, performanceHint, recentContext);
      }
      return buildKinshiPrompt(topic, performanceHint, recentContext);
    }

    case 'gyakusetsu': {
      const topic = getGyakusetsuTopic();
      if (isTopicCoolingDown(topic.topicKey, ACCOUNT)) {
        const alt = getGyakusetsuTopic();
        if (isTopicCoolingDown(alt.topicKey, ACCOUNT)) return buildPrompt({ id: 'aruaru', label: 'あるあるネタ' }, dataSources, trendResult);
        return buildGyakusetsuPrompt(alt, performanceHint, recentContext);
      }
      return buildGyakusetsuPrompt(topic, performanceHint, recentContext);
    }

    case 'taiken': {
      const topic = getTaikenTopic(cityData);
      if (isTopicCoolingDown(topic.topicKey, ACCOUNT)) return buildPrompt({ id: 'aruaru', label: 'あるあるネタ' }, dataSources, trendResult);
      return {
        userPrompt: adaptPromptForPersona(`${topic.city}で家を建てた人から聞いた話を1つ。

ネタ: ${topic.tip?.title || '住宅事情'} - ${topic.tip?.body || 'この地域の住宅事情'}

「この地域で建てた人の声で多いのは〜」「相談で聞くのは〜」という立場で。専門用語は使わない。
1行目はフックにして、その後に空行を入れろ。文章が詰まらないように空行で区切って読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${getRandomLength()}${performanceHint}${recentContext}`),
        topicKey: topic.topicKey,
      };
    }

    case 'mame': {
      const topic = getMameTopic(knowledgeData);
      if (isTopicCoolingDown(topic.topicKey, ACCOUNT)) return buildPrompt({ id: 'aruaru', label: 'あるあるネタ' }, dataSources, trendResult);
      return {
        userPrompt: adaptPromptForPersona(`家づくりで知っておくと助かることを1つ。

ネタ: ${topic.section?.heading || '住宅の豆知識'} - ${(topic.section?.body || '注文住宅に関する知識').slice(0, 200)}

専門用語は使うな。難しいことを簡単な言葉で。「相談で多い質問」「知らなくて焦る人多い」みたいに、みんなの声として伝えて。
1行目はフックにして、その後に空行を入れろ。文章が詰まらないように空行で区切って読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${getRandomLength()}${performanceHint}${recentContext}`),
        topicKey: topic.topicKey,
      };
    }

    case 'kiji': {
      // ステルスアカウントはkijiカテゴリに来ないはずだが念のためフォールバック
      if (IS_STEALTH) return buildPrompt({ id: 'aruaru', label: 'あるあるネタ' }, dataSources, trendResult);
      const topic = getKijiTopic(knowledgeData);
      if (isTopicCoolingDown(topic.topicKey, ACCOUNT)) return buildPrompt({ id: 'mame', label: '豆知識・役立ち' }, dataSources, trendResult);
      return {
        userPrompt: `この記事のテーマについて、情報を集めてる立場からの感想を1つ。

テーマ: ${topic.article.title} - ${topic.article.description || ''}

専門用語は使わない。「この話題、相談者にもよく共有してる」「これ知らない人多いんだよね」みたいに。
URLは本文に貼るな（リーチが激減するから）。記事の内容に触れるだけでいい。
1行目はフックにして、その後に空行を入れろ。文章が詰まらないように空行で区切って読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${getRandomLength()}${performanceHint}${recentContext}`,
        topicKey: topic.topicKey,
      };
    }

    case 'loan': {
      const topic = getLoanTopic(knowledgeData);
      if (isTopicCoolingDown(topic.topicKey, ACCOUNT)) return buildPrompt({ id: 'koukai', label: '後悔パターン' }, dataSources, trendResult);
      const sectionHeading = topic.section?.heading || '住宅ローン・資金計画';
      const sectionBody = topic.section?.body || '注文住宅を建てるときの費用や住宅ローンの選び方について';
      return {
        userPrompt: adaptPromptForPersona(`住宅ローンやお金の相談で多い声を1つ。

ネタ: ${sectionHeading} - ${sectionBody.slice(0, 200)}

専門用語は使わない。「お金の相談で一番多いのは〜」「見積もりでびっくりする人多い」みたいに、みんなの声として伝えて。
1行目はフックにして、その後に空行を入れろ。文章が詰まらないように空行で区切って読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${getRandomLength()}${performanceHint}${recentContext}`),
        topicKey: topic.topicKey,
      };
    }

    case 'kisetsu': {
      const month = new Date().getMonth() + 1;
      const topics = SEASONAL_TOPICS[month] || SEASONAL_TOPICS[1];
      const topicText = randomChoice(topics);
      const topicKey = `kisetsu:${month}:${topics.indexOf(topicText)}`;
      const lengthInstruction = getRandomLength();
      if (isTopicCoolingDown(topicKey, ACCOUNT)) {
        const altText = topics.find((t, i) => !isTopicCoolingDown(`kisetsu:${month}:${i}`, ACCOUNT)) || topicText;
        return {
          userPrompt: adaptPromptForPersona(`この時期の家づくり・暮らしで相談が増える話題を1つ。

ネタ: ${altText}

専門用語は使わない。「この時期の相談で増えるのは〜」「この季節に困る人多いんだよね」みたいに。
1行目はフックにして、その後に空行を入れろ。文章が詰まらないように空行で区切って読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${lengthInstruction}${performanceHint}${recentContext}`),
          topicKey: `kisetsu:${month}:${topics.indexOf(altText)}`,
        };
      }
      return {
        userPrompt: adaptPromptForPersona(`この時期の家づくり・暮らしで相談が増える話題を1つ。

ネタ: ${topicText}

専門用語は使わない。「この時期の相談で増えるのは〜」「この季節に困る人多いんだよね」みたいに。
1行目はフックにして、その後に空行を入れろ。文章が詰まらないように空行で区切って読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${lengthInstruction}${performanceHint}${recentContext}`),
        topicKey,
      };
    }

    case 'site': {
      // ステルスアカウントはsiteカテゴリに来ないはずだが念のためフォールバック
      if (IS_STEALTH) return buildPrompt({ id: 'aruaru', label: 'あるあるネタ' }, dataSources, trendResult);
      const topic = getSitePrTopic();
      if (isTopicCoolingDown(topic.topicKey, ACCOUNT)) {
        const alt = getSitePrTopic();
        if (isTopicCoolingDown(alt.topicKey, ACCOUNT)) return buildPrompt({ id: 'aruaru', label: 'あるあるネタ' }, dataSources, trendResult);
        return buildSitePrompt(alt, performanceHint, recentContext);
      }
      return buildSitePrompt(topic, performanceHint, recentContext);
    }

    // ペルソナ固有カテゴリで CATEGORIES に無いものはフォールバック
    case 'shippai':
      return buildPrompt({ id: 'koukai', label: '後悔パターン' }, dataSources, trendResult);

    default:
      // 未知のカテゴリはaruaruにフォールバック
      console.warn(`⚠️ 未知のカテゴリ: ${category.id}. aruaruにフォールバック。`);
      return buildPrompt({ id: 'aruaru', label: 'あるあるネタ' }, dataSources, trendResult);
  }
}

// ============================================================
// カテゴリ別プロンプトビルダー
// ============================================================

function buildAruaruPrompt(topic, performanceHint, recentContext = '') {
  return {
    userPrompt: adaptPromptForPersona(`家づくりの「あるある」を1つ投稿して。みんなが「わかる！」って思えるやつ。

ネタ: ${topic.text}

「〜って人多いんだよね」「相談で聞く声で多いのは〜」みたいに、みんなの声として伝えて。
情報を伝えるんじゃなくて、共感を得るのが目的。
1行目はフック（感情を動かす短い一文）にして、その後に空行を入れろ。
文章が詰まらないように、話題の切れ目で空行を入れて読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${getRandomLength()}${performanceHint}${recentContext}`),
    topicKey: topic.topicKey,
  };
}

function buildKoukaiPrompt(topic, performanceHint, recentContext = '') {
  return {
    userPrompt: adaptPromptForPersona(`家づくりで後悔してる人の声を1つ投稿して。

ネタ: ${topic.text}

「後悔してるって声がめちゃ多い」「相談で一番聞くのは〜」みたいに、みんなの後悔を代弁して。
読んだ人が「わかる…」「自分も気をつけよう」って思えるように。
1行目はフック（断言 or 驚き）にして、その後に空行を入れろ。
文章が詰まらないように、話題の切れ目で空行を入れて読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${getRandomLength()}${performanceHint}${recentContext}`),
    topicKey: topic.topicKey,
  };
}

function buildNewsPrompt(topic, performanceHint, recentContext = '') {
  return {
    userPrompt: adaptPromptForPersona(`住宅・不動産関連のニュースや話題について、情報を集めてる立場から感想を1つ投稿して。

ネタ: ${topic.text}

「家づくり情報集めてる立場で気になったのは〜」「これ、影響受ける人多そう」みたいに。
専門用語は使わない。共感を呼ぶように。
1行目はフックにして、その後に空行を入れろ。
文章が詰まらないように空行で区切って読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${getRandomLength()}${performanceHint}${recentContext}`),
    topicKey: topic.topicKey,
  };
}

function buildSitePrompt(topic, performanceHint, recentContext = '') {
  return {
    userPrompt: `三重県の注文住宅情報サイトを運営してる立場として投稿して。

ネタ: ${topic.text}

■ 重要
- サイト運営者として堂々とPRしていい
- 「うちのサイト」として普通に紹介
- テンションは普段の投稿と同じタメ口。宣伝っぽい丁寧語はNG
- 嬉しかった、作ってよかった、使ってほしい、みたいな素直な感情で
- URLは本文に貼るな（外部リンクはリーチが激減する）。「プロフィールにリンクあるよ」と誘導しろ
- 1行目はフックにして、その後に空行を入れろ
- 文章が詰まらないように空行で区切って読みやすくしろ
- ハッシュタグはつけるな

長さ: 普通の長さ。100〜200文字。2〜3文。${performanceHint}${recentContext}`,
    topicKey: topic.topicKey,
  };
}

function buildKinshiPrompt(topic, performanceHint, recentContext = '') {
  return {
    userPrompt: adaptPromptForPersona(`家づくりで「絶対やっちゃダメなこと」を1つ投稿して。読んだ人が保存したくなるやつ。

ネタ: ${topic.text}

「情報集めてて本当に多い失敗は〜」「相談でやらかした人めちゃ見る」みたいに。
「マジでこれはやめとけ」っていう切実さを出せ。
でも上から目線にならないように。寄り添う感じで。
読んだ人が「自分も気をつけよう」って思って保存したくなるように。
1行目はフック（禁止 or 断言）にして、その後に空行を入れろ。
文章が詰まらないように空行で区切って読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${getRandomLength()}${performanceHint}${recentContext}`),
    topicKey: topic.topicKey,
  };
}

function buildGyakusetsuPrompt(topic, performanceHint, recentContext = '') {
  return {
    userPrompt: adaptPromptForPersona(`家づくりの「常識の逆」「意外な真実」を1つ投稿して。読んだ人が「えっ？」ってなってコメントしたくなるやつ。

ネタ: ${topic.text}

「色んな人の話聞いてきたけど、実は〜」「みんなこう思ってるけど、実際は違う」みたいな意外性を出せ。
でも完全に否定するんじゃなくて、「〜だと思われがちだけど、実は〜」くらいの温度感で。
読んだ人が「確かに」「いや、そうかな？」って意見を言いたくなるように。
1行目はフック（常識を覆す一文）にして、その後に空行を入れろ。
文章が詰まらないように空行で区切って読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${getRandomLength()}${performanceHint}${recentContext}`),
    topicKey: topic.topicKey,
  };
}

function buildMomegotoPrompt(topic, performanceHint, recentContext = '') {
  return {
    userPrompt: adaptPromptForPersona(`家づくりでの揉め事・トラブルについて1つ投稿して。

ネタ: ${topic.text}

「相談で聞くトラブルで多いのは〜」「夫婦で揉める人めちゃ多い」みたいに。
ドロドロしすぎず、「あるよね〜」って思えるくらいの温度感で。
1行目はフックにして、その後に空行を入れろ。
文章が詰まらないように空行で区切って読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${getRandomLength()}${performanceHint}${recentContext}`),
    topicKey: topic.topicKey,
  };
}

function buildHikakuPrompt(topic, performanceHint, recentContext = '') {
  return {
    userPrompt: adaptPromptForPersona(`家づくりの「比較・どっちがいい？」系を1つ投稿して。読んだ人がコメントしたくなるやつ。

ネタ: ${topic.text}

「比較サイト運営してて一番聞かれるのは〜」「どっちがいいって聞かれるけど正直〜」みたいに。
「こっちが正解」って断言しすぎるな。「正直どっちもあり」くらいの温度感で。
読んだ人が「うちはこっちだった」「自分も迷った」ってコメントしたくなるように。
最後に「みんなはどうした？」「どっち派？」みたいな問いかけで締めろ。
1行目はフック（比較の核心 or 意外な結論）にして、その後に空行を入れろ。
文章が詰まらないように空行で区切って読みやすくしろ。
ハッシュタグはつけるな。

長さ: ${getRandomLength()}${performanceHint}${recentContext}`),
    topicKey: topic.topicKey,
  };
}

// ============================================================
// メイン
// ============================================================

async function main() {
  console.log(`🧵 Threads自動投稿 開始 [account=${ACCOUNT}]`);
  console.log(`📅 ${new Date().toISOString()}`);
  if (DRY_RUN) console.log('🏃 DRY RUN モード（投稿はスキップ）');
  if (IS_STEALTH) console.log(`🥷 ステルスモード: ${ACCOUNT}`);

  // ペルソナ読込
  PERSONA = loadPersona(ACCOUNT);
  if (PERSONA) console.log(`👤 ペルソナ: ${PERSONA.name} (${PERSONA.age}歳)`);

  // トークンチェック
  if (!DRY_RUN) {
    const tokenStatus = await checkAndRefreshToken(ACCOUNT);
    if (!tokenStatus.valid) {
      console.error(`❌ Threadsトークンが無効です [${ACCOUNT}]。手動で更新してください。`);
      process.exit(1);
    }
  }

  // エンゲージメント回収（自己学習用）
  if (!DRY_RUN) {
    try {
      await collectEngagement();
    } catch (e) {
      console.warn(`⚠️ エンゲージメント回収失敗（続行）: ${e.message}`);
    }
  }

  // データ読込
  const dataSources = loadAllData();
  console.log('📊 データソース読込完了');

  // トレンドスキャン（業者アカウントのみ）
  let trendResult = { trending: [] };
  if (!DRY_RUN && !IS_STEALTH) {
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
  const lengthMatch = userPrompt.match(/長さ: (.+)/);
  if (lengthMatch) console.log(`📏 長さ指示: ${lengthMatch[1]}`);

  // システムプロンプト選択
  const systemPrompt = PERSONA_SYSTEM_PROMPTS[ACCOUNT] || PERSONA_SYSTEM_PROMPTS.business;

  // AI生成
  console.log('🤖 投稿文生成中...');
  const postText = isArticle
    ? await generateArticlePost(userPrompt, { systemPrompt })
    : await generatePost(userPrompt, { systemPrompt, isStealth: IS_STEALTH });

  // ステルスアカウントで3回バリデーション失敗時はnullが返る
  if (postText === null) {
    console.log('⏭️ ステルスバリデーション失敗。この投稿をスキップします。');
    process.exit(0);
  }

  console.log(`✅ 生成テキスト (${postText.length}文字):`);
  console.log('---');
  console.log(postText);
  console.log('---');

  // 投稿
  let threadId = 'dry-run';
  if (!DRY_RUN) {
    console.log('📤 Threads投稿中...');
    const result = await publishPost(postText, ACCOUNT);
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
    account: ACCOUNT,
  }, ACCOUNT);
  console.log('💾 履歴保存完了');

  console.log(`\n✅ 完了: 1件投稿成功 [${ACCOUNT}]`);
}

main().catch(e => {
  console.error('💥 致命的エラー:', e);
  process.exit(1);
});
