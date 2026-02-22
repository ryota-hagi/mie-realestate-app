/**
 * Threads API ラッパー
 * Meta Graph API (Threads) との通信を担当
 */

const BASE_URL = 'https://graph.threads.net/v1.0';

// ============================================================
// ヘルパー
// ============================================================

function getCredentials() {
  const accessToken = process.env.THREADS_ACCESS_TOKEN;
  const userId = process.env.THREADS_USER_ID;
  if (!accessToken) throw new Error('THREADS_ACCESS_TOKEN が設定されていません');
  if (!userId) throw new Error('THREADS_USER_ID が設定されていません');
  return { accessToken, userId };
}

async function apiCall(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) {
    const errMsg = data?.error?.message || JSON.stringify(data);
    const err = new Error(`Threads API ${res.status}: ${errMsg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ============================================================
// 投稿 (2ステップ: コンテナ作成 → 公開)
// ============================================================

/**
 * テキスト投稿を公開する
 * @param {string} text - 投稿テキスト (500文字以内)
 * @returns {{ id: string }} 公開された投稿のID
 */
export async function publishPost(text) {
  const { accessToken, userId } = getCredentials();

  // Step 1: メディアコンテナ作成
  const container = await apiCall(`${BASE_URL}/${userId}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'TEXT',
      text,
      access_token: accessToken,
    }),
  });

  // Step 2: 公開
  const result = await apiCall(`${BASE_URL}/${userId}/threads_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id: container.id,
      access_token: accessToken,
    }),
  });

  return result;
}

// ============================================================
// 返信投稿
// ============================================================

/**
 * 特定の投稿に返信する
 * @param {string} replyToId - 返信先の投稿ID
 * @param {string} text - 返信テキスト (500文字以内)
 * @returns {{ id: string }}
 */
export async function publishReply(replyToId, text) {
  const { accessToken, userId } = getCredentials();

  const container = await apiCall(`${BASE_URL}/${userId}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'TEXT',
      text,
      reply_to_id: replyToId,
      access_token: accessToken,
    }),
  });

  const result = await apiCall(`${BASE_URL}/${userId}/threads_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id: container.id,
      access_token: accessToken,
    }),
  });

  return result;
}

// ============================================================
// 読み取り
// ============================================================

/**
 * 自分の最近の投稿一覧を取得
 * @param {number} limit - 取得件数 (デフォルト 25)
 * @returns {Array} 投稿一覧
 */
export async function getMyThreads(limit = 25) {
  const { accessToken } = getCredentials();
  const fields = 'id,text,timestamp,permalink';
  const url = `${BASE_URL}/me/threads?fields=${fields}&limit=${limit}&access_token=${accessToken}`;
  const data = await apiCall(url);
  return data.data || [];
}

/**
 * 特定の投稿への返信一覧を取得
 * @param {string} threadId - 投稿ID
 * @returns {Array} 返信一覧
 */
export async function getReplies(threadId) {
  const { accessToken } = getCredentials();
  const fields = 'id,text,username,timestamp';
  const url = `${BASE_URL}/${threadId}/replies?fields=${fields}&access_token=${accessToken}`;
  const data = await apiCall(url);
  return data.data || [];
}

/**
 * 投稿のインサイト（エンゲージメント指標）を取得
 * @param {string} mediaId - 投稿ID
 * @returns {{ views: number, likes: number, replies: number, reposts: number, quotes: number }}
 */
export async function getInsights(mediaId) {
  const { accessToken } = getCredentials();
  const metrics = 'views,likes,replies,reposts,quotes';
  const url = `${BASE_URL}/${mediaId}/insights?metric=${metrics}&access_token=${accessToken}`;
  try {
    const data = await apiCall(url);
    const result = {};
    for (const item of (data.data || [])) {
      result[item.name] = item.values?.[0]?.value ?? 0;
    }
    return result;
  } catch (e) {
    // インサイト取得失敗は致命的ではない
    console.warn(`⚠️ インサイト取得失敗 (${mediaId}): ${e.message}`);
    return { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0 };
  }
}

// ============================================================
// 検索
// ============================================================

/**
 * キーワード検索
 * @param {string} query - 検索キーワード
 * @param {object} options - { since, until, limit }
 * @returns {Array} 検索結果の投稿一覧
 */
export async function keywordSearch(query, options = {}) {
  const { accessToken } = getCredentials();
  const fields = 'id,text,username,timestamp,permalink';
  let url = `${BASE_URL}/keyword_search?q=${encodeURIComponent(query)}&fields=${fields}&access_token=${accessToken}`;

  if (options.since) url += `&since=${options.since}`;
  if (options.until) url += `&until=${options.until}`;
  if (options.limit) url += `&limit=${options.limit}`;

  const data = await apiCall(url);
  return data.data || [];
}

// ============================================================
// トークン管理
// ============================================================

/**
 * トークンの有効性を確認し、必要に応じてリフレッシュ
 * @returns {{ valid: boolean, refreshed: boolean, newToken?: string }}
 */
export async function checkAndRefreshToken() {
  const { accessToken } = getCredentials();

  // まず現在のトークンが有効か確認
  try {
    await apiCall(`${BASE_URL}/me?fields=id&access_token=${accessToken}`);
    return { valid: true, refreshed: false };
  } catch (e) {
    if (e.status !== 401) throw e;
  }

  // 無効な場合リフレッシュを試行
  console.log('🔄 トークンリフレッシュを試行中...');
  try {
    const data = await apiCall(
      `${BASE_URL}/refresh_access_token?grant_type=th_refresh_token&access_token=${accessToken}`
    );
    console.log('✅ トークンリフレッシュ成功');
    console.warn('⚠️ 新しいトークンをGitHub Secretsに登録してください:');
    console.warn(`   THREADS_ACCESS_TOKEN = ${data.access_token.substring(0, 20)}...`);
    return { valid: true, refreshed: true, newToken: data.access_token };
  } catch (refreshErr) {
    console.error('❌ トークンリフレッシュ失敗:', refreshErr.message);
    return { valid: false, refreshed: false };
  }
}

// ============================================================
// レート制限確認
// ============================================================

/**
 * 現在の投稿クォータ使用量を取得
 * @returns {{ quota_usage: number, reply_quota_usage: number }}
 */
export async function getPublishingLimit() {
  const { accessToken } = getCredentials();
  const fields = 'quota_usage,reply_quota_usage,config,reply_config';
  const url = `${BASE_URL}/me/threads_publishing_limit?fields=${fields}&access_token=${accessToken}`;
  try {
    const data = await apiCall(url);
    return data.data?.[0] || {};
  } catch (e) {
    console.warn(`⚠️ クォータ取得失敗: ${e.message}`);
    return {};
  }
}
