/**
 * データソース読込
 * live-data.json, city-data.json, knowledge-data.json を読み込んで
 * 投稿ネタとして使えるデータを提供
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ARUARU_TOPICS, MOMEGOTO_TOPICS, KOUKAI_TOPICS } from './config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

// ============================================================
// データ読込
// ============================================================

export function loadAllData() {
  const cityData = JSON.parse(readFileSync(join(ROOT, 'scripts', 'city-data.json'), 'utf-8'));
  const knowledgeData = JSON.parse(readFileSync(join(ROOT, 'scripts', 'knowledge-data.json'), 'utf-8'));
  const liveData = JSON.parse(readFileSync(join(ROOT, 'data', 'live-data.json'), 'utf-8'));
  return { cityData, knowledgeData, liveData };
}

// ============================================================
// ランダム選択ヘルパー
// ============================================================

export function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================================
// 体験談ネタ抽出
// ============================================================

/**
 * 実際の市区町村エントリのみフィルタ（checklist/tooltips等を除外）
 */
function getCityIds(cityData) {
  return Object.keys(cityData).filter(id => cityData[id].tips && cityData[id].nameJa);
}

/**
 * city-data から体験談ネタを取得
 * @returns {{ city: string, tip: object, topicKey: string }}
 */
export function getTaikenTopic(cityData) {
  const cityIds = getCityIds(cityData);
  const cityId = randomChoice(cityIds);
  const city = cityData[cityId];
  const tipIndex = Math.floor(Math.random() * city.tips.length);
  const tip = city.tips[tipIndex];
  return {
    city: city.nameJa,
    cityId,
    tip,
    topicKey: `taiken:${cityId}:tip:${tipIndex}`,
  };
}

// ============================================================
// 豆知識ネタ抽出
// ============================================================

/**
 * knowledge-data のセクションから豆知識ネタを取得
 * @returns {{ article: object, section: object, topicKey: string }}
 */
export function getMameTopic(knowledgeData) {
  const articles = knowledgeData.articles;
  const article = randomChoice(articles);
  const sectionIndex = Math.floor(Math.random() * article.sections.length);
  const section = article.sections[sectionIndex];
  return {
    article: { id: article.id, title: article.title },
    section,
    topicKey: `mame:${article.id}:section:${sectionIndex}`,
  };
}

// ============================================================
// データ紹介ネタ抽出
// ============================================================

/**
 * live-data.json から統計的なインサイトを抽出
 * @returns {{ city: string, insight: object, topicKey: string }}
 */
export function getDataTopic(liveData) {
  const areaIds = Object.keys(liveData.areas);
  const areaId = randomChoice(areaIds);
  const area = liveData.areas[areaId];

  // 最新四半期のデータだけを使う
  const recentPeriods = ['2024年第4四半期', '2024年第3四半期'];
  const recent = area.transactions.filter(t => recentPeriods.some(p => t.Period?.includes(p)));

  if (recent.length === 0) {
    return getDataTopic(liveData); // 再帰で別エリアを試す
  }

  // ランダムにインサイトタイプを選択
  const insightTypes = ['avg_price', 'price_range', 'popular_district'];
  const insightType = randomChoice(insightTypes);

  let insight;
  const tsuboRate = 3.30579;

  if (insightType === 'avg_price') {
    const landOnly = recent.filter(t => t.Type === '宅地(土地)' && t.Area > 0);
    if (landOnly.length > 0) {
      const avgPricePerTsubo = landOnly.reduce((sum, t) =>
        sum + (t.TradePrice / (t.Area / tsuboRate)), 0) / landOnly.length;
      insight = {
        type: 'avg_price',
        text: `${area.name}の直近の宅地取引${landOnly.length}件から算出した平均坪単価: 約${(avgPricePerTsubo / 10000).toFixed(1)}万円`,
      };
    }
  }

  if (insightType === 'price_range' || !insight) {
    const withPrice = recent.filter(t => t.TradePrice > 0);
    if (withPrice.length > 0) {
      const min = Math.min(...withPrice.map(t => t.TradePrice));
      const max = Math.max(...withPrice.map(t => t.TradePrice));
      insight = {
        type: 'price_range',
        text: `${area.name}の直近取引${withPrice.length}件の価格帯: ${(min / 10000).toFixed(0)}万円〜${(max / 10000).toFixed(0)}万円`,
      };
    }
  }

  if (insightType === 'popular_district' || !insight) {
    const districts = {};
    for (const t of recent) {
      if (t.District) districts[t.District] = (districts[t.District] || 0) + 1;
    }
    const sorted = Object.entries(districts).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      insight = {
        type: 'popular_district',
        text: `${area.name}で直近取引が多い地区: ${sorted.slice(0, 3).map(([d, c]) => `${d}(${c}件)`).join('、')}`,
      };
    }
  }

  if (!insight) {
    insight = { type: 'count', text: `${area.name}の直近取引件数: ${recent.length}件` };
  }

  return {
    city: area.name,
    cityId: areaId,
    insight,
    topicKey: `data:${areaId}:${insight.type}`,
  };
}

// ============================================================
// 記事紹介ネタ抽出
// ============================================================

/**
 * knowledge-data から記事紹介ネタを取得
 * @returns {{ article: object, url: string, topicKey: string }}
 */
export function getKijiTopic(knowledgeData) {
  const article = randomChoice(knowledgeData.articles);
  return {
    article,
    url: `https://research.chuumon-soudan.com/knowledge/${article.id}/`,
    topicKey: `kiji:${article.id}`,
  };
}

// ============================================================
// エリア紹介ネタ抽出
// ============================================================

/**
 * city-data からエリア紹介ネタを取得
 * @returns {{ city: object, cityId: string, topicKey: string }}
 */
export function getAreaTopic(cityData) {
  const cityIds = getCityIds(cityData);
  const cityId = randomChoice(cityIds);
  const city = cityData[cityId];
  return {
    city,
    cityId,
    topicKey: `area:${cityId}`,
  };
}

// ============================================================
// 失敗談ネタ抽出
// ============================================================

/**
 * city-data の common_mistakes から失敗談ネタを取得
 * @returns {{ city: string, cityId: string, mistakes: string, topicKey: string }}
 */
export function getShippaiTopic(cityData) {
  const cityIds = getCityIds(cityData);
  const cityId = randomChoice(cityIds);
  const city = cityData[cityId];
  return {
    city: city.nameJa,
    cityId,
    mistakes: city.seo_sections?.common_mistakes || '',
    topicKey: `shippai:${cityId}`,
  };
}

// ============================================================
// 住宅ローンネタ抽出
// ============================================================

/**
 * knowledge-data の費用系記事からローンネタを取得
 * @returns {{ article: object, section: object, topicKey: string }}
 */
export function getLoanTopic(knowledgeData) {
  // 費用・お金カテゴリの記事を優先
  const moneyArticles = knowledgeData.articles.filter(a => a.category === 'money');
  const article = moneyArticles.length > 0 ? randomChoice(moneyArticles) : randomChoice(knowledgeData.articles);
  const sectionIndex = Math.floor(Math.random() * article.sections.length);
  return {
    article: { id: article.id, title: article.title },
    section: article.sections[sectionIndex],
    topicKey: `loan:${article.id}:section:${sectionIndex}`,
  };
}

// ============================================================
// あるあるネタ抽出
// ============================================================

/**
 * あるあるネタをランダムに取得
 * @returns {{ text: string, topicKey: string }}
 */
export function getAruaruTopic() {
  const index = Math.floor(Math.random() * ARUARU_TOPICS.length);
  return {
    text: ARUARU_TOPICS[index],
    topicKey: `aruaru:${index}`,
  };
}

// ============================================================
// よくある揉め事ネタ抽出
// ============================================================

/**
 * よくある揉め事ネタをランダムに取得
 * @returns {{ text: string, topicKey: string }}
 */
export function getMomegotoTopic() {
  const index = Math.floor(Math.random() * MOMEGOTO_TOPICS.length);
  return {
    text: MOMEGOTO_TOPICS[index],
    topicKey: `momegoto:${index}`,
  };
}

// ============================================================
// 後悔パターン抽出
// ============================================================

/**
 * 後悔パターンをランダムに取得
 * @returns {{ text: string, topicKey: string }}
 */
export function getKoukaiTopic() {
  const index = Math.floor(Math.random() * KOUKAI_TOPICS.length);
  return {
    text: KOUKAI_TOPICS[index],
    topicKey: `koukai:${index}`,
  };
}
