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

async function callClaude(systemPrompt, userPrompt, { maxTokens = 1024, model = MODEL_POST } = {}) {
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

    const text = await callClaude(systemPrompt, prompt);
    const trimmed = text.trim();
    const errors = isStealth ? validateStealthPost(trimmed) : validatePost(trimmed);

    if (errors.length === 0) {
      return trimmed;
    }

    console.warn(`⚠️ バリデーション失敗 (${attempt}/${maxAttempts}):`, errors.join(', '));
    if (attempt === maxAttempts) {
      if (isStealth) {
        // ステルスアカウントで3回失敗したらスキップ（投稿しない）
        console.warn('⚠️ ステルスバリデーション3回失敗。この投稿はスキップします。');
        return null;
      }
      console.warn('⚠️ バリデーション再試行上限。カットして使用します。');
      return trimmed.slice(0, 497) + '...';
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

    const text = await callClaude(systemPrompt, prompt);
    const trimmed = text.trim();

    const errors = [];
    if (trimmed.length > 500) errors.push(`文字数超過 (${trimmed.length}/500)`);
    const hashtagCount = (trimmed.match(/#/g) || []).length;
    if (hashtagCount > 0) errors.push(`ハッシュタグ検出 (${hashtagCount}個 → タグなしにしろ)`);
    for (const word of CORPORATE_BLOCKLIST) {
      if (trimmed.includes(word)) { errors.push(`企業トーン検出: "${word}"`); break; }
    }
    for (const word of PR_BLOCKLIST) {
      if (trimmed.includes(word)) { errors.push(`PR臭検出: "${word}"`); break; }
    }
    for (const word of JARGON_BLOCKLIST) {
      if (trimmed.includes(word)) { errors.push(`専門用語検出: "${word}"`); break; }
    }

    if (errors.length === 0) return trimmed;

    console.warn(`⚠️ バリデーション失敗 (${attempt}/${maxAttempts}):`, errors.join(', '));
    if (attempt === maxAttempts) {
      return trimmed.slice(0, 497) + '...';
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
