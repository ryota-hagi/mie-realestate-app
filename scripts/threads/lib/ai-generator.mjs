/**
 * Claude API ラッパー
 * AI による投稿文・返信文の生成を担当
 * マルチアカウント対応: カスタムシステムプロンプト + ステルスバリデーション
 */

import { SYSTEM_PROMPT, SYSTEM_PROMPT_REPLY, SYSTEM_PROMPT_BUSINESS_REPLY, CORPORATE_BLOCKLIST, PR_BLOCKLIST, JARGON_BLOCKLIST, STEALTH_BLOCKLIST } from './config.mjs';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL_POST = 'claude-sonnet-4-6';       // 投稿生成: Sonnet（ストーリー性・感情表現が優れる）
const MODEL_REPLY = 'claude-haiku-4-5-20251001'; // 返信生成: Haiku（短文で十分・コスト効率）

// ============================================================
// リトライヘルパー
// ============================================================

async function withRetry(fn, maxRetries = 3, label = 'API呼出') {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      console.warn(`⚠️ ${label} 失敗 (${attempt}/${maxRetries}): ${e.message}`);
      if (attempt === maxRetries) throw e;
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ============================================================
// Claude API 呼出
// ============================================================

async function callClaude(systemPrompt, userPrompt, { maxTokens = 1024, model = MODEL_POST, temperature = 1.0 } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY が設定されていません');

  return withRetry(async () => {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const err = new Error(`Claude API ${res.status}: ${errData?.error?.message || res.statusText}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    return data.content?.[0]?.text || '';
  }, 3, 'Claude API呼出');
}

// ============================================================
// AI臭さ除去（自然化フィルター）
// ============================================================

/**
 * 投稿に絵文字を1-2個追加する（AI臭さ軽減）
 * @param {string} text - 投稿テキスト
 * @returns {string} 絵文字を追加したテキスト
 */
function addEmojis(text) {
  // 既に絵文字が含まれているかチェック（重複防止）
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]/u;
  if (emojiRegex.test(text)) {
    return text; // 既に絵文字があれば追加しない
  }

  const allowedEmojis = ['📍', '💰', '📊', '💡', '🏠'];
  const count = Math.random() < 0.5 ? 1 : 2; // 50%で1個、50%で2個

  // ランダムに絵文字を選択
  const selected = [];
  for (let i = 0; i < count; i++) {
    const emoji = allowedEmojis[Math.floor(Math.random() * allowedEmojis.length)];
    if (!selected.includes(emoji)) {
      selected.push(emoji);
    }
  }

  // テキストの先頭に追加（自然な位置）
  return `${selected.join('')} ${text}`;
}

/**
 * AI特有の表現を人間的な表現に置き換える
 * @param {string} text - AI生成テキスト
 * @returns {string} 自然化されたテキスト
 */
function naturalizeText(text) {
  let result = text;

  // AI特有の接続詞を削除 or 自然な表現に置き換え
  const aiConnectors = [
    { pattern: /それにさ、?/g, replace: '' },
    { pattern: /それでいて、?/g, replace: '' },
    { pattern: /さらに、?/g, replace: '' },
    { pattern: /加えて、?/g, replace: '' },
    { pattern: /その上、?/g, replace: '' },
    { pattern: /また、/g, replace: 'あと' },
  ];

  for (const { pattern, replace } of aiConnectors) {
    result = result.replace(pattern, replace);
  }

  // 硬い言い回しを簡潔な表現に
  const stiffPhrases = [
    { pattern: /が広がってて/g, replace: 'が多くて' },
    { pattern: /が広がっている/g, replace: 'がある' },
    { pattern: /充実してる/g, replace: '多い' },
    { pattern: /充実している/g, replace: 'ある' },
    { pattern: /本気で検討する価値あり/g, replace: '' },
    { pattern: /検討する価値あり/g, replace: '' },
    { pattern: /おすすめです/g, replace: '' },
    { pattern: /お勧めです/g, replace: '' },
  ];

  for (const { pattern, replace } of stiffPhrases) {
    result = result.replace(pattern, replace);
  }

  // 形式的な地域表現をカジュアルに
  const regionalPhrases = [
    { pattern: /東部は/g, replace: '東の方は' },
    { pattern: /西部は/g, replace: '西の方は' },
    { pattern: /南部は/g, replace: '南の方は' },
    { pattern: /北部は/g, replace: '北の方は' },
    { pattern: /中心部は/g, replace: '街の真ん中は' },
  ];

  for (const { pattern, replace } of regionalPhrases) {
    result = result.replace(pattern, replace);
  }

  // 連続する空白を整理
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.replace(/  +/g, ' ');

  // 文末の余計な改行削除
  result = result.trim();

  return result;
}

// ============================================================
// バリデーション
// ============================================================

function validatePost(text) {
  const errors = [];

  if (text.length > 500) {
    errors.push(`文字数超過 (${text.length}/500)`);
  }

  const hashtagCount = (text.match(/#/g) || []).length;
  if (hashtagCount > 0) {
    errors.push(`ハッシュタグ検出 (${hashtagCount}個 → タグなしにしろ。インプレが下がる)`);
  }

  for (const word of CORPORATE_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`企業トーン検出: "${word}"`);
      break;
    }
  }

  for (const word of PR_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`PR臭検出: "${word}"`);
      break;
    }
  }

  for (const word of JARGON_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`専門用語検出: "${word}" → わかりやすい言葉に置き換えて`);
      break;
    }
  }

  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  if (paragraphs.length > 5) {
    errors.push(`段落多すぎ (${paragraphs.length}段落 → 5以下に)`);
  }

  return errors;
}

/**
 * ステルスアカウント用追加バリデーション（業者感チェック）
 */
function validateStealthPost(text) {
  const errors = validatePost(text);

  for (const word of STEALTH_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`業者感検出: "${word}" → 個人の体験として語れ`);
      break;
    }
  }

  return errors;
}

function validateReply(text) {
  const errors = [];

  if (text.length > 150) {
    errors.push(`文字数超過 (${text.length}/150)`);
  }

  for (const word of CORPORATE_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`企業トーン検出: "${word}"`);
      break;
    }
  }

  for (const word of PR_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`PR臭検出: "${word}"`);
      break;
    }
  }

  for (const word of JARGON_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`専門用語検出: "${word}"`);
      break;
    }
  }

  if (/https?:\/\//.test(text)) {
    errors.push('返信にURLが含まれています');
  }

  return errors;
}

// ============================================================
// 投稿文生成
// ============================================================

/**
 * Threads投稿文を生成する
 * @param {string} userPrompt - カテゴリ別に構築したプロンプト
 * @param {object} options - { systemPrompt, isStealth }
 * @returns {string} 生成された投稿文
 */
export async function generatePost(userPrompt, options = {}) {
  const systemPrompt = options.systemPrompt || SYSTEM_PROMPT;
  const isStealth = options.isStealth || false;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let prompt = userPrompt;
    if (attempt === 2) {
      prompt += `\n\n【やり直し】前回ダメだった。もっと短く、1つだけ言って終わり。専門用語使うな。普通の人がわかる言葉だけ使え。愚痴っぽくていい。ハッシュタグはつけなくていい。空行で区切って読みやすくしろ。`;
    }
    if (attempt === 3) {
      prompt += `\n\n【最終やり直し】2〜3文で終わらせて。「〜なんだよね」で終わるくらい雑でいい。難しい言葉は全部やめろ。ハッシュタグなし。`;
    }

    const text = await callClaude(systemPrompt, prompt, { model: MODEL_POST, temperature: 1.0 });
    const trimmed = text.trim();

    // AI臭さを除去
    const naturalized = naturalizeText(trimmed);

    // 絵文字を追加（1-2個）
    const withEmoji = addEmojis(naturalized);

    const errors = isStealth ? validateStealthPost(withEmoji) : validatePost(withEmoji);

    if (errors.length === 0) {
      return withEmoji;
    }

    console.warn(`⚠️ バリデーション失敗 (${attempt}/${maxAttempts}):`, errors.join(', '));
    if (attempt === maxAttempts) {
      if (isStealth) {
        // ステルスアカウントで3回失敗したらスキップ（投稿しない）
        console.warn('⚠️ ステルスバリデーション3回失敗。この投稿はスキップします。');
        return null;
      }
      console.warn('⚠️ バリデーション再試行上限。カットして使用します。');
      return withEmoji.slice(0, 497) + '...';
    }
  }
}

/**
 * 記事紹介投稿文を生成する（URLを含む）
 * @param {string} userPrompt
 * @param {object} options - { systemPrompt }
 * @returns {string}
 */
export async function generateArticlePost(userPrompt, options = {}) {
  const systemPrompt = options.systemPrompt || SYSTEM_PROMPT;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let prompt = userPrompt;
    if (attempt === 2) {
      prompt += `\n\n【やり直し】PR臭い。もっと短く雑に。専門用語使うな。「これ読んだんだけど」くらいの軽さで。ハッシュタグなし。空行で区切れ。`;
    }
    if (attempt === 3) {
      prompt += `\n\n【最終やり直し】2〜3文だけ。難しい言葉全部やめろ。URL貼って終わり。ハッシュタグなし。`;
    }

    const text = await callClaude(systemPrompt, prompt, { model: MODEL_POST, temperature: 1.0 });
    const trimmed = text.trim();

    // AI臭さを除去
    const naturalized = naturalizeText(trimmed);

    // 絵文字を追加（1-2個）
    const withEmoji = addEmojis(naturalized);

    const errors = [];
    if (withEmoji.length > 500) errors.push(`文字数超過 (${withEmoji.length}/500)`);
    const hashtagCount = (withEmoji.match(/#/g) || []).length;
    if (hashtagCount > 0) errors.push(`ハッシュタグ検出 (${hashtagCount}個 → タグなしにしろ)`);
    for (const word of CORPORATE_BLOCKLIST) {
      if (withEmoji.includes(word)) { errors.push(`企業トーン検出: "${word}"`); break; }
    }
    for (const word of PR_BLOCKLIST) {
      if (withEmoji.includes(word)) { errors.push(`PR臭検出: "${word}"`); break; }
    }
    for (const word of JARGON_BLOCKLIST) {
      if (withEmoji.includes(word)) { errors.push(`専門用語検出: "${word}"`); break; }
    }

    if (errors.length === 0) return withEmoji;

    console.warn(`⚠️ バリデーション失敗 (${attempt}/${maxAttempts}):`, errors.join(', '));
    if (attempt === maxAttempts) {
      return withEmoji.slice(0, 497) + '...';
    }
  }
}

/**
 * 返信文を生成する（既存の replier.mjs 用）
 * @param {string} originalText - 返信先の投稿テキスト
 * @param {string} context - 追加コンテキスト（任意）
 * @returns {string}
 */
export async function generateReply(originalText, context = '') {
  const userPrompt = `以下のThreads投稿に返信して。1〜2文で短く。注文住宅の情報を集めてる立場で共感して。

投稿: 「${originalText}」
${context ? `\n背景: ${context}` : ''}`;

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await callClaude(SYSTEM_PROMPT_REPLY, userPrompt, { model: MODEL_REPLY });
    const trimmed = text.trim();
    const errors = validateReply(trimmed);

    if (errors.length === 0) return trimmed;

    console.warn(`⚠️ 返信バリデーション失敗 (${attempt}/${maxAttempts}):`, errors.join(', '));
    if (attempt === maxAttempts) {
      return trimmed.slice(0, 150);
    }
  }
}

/**
 * 業者アカウントからステマ投稿への返信文を生成する
 * @param {string} originalText - ステマ投稿のテキスト
 * @param {string} posterAccount - 投稿者アカウント ('a1','a2','a3')
 * @param {string} context - 追加コンテキスト（任意）
 * @returns {string}
 */
export async function generateBusinessReply(originalText, posterAccount = '', context = '') {
  const userPrompt = `以下のThreads投稿に、注文住宅比較.comの中の人として返信して。
50〜100文字で短く。共感ベースで。宣伝っぽくならないこと。URLは貼らない。

投稿: 「${originalText}」
投稿者: ${posterAccount}のアカウント（一般ユーザーとして振る舞っている）
${context ? `\n背景: ${context}` : ''}`;

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await callClaude(SYSTEM_PROMPT_BUSINESS_REPLY, userPrompt, { model: MODEL_REPLY });
    const trimmed = text.trim();
    const errors = validateReply(trimmed);

    if (errors.length === 0) return trimmed;

    console.warn(`⚠️ 業者返信バリデーション失敗 (${attempt}/${maxAttempts}):`, errors.join(', '));
    if (attempt === maxAttempts) {
      return trimmed.slice(0, 150);
    }
  }
}
