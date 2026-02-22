/**
 * Claude API ラッパー
 * AI による投稿文・返信文の生成を担当
 */

import { SYSTEM_PROMPT, SYSTEM_PROMPT_REPLY, CORPORATE_BLOCKLIST } from './config.mjs';

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

  for (const word of CORPORATE_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`企業トーン検出: "${word}"`);
      break;
    }
  }

  return errors;
}

function validateReply(text) {
  const errors = [];

  if (text.length > 200) {
    errors.push(`文字数超過 (${text.length}/200)`);
  }

  for (const word of CORPORATE_BLOCKLIST) {
    if (text.includes(word)) {
      errors.push(`企業トーン検出: "${word}"`);
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
    if (attempt > 1) {
      prompt += `\n\n【再生成指示】前回の生成結果にバリデーションエラーがありました。500文字以内に収め、ハッシュタグを2-3個つけ、企業っぽい表現を避けてください。`;
    }

    const text = await callClaude(SYSTEM_PROMPT, prompt);
    const trimmed = text.trim();
    const errors = validatePost(trimmed);

    if (errors.length === 0) {
      return trimmed;
    }

    console.warn(`⚠️ バリデーション失敗 (${attempt}/${maxAttempts}):`, errors.join(', '));
    if (attempt === maxAttempts) {
      // 最終手段: 500文字でカットしてそのまま返す
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
    if (attempt > 1) {
      prompt += `\n\n【再生成指示】500文字以内に収めてください。企業っぽい表現を避けてください。`;
    }

    const text = await callClaude(SYSTEM_PROMPT, prompt);
    const trimmed = text.trim();

    // 記事紹介はURL許可なので、URLチェックを除外したバリデーション
    const errors = [];
    if (trimmed.length > 500) errors.push(`文字数超過 (${trimmed.length}/500)`);
    if (!trimmed.includes('#')) errors.push('ハッシュタグなし');
    for (const word of CORPORATE_BLOCKLIST) {
      if (trimmed.includes(word)) { errors.push(`企業トーン検出: "${word}"`); break; }
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
  const userPrompt = `以下のThreads投稿に対して、自然なコメントを書いてください。

投稿内容: 「${originalText}」
${context ? `\n追加情報: ${context}` : ''}

【ルール】
- 共感、体験の共有、役立つ情報提供のいずれかの切り口で
- 宣伝・URL貼りは絶対NG
- 「いいですね！」だけの薄いコメントもNG
- 自分の具体的な体験やエピソードを交える
- 200文字以内で簡潔に`;

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await callClaude(SYSTEM_PROMPT_REPLY, userPrompt);
    const trimmed = text.trim();
    const errors = validateReply(trimmed);

    if (errors.length === 0) return trimmed;

    console.warn(`⚠️ 返信バリデーション失敗 (${attempt}/${maxAttempts}):`, errors.join(', '));
    if (attempt === maxAttempts) {
      return trimmed.slice(0, 200);
    }
  }
}
