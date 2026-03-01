#!/usr/bin/env node
/**
 * Threads API トークン診断スクリプト
 * 業者アカウントのトークンが持つ権限を体系的にテストする
 *
 * 使い方:
 *   node scripts/threads/diagnose-token.mjs
 *
 * 必要な環境変数:
 *   THREADS_ACCESS_TOKEN  — 業者アカウントのトークン
 *   THREADS_USER_ID       — 業者アカウントのユーザーID
 */

const BASE_URL = 'https://graph.threads.net/v1.0';

const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const USER_ID = process.env.THREADS_USER_ID;

if (!TOKEN || !USER_ID) {
  console.error('❌ THREADS_ACCESS_TOKEN と THREADS_USER_ID を設定してください');
  process.exit(1);
}

async function apiCall(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

// ── テスト1: GET /me（基本認証）──
async function testGetMe() {
  console.log('\n━━━ テスト1: GET /me（基本読み取り）━━━');
  const { status, ok, data } = await apiCall(
    `${BASE_URL}/me?fields=id,username,threads_profile_picture_url&access_token=${TOKEN}`
  );
  if (ok) {
    console.log(`  ✅ 成功: username=${data.username}, id=${data.id}`);
    return data;
  } else {
    console.log(`  ❌ 失敗 (${status}): ${JSON.stringify(data)}`);
    return null;
  }
}

// ── テスト2: GET /me/threads（自分の投稿一覧）──
async function testGetMyThreads() {
  console.log('\n━━━ テスト2: GET /me/threads（投稿一覧読み取り）━━━');
  const { status, ok, data } = await apiCall(
    `${BASE_URL}/me/threads?fields=id,text,timestamp&limit=3&access_token=${TOKEN}`
  );
  if (ok) {
    const posts = data.data || [];
    console.log(`  ✅ 成功: ${posts.length}件取得`);
    posts.forEach(p => console.log(`     - ${p.id}: ${(p.text || '').slice(0, 50)}...`));
    return posts;
  } else {
    console.log(`  ❌ 失敗 (${status}): ${JSON.stringify(data)}`);
    return [];
  }
}

// ── テスト3: POST コンテナ作成（通常投稿、reply_to_idなし）──
async function testCreateContainer() {
  console.log('\n━━━ テスト3: POST コンテナ作成（通常投稿）━━━');
  const { status, ok, data } = await apiCall(`${BASE_URL}/${USER_ID}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'TEXT',
      text: '診断テスト（公開しません）',
      access_token: TOKEN,
    }),
  });
  if (ok) {
    console.log(`  ✅ 成功: container_id=${data.id}`);
    console.log(`  ℹ️ threads_content_publish 権限あり`);
    return data.id;
  } else {
    console.log(`  ❌ 失敗 (${status}): ${JSON.stringify(data)}`);
    console.log(`  ℹ️ threads_content_publish 権限なし、またはトークン無効`);
    return null;
  }
}

// ── テスト4: POST コンテナ作成（返信、reply_to_id付き）──
async function testCreateReplyContainer(replyToId) {
  console.log(`\n━━━ テスト4: POST 返信コンテナ作成（reply_to_id=${replyToId}）━━━`);
  const { status, ok, data } = await apiCall(`${BASE_URL}/${USER_ID}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'TEXT',
      text: '返信診断テスト（公開しません）',
      reply_to_id: replyToId,
      access_token: TOKEN,
    }),
  });
  if (ok) {
    console.log(`  ✅ 成功: container_id=${data.id}`);
    console.log(`  ℹ️ threads_manage_replies 権限あり`);
    return data.id;
  } else {
    console.log(`  ❌ 失敗 (${status}): ${JSON.stringify(data)}`);
    const errCode = data?.error?.code;
    const errSubcode = data?.error?.error_subcode;
    const errMsg = data?.error?.message || '';
    console.log(`  ℹ️ error_code=${errCode}, error_subcode=${errSubcode}`);

    if (errMsg.includes('does not have permission')) {
      console.log(`  💡 原因: アプリに threads_manage_replies 権限がないか、トークンのスコープに含まれていない`);
    } else if (errCode === 190) {
      console.log(`  💡 原因: トークンが無効（書き込みスコープが含まれていない可能性）`);
    } else if (errMsg.includes('reply_to_id')) {
      console.log(`  💡 原因: reply_to_id が無効（投稿が存在しない or 返信不可）`);
    }
    return null;
  }
}

// ── テスト5: トークンデバッグ情報 ──
async function testTokenDebug() {
  console.log('\n━━━ テスト5: トークンデバッグ（Graph API debug_token）━━━');
  // debug_token は通常 app access token が必要だが、user token でも基本情報は取れる場合がある
  const { status, ok, data } = await apiCall(
    `https://graph.facebook.com/v19.0/debug_token?input_token=${TOKEN}&access_token=${TOKEN}`
  );
  if (ok && data.data) {
    const d = data.data;
    console.log(`  ℹ️ app_id: ${d.app_id || '不明'}`);
    console.log(`  ℹ️ type: ${d.type || '不明'}`);
    console.log(`  ℹ️ is_valid: ${d.is_valid}`);
    console.log(`  ℹ️ expires_at: ${d.expires_at ? new Date(d.expires_at * 1000).toISOString() : '不明'}`);
    console.log(`  ℹ️ scopes: ${(d.scopes || []).join(', ') || '取得不可'}`);
    if (d.granular_scopes) {
      console.log(`  ℹ️ granular_scopes:`);
      d.granular_scopes.forEach(s => console.log(`     - ${s.scope}`));
    }
    return d;
  } else {
    console.log(`  ⚠️ debug_token 取得失敗 (${status}): ${JSON.stringify(data)}`);
    console.log(`  ℹ️ これは正常な場合もあります（Threads API はこのエンドポイントを直接サポートしない場合がある）`);
    return null;
  }
}

// ── テスト6: Publishing Limit（API使用状況）──
async function testPublishingLimit() {
  console.log('\n━━━ テスト6: Publishing Limit（クォータ確認）━━━');
  const { status, ok, data } = await apiCall(
    `${BASE_URL}/me/threads_publishing_limit?fields=quota_usage,reply_quota_usage,config,reply_config&access_token=${TOKEN}`
  );
  if (ok) {
    const limit = data.data?.[0] || {};
    console.log(`  ✅ 成功:`);
    console.log(`     - quota_usage: ${limit.quota_usage ?? '不明'}`);
    console.log(`     - reply_quota_usage: ${limit.reply_quota_usage ?? '不明'}`);
    console.log(`     - config: ${JSON.stringify(limit.config || {})}`);
    console.log(`     - reply_config: ${JSON.stringify(limit.reply_config || {})}`);
    if (limit.reply_quota_usage !== undefined) {
      console.log(`  ℹ️ reply_quota_usage が取得できた → threads_manage_replies スコープがトークンに含まれている可能性あり`);
    } else {
      console.log(`  ⚠️ reply_quota_usage が取得できない → threads_manage_replies スコープが不足の可能性`);
    }
    return limit;
  } else {
    console.log(`  ❌ 失敗 (${status}): ${JSON.stringify(data)}`);
    return null;
  }
}

// ── メイン ──
async function main() {
  console.log('🔍 Threads API トークン診断');
  console.log(`📅 ${new Date().toISOString()}`);
  console.log(`🔑 トークン先頭20文字: ${TOKEN.substring(0, 20)}...`);
  console.log(`👤 USER_ID: ${USER_ID}`);

  // テスト1: 基本認証
  const me = await testGetMe();
  if (!me) {
    console.log('\n💥 基本認証に失敗。トークンが無効です。ここで終了します。');
    process.exit(1);
  }

  // テスト2: 投稿一覧
  const myPosts = await testGetMyThreads();

  // テスト3: 通常投稿コンテナ作成（公開はしない）
  const containerId = await testCreateContainer();

  // テスト4: 返信コンテナ作成テスト
  // まず、ステマアカウントの直近投稿IDを取得して使う
  // なければ自分の投稿に返信テスト
  let replyTargetId = null;

  // ステマアカウントの投稿を探す
  for (const suffix of ['A1', 'A2', 'A3']) {
    const stealthToken = process.env[`THREADS_ACCESS_TOKEN_${suffix}`];
    if (!stealthToken) continue;
    const { ok, data } = await apiCall(
      `${BASE_URL}/me/threads?fields=id,text,timestamp&limit=1&access_token=${stealthToken}`
    );
    if (ok && data.data?.length > 0) {
      replyTargetId = data.data[0].id;
      console.log(`\n  ℹ️ ステマ${suffix}の最新投稿をテスト対象に使用: ${replyTargetId}`);
      break;
    }
  }

  // ステマ投稿がなければ自分の投稿を使う
  if (!replyTargetId && myPosts.length > 0) {
    replyTargetId = myPosts[0].id;
    console.log(`\n  ℹ️ 自分の最新投稿をテスト対象に使用: ${replyTargetId}`);
  }

  if (replyTargetId) {
    await testCreateReplyContainer(replyTargetId);
  } else {
    console.log('\n  ⚠️ テスト対象の投稿が見つからないため、返信テストをスキップ');
  }

  // テスト5: トークンデバッグ
  await testTokenDebug();

  // テスト6: Publishing Limit
  await testPublishingLimit();

  // ── まとめ ──
  console.log('\n' + '═'.repeat(60));
  console.log('📋 診断まとめ');
  console.log('═'.repeat(60));
  console.log(`
次のステップ:
  1. テスト3が失敗 → トークンに threads_content_publish スコープが不足
  2. テスト3が成功 & テスト4が失敗 → threads_manage_replies スコープが不足
  3. テスト4が成功 → トークンは正常。reply_to_id の対象投稿側に問題がある可能性

対処法（スコープ不足の場合）:
  Meta Developer Console → Threads App → Use Cases → Customize
  → 必要な権限にチェック → 「Generate Token」で新トークンを生成
  ⚠️ 重要: 権限追加後、必ず「Generate Token」で再生成が必要。
     既存トークンには新しいスコープが自動反映されない。
`);
}

main().catch(e => {
  console.error('💥 診断中にエラー:', e);
  process.exit(1);
});
