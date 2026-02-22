/**
 * Claude API ラッパー
 * AI による投稿文・返信文の生成を担当
 */

import { SYSTEM_PROMPT, SYSTEM_PROMPT_REPLY, CORPORATE_BLOCKLIST, PR_BLOCKLIST, JARGON_BLOCKLIST } from './config.mjs';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

// ============================================================
// リトライヘルパー
// ============================================================

async function withRetry(fn, maxRetries = 3, label = 'API call') {
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

async function callClaude(systemPrompt, userPrompt, maxTokens = 1024) {
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
        model: MODEL,
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
  }, 3, 'Claude API');
}

// ============================================================
// バリデーション
// ============================================================

function validatePost(text) {
  const errors = [];

  if (text.length > 500) {
    errors.push(`文字数超過 (${text.length}/500)`);
  }

  if (!text.includes('#')) {
    errors.push('ハッシュタグなし');
  }

  // ハッシュタグ3個以上は企業っぽい
  const hashtagCount = (text.match(/#/g) || []).length;
  if (hashtagCount > 2) {
    errors.push(`ハッシュタグ多すぎ (${hashtagCount}個 → 2個以下に)`);
  }

  for (const word of CORPORATE_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`企業トーン検出: "${word}"`);
      break;
    }
  }

  // PR臭チェック
  for (const word of PR_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`PR臭検出: "${word}"`);
      break;
    }
  }

  // 専門用語チェック
  for (const word of JARGON_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`専門用語検出: "${word}" → わかりやすい言葉に置き換えて`);
      break;
    }
  }

  // 改行が多すぎる（段落を作りすぎ）= 記事っぽい
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  if (paragraphs.length > 3) {
    errors.push(`段落多すぎ (${paragraphs.length}段落 → 3以下に)`);
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

  // 専門用語チェック
  for (const word of JARGON_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`専門用語検出: "${word}"`);
      break;
    }
  }

  // URLが含まれていたらNG（宣伝防止）
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
 * @returns {string} 生成された投稿文
 */
export async function generatePost(userPrompt) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let prompt = userPrompt;
    if (attempt === 2) {
      prompt += `\n\n【やり直し】前回ダメだった。もっと短く、1つだけ言って終わり。専門用語使うな。普通の人がわかる言葉だけ使え。愚痴っぽくていい。ハッシュタグは1〜2個だけ。`;
    }
    if (attempt === 3) {
      prompt += `\n\n【最終やり直し】2〜3文で終わらせて。「〜なんだよね」で終わるくらい雑でいい。難しい言葉は全部やめろ。ハッシュタグ1個。`;
    }

    const text = await callClaude(SYSTEM_PROMPT, prompt);
    const trimmed = text.trim();
    const errors = validatePost(trimmed);

    if (errors.length === 0) {
      return trimmed;
    }

    console.warn(`⚠️ バリデーション失敗 (${attempt}/${maxAttempts}):`, errors.join(', '));
    if (attempt === maxAttempts) {
      console.warn('⚠️ バリデーション再試行上限。カットして使用します。');
      return trimmed.slice(0, 497) + '...';
    }
  }
}

/**
 * 記事紹介投稿文を生成する（URLを含む）
 * @param {string} userPrompt
 * @returns {string}
 */
export async function generateArticlePost(userPrompt) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let prompt = userPrompt;
    if (attempt === 2) {
      prompt += `\n\n【やり直し】PR臭い。もっと短く雑に。専門用語使うな。「これ読んだんだけど」くらいの軽さで。ハッシュタグ1〜2個。`;
    }
    if (attempt === 3) {
      prompt += `\n\n【最終やり直し】2〜3文だけ。難しい言葉全部やめろ。URL貼って終わり。`;
    }

    const text = await callClaude(SYSTEM_PROMPT, prompt);
    const trimmed = text.trim();

    // 記事紹介はURL許可なので、URLチェックを除外したバリデーション
    const errors = [];
    if (trimmed.length > 500) errors.push(`文字数超過 (${trimmed.length}/500)`);
    if (!trimmed.includes('#')) errors.push('ハッシュタグなし');
    const hashtagCount = (trimmed.match(/#/g) || []).length;
    if (hashtagCount > 2) errors.push(`ハッシュタグ多すぎ (${hashtagCount}個)`);
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
 * 返信文を生成する
 * @param {string} originalText - 返信先の投稿テキスト
 * @param {string} context - 追加コンテキスト（任意）
 * @returns {string}
 */
export async function generateReply(originalText, context = '') {
  const userPrompt = `以下のThreads投稿に返信して。1〜2文で短く。自分の体験を1個だけ。

投稿: 「${originalText}」
${context ? `\n背景: ${context}` : ''}`;

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await callClaude(SYSTEM_PROMPT_REPLY, userPrompt);
    const trimmed = text.trim();
    const errors = validateReply(trimmed);

    if (errors.length === 0) return trimmed;

    console.warn(`⚠️ 返信バリデーション失敗 (${attempt}/${maxAttempts}):`, errors.join(', '));
    if (attempt === maxAttempts) {
      return trimmed.slice(0, 150);
    }
  }
}
