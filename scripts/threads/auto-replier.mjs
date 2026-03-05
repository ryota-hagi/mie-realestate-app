#!/usr/bin/env node
/**
 * Threads 自動リプライスクリプト
 * ステマアカウント(A1/A2/A3)のバズ投稿に、業者アカウントから返信して導線を作る
 *
 * バズ判定基準:
 * - SUPER_BUZZ: views 5,000+ / likes 20+ → 100%返信
 * - BUZZ:       views 2,000+ / likes 10+ → 80%返信
 * - RISING:     views 1,000+ / likes 5+  → 50%返信
 * - NORMAL:     ~999 views / ~4 likes     → 20%返信
 *
 * 制約: 1日最大10件、返信間隔1分以上
 * GitHub Actions で1日3回 (13:00, 19:00, 01:00 JST) 実行
 */

import { getInsights, publishReply, getMyThreads } from './lib/threads-api.mjs';
import { generateBusinessReply } from './lib/ai-generator.mjs';
import { loadHistory, loadReplyHistory, saveReplyHistory, hasRepliedToPost, getTodayReplyCount } from './lib/history.mjs';

const DRY_RUN = process.env.DRY_RUN === 'true';
const STEALTH_ACCOUNTS = ['a1', 'a2', 'a3'];
const BUSINESS_ACCOUNT = 'business';
const MAX_DAILY_REPLIES = 10;
const MIN_REPLY_INTERVAL_MS = 60 * 1000; // 1分
const POST_LOOKBACK_HOURS = 48;

// ============================================================
// バズレベル判定
// ============================================================

function getBuzzLevel(insights) {
  const views = insights?.views || 0;
  const likes = insights?.likes || 0;

  if (views >= 5000 || likes >= 20) return { level: 'SUPER_BUZZ', probability: 1.0 };
  if (views >= 2000 || likes >= 10) return { level: 'BUZZ', probability: 0.8 };
  if (views >= 1000 || likes >= 5)  return { level: 'RISING', probability: 0.5 };
  return { level: 'NORMAL', probability: 0.2 };
}

function shouldReply(buzzLevel) {
  return Math.random() < buzzLevel.probability;
}

// ============================================================
// ランダム遅延（30〜120秒。DRY_RUNではスキップ）
// ============================================================

async function randomDelay() {
  if (DRY_RUN) return;
  const delaySec = Math.floor(Math.random() * 91) + 30; // 30〜120秒
  console.log(`⏳ ${delaySec}秒待機（ステルス防止）...`);
  await new Promise(r => setTimeout(r, delaySec * 1000));
}

// ============================================================
// ステマアカウントの直近投稿を取得
// ============================================================

async function getRecentStealthPosts() {
  const cutoff = Date.now() - POST_LOOKBACK_HOURS * 60 * 60 * 1000;
  const candidates = [];

  for (const account of STEALTH_ACCOUNTS) {
    try {
      // 履歴から直近48時間の投稿を取得
      const history = loadHistory(account);
      const recentPosts = (history.posts || []).filter(p => {
        const postDate = new Date(p.date).getTime();
        return postDate >= cutoff && p.threadId && p.threadId !== 'dry-run';
      });

      console.log(`📋 ${account}: ${recentPosts.length}件の直近投稿`);

      for (const post of recentPosts) {
        candidates.push({
          ...post,
          account,
        });
      }
    } catch (e) {
      console.warn(`⚠️ ${account} の履歴読込失敗: ${e.message}`);
    }
  }

  return candidates;
}

// ============================================================
// メイン
// ============================================================

async function main() {
  console.log('🔁 自動リプライ 開始');
  console.log(`📅 ${new Date().toISOString()}`);
  if (DRY_RUN) console.log('🏃 DRY RUN モード');

  // 今日の返信数チェック
  const todayCount = getTodayReplyCount();
  if (todayCount >= MAX_DAILY_REPLIES) {
    console.log(`⏭️ 今日の返信上限に達しています (${todayCount}/${MAX_DAILY_REPLIES})`);
    return;
  }

  const remainingSlots = MAX_DAILY_REPLIES - todayCount;
  console.log(`📊 残り返信枠: ${remainingSlots}件`);

  // ステマアカウントの直近投稿を取得
  const candidates = await getRecentStealthPosts();
  if (candidates.length === 0) {
    console.log('📭 返信対象の投稿がありません');
    return;
  }

  console.log(`📬 返信候補: ${candidates.length}件`);

  let repliedCount = 0;

  for (const post of candidates) {
    if (repliedCount >= remainingSlots) {
      console.log('⏭️ 返信枠を使い切りました');
      break;
    }

    // 既に返信済みかチェック
    if (hasRepliedToPost(post.threadId)) {
      console.log(`   ⏭️ ${post.threadId} は返信済み`);
      continue;
    }

    // エンゲージメント取得
    let insights = {};
    if (!DRY_RUN) {
      try {
        insights = await getInsights(post.threadId, post.account);
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.warn(`   ⚠️ ${post.threadId} のインサイト取得失敗: ${e.message}`);
        continue;
      }
    } else {
      // DRY_RUN: テスト用のダミーインサイト
      insights = { views: 3000, likes: 12, replies: 3 };
    }

    // バズレベル判定
    const buzzLevel = getBuzzLevel(insights);
    console.log(`   📊 ${post.account}/${post.threadId}: ${buzzLevel.level} (views=${insights.views||0}, likes=${insights.likes||0})`);

    // 確率判定
    if (!shouldReply(buzzLevel)) {
      console.log(`   🎲 スキップ（確率 ${buzzLevel.probability * 100}% で選外）`);
      continue;
    }

    console.log(`   ✅ 返信決定 (${buzzLevel.level})`);

    // ランダム遅延
    await randomDelay();

    // 返信文生成
    console.log('   🤖 返信文生成中...');
    const replyText = await generateBusinessReply(post.text, post.account);

    console.log(`   📝 返信文: ${replyText}`);

    // 返信投稿
    let replyId = 'dry-run';
    if (!DRY_RUN) {
      try {
        console.log('   📤 返信投稿中...');
        const result = await publishReply(post.threadId, replyText, BUSINESS_ACCOUNT);
        replyId = result.id;
        console.log(`   🧵 返信完了: ID=${replyId}`);
      } catch (e) {
        console.error(`   ❌ 返信投稿失敗: ${e.message}`);
        continue;
      }
    } else {
      console.log('   🏃 DRY RUN: 返信投稿スキップ');
    }

    // 返信履歴保存
    saveReplyHistory({
      date: new Date().toISOString(),
      originalThreadId: post.threadId,
      originalAccount: post.account,
      originalText: post.text?.slice(0, 100),
      replyText,
      replyId,
      buzzLevel: buzzLevel.level,
      insights: {
        views: insights.views || 0,
        likes: insights.likes || 0,
        replies: insights.replies || 0,
      },
    });

    repliedCount++;
    console.log(`   💾 履歴保存 (${repliedCount}/${remainingSlots})`);

    // 返信間隔
    if (repliedCount < remainingSlots) {
      await new Promise(r => setTimeout(r, MIN_REPLY_INTERVAL_MS));
    }
  }

  console.log(`\n✅ 自動リプライ完了: ${repliedCount}件返信`);

  // 返信候補があったのに1件も成功しなかった場合はエラー終了
  // → GitHub Actions が failure になり、問題を検知できる
  if (candidates.length > 0 && repliedCount === 0) {
    console.error('⚠️ 返信候補があるのに0件成功。API権限（threads_manage_reply）を確認してください。');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('💥 致命的エラー:', e);
  process.exit(1);
});
