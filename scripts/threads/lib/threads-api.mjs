/**
 * Threads API ラッパー
 * Meta Graph API (Threads) との通信を担当
 */

const BASE_URL = 'https://graph.threads.net/v1.0';

// ============================================================
// ヘルパー
// ============================================================

function getCredentials(account = null) {
  let accessToken, userId;

  if (account && account !== 'business') {
    const suffix = `_${account.toUpperCase()}`; // _A1, _A2, _A3
    accessToken = process.env[`THREADS_ACCESS_TOKEN${suffix}`];
    userId = process.env[`THREADS_USER_ID${suffix}`];
    if (!accessToken) throw new Error(`THREADS_ACCESS_TOKEN${suffix} が設定されていません`);
    if (!userId) throw new Error(`THREADS_USER_ID${suffix} が設定されていません`);
  } else {
    accessToken = process.env.THREADS_ACCESS_TOKEN;
    userId = process.env.THREADS_USER_ID;
    if (!accessToken) throw new Error('THREADS_ACCESS_TOKEN が設定されていません');
    if (!userId) throw new Error('THREADS_USER_ID が設定されていません');
  }

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
// コンテナステータス確認（作成後、公開前に必要）
// ============================================================

/**
 * メディアコンテナのステータスを確認する
 * Threads APIではコンテナ作成後、FINISHED状態になるまで待つ必要がある
 * @param {string} containerId - コンテナID
 * @param {number} maxRetries - 最大リトライ回数 (デフォルト 10)
 * @param {number} intervalMs - チェック間隔ミリ秒 (デフォルト 2000)
 * @returns {string} ステータス ('FINISHED', 'ERROR', etc.)
 */
async function waitForContainerReady(containerId, account = null, maxRetries = 10, intervalMs = 2000) {
  const { accessToken } = getCredentials(account);

  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, intervalMs));

    try {
      const data = await apiCall(
        `${BASE_URL}/${containerId}?fields=status,error_message&access_token=${accessToken}`
      );

      console.log(`   📦 コンテナステータス (${i + 1}/${maxRetries}): ${data.status || '不明'}`);

      if (data.status === 'FINISHED') {
        return 'FINISHED';
      }

      if (data.status === 'ERROR') {
        throw new Error(`コンテナエラー: ${data.error_message || '不明なエラー'}`);
      }

      // IN_PROGRESS の場合は続行
    } catch (e) {
      // ステータス確認自体が失敗した場合（404等）
      // コンテナがまだ準備中の可能性があるので続行
      if (e.status === 404 || e.message?.includes('does not exist')) {
        console.log(`   ⏳ コンテナ準備中... (${i + 1}/${maxRetries})`);
        continue;
      }
      throw e;
    }
  }

  throw new Error(`コンテナが${maxRetries * intervalMs / 1000}秒以内にFINISHEDになりませんでした`);
}

// ============================================================
// 投稿 (2ステップ: コンテナ作成 → ステータス確認 → 公開)
// ============================================================

/**
 * テキスト投稿を公開する
 * @param {string} text - 投稿テキスト (500文字以内)
 * @returns {{ id: string }} 公開された投稿のID
 */
export async function publishPost(text, account = null) {
  const { accessToken, userId } = getCredentials(account);

  // Step 1: メディアコンテナ作成
  console.log('   📦 メディアコンテナ作成中...');
  const container = await apiCall(`${BASE_URL}/${userId}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'TEXT',
      text,
      access_token: accessToken,
    }),
  });
  console.log(`   📦 コンテナID: ${container.id}`);

  // Step 2: コンテナがFINISHEDになるまで待機
  console.log('   ⏳ コンテナ処理待機中...');
  await waitForContainerReady(container.id, account);

  // Step 3: 公開
  console.log('   🚀 公開中...');
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
 * @param {string|null} account - アカウント ('a1','a2','a3','business',null)
 * @returns {{ id: string }}
 */
export async function publishReply(replyToId, text, account = null) {
  const { accessToken, userId } = getCredentials(account);

  // Step 1: 返信コンテナ作成
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

  // Step 2: コンテナがFINISHEDになるまで待機
  await waitForContainerReady(container.id, account);

  // Step 3: 公開
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

/** publishReply のエイリアス（仕様書命名に合わせる） */
export const replyToPost = publishReply;

// ============================================================
// 読み取り
// ============================================================

/**
 * 自分の最近の投稿一覧を取得
 * @param {number} limit - 取得件数 (デフォルト 25)
 * @returns {Array} 投稿一覧
 */
export async function getMyThreads(limit = 25, account = null) {
  const { accessToken } = getCredentials(account);
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
export async function getReplies(threadId, account = null) {
  const { accessToken } = getCredentials(account);
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
export async function getInsights(mediaId, account = null) {
  const { accessToken } = getCredentials(account);
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
export async function keywordSearch(query, options = {}, account = null) {
  const { accessToken } = getCredentials(account);
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
export async function checkAndRefreshToken(account = null) {
  const { accessToken } = getCredentials(account);

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
export async function getPublishingLimit(account = null) {
  const { accessToken } = getCredentials(account);
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
