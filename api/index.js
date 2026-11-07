const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

const BOT_TOKEN = process.env.BOT_TOKEN || '9219700583:AAGSAXsd3g34KHI0fTYoJzCbfiv2mlLCJ48';
const MONGODB_URI = process.env.MONGODB_URI;
const MAIN_CHANNEL_ID = String(process.env.MAIN_CHANNEL_ID || '-1004309315754').trim();
const BACKUP_CHANNEL_ID = String(process.env.BACKUP_CHANNEL_ID || '-1004306300202').trim();
const VIP_CHANNEL_ID = String(process.env.VIP_CHANNEL_ID || '-1004316350899').trim();
const ADMIN_ID = String(process.env.ADMIN_ID || '5411921025').trim();
const VERCEL_URL = 'https://event-bot-sigma.vercel.app';

let cachedClient = null;
async function getDb() {
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 1,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 10000,
      serverSelectionTimeoutMS: 5000
    });
    await cachedClient.connect();
  }
  return cachedClient.db('vip_event_bot');
}

// Config Cache Helper
let cachedConfig = null;
let configLastFetched = 0;

async function getEventConfig(db) {
  const now = Date.now();
  if (cachedConfig && (now - configLastFetched < 15000)) {
    return cachedConfig;
  }
  const col = db.collection('event_config');
  let cfg = await col.findOne({ _id: 'main_event' });
  if (!cfg) {
    cfg = {
      _id: 'main_event',
      reg_enabled: true,
      referrals_enabled: true,
      event_end_date: null,
      target_points: 200,
      max_winners: 5,
      claimed_winners: 0,
      banner_file_id: null
    };
    await col.insertOne(cfg);
  }
  cachedConfig = cfg;
  configLastFetched = now;
  return cfg;
}

function maskId(id) {
  const str = String(id);
  if (str.length <= 4) return '***';
  return `${str.slice(0, 3)}***${str.slice(-3)}`;
}

function getSLDateOnlyString(futureTimestamp) {
  const slOffset = 5.5 * 60 * 60 * 1000;
  const slDate = new Date(futureTimestamp + slOffset);
  const y = slDate.getUTCFullYear();
  const m = String(slDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(slDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const bot = new Telegraf(BOT_TOKEN);

// Auto-Healing Webhook & Scoped Commands Setup
let systemInitialized = false;
async function initSystem() {
  if (systemInitialized) return;
  try {
    const info = await bot.telegram.getWebhookInfo();
    if (!info.url || info.url !== VERCEL_URL) {
      await bot.telegram.setWebhook(VERCEL_URL, {
        allowed_updates: ['message', 'callback_query', 'chat_join_request', 'chat_member']
      });
    }

    await bot.telegram.setMyCommands(
      [
        { command: 'start', description: 'Start bot' },
        { command: 'leaderboard', description: 'View leaderboard' }
      ],
      { scope: { type: 'default' } }
    );

    if (ADMIN_ID) {
      await bot.telegram.setMyCommands(
        [
          { command: 'start', description: 'Start bot' },
          { command: 'leaderboard', description: 'View leaderboard' },
          { command: 'admin', description: 'Event Control Panel' }
        ],
        { scope: { type: 'chat', chat_id: Number(ADMIN_ID) } }
      );
    }
    systemInitialized = true;
  } catch (e) {
    console.error('Init error:', e.message);
  }
}

// --- Leaderboard View Logic ---

async function renderLeaderboardText(ctx) {
  try {
    const db = await getDb();
    const cfg = await getEventConfig(db);
    const userId = ctx.from ? ctx.from.id : null;

    const topUsers = await db.collection('event_users')
      .find({})
      .sort({ points: -1, registered_at: 1 })
      .limit(5)
      .toArray();

    let text = `🏆 <b>VIP RACE (TOP 5)</b>\n\n`;
    const badges = ['🥇', '🥈', '🥉', '❹', '❺'];

    for (let i = 0; i < 5; i++) {
      const u = topUsers[i];
      if (u) {
        text += `${badges[i]} ${maskId(u._id)} : ${u.points} XP\n`;
      } else {
        text += `${badges[i]} --- : 0 XP\n`;
      }
    }

    text += `━━━━━━━━━━━━━━━\n`;
    text += `🎁 Claimed: <b>${cfg.claimed_winners} / ${cfg.max_winners}</b>\n`;

    if (userId) {
      const currentUser = await db.collection('event_users').findOne({ _id: userId });
      if (currentUser) {
        const higherCount = await db.collection('event_users').countDocuments({ points: { $gt: currentUser.points } });
        text += `👤 You: ${maskId(userId)} | Rank #${higherCount + 1} (${currentUser.points} XP)\n`;
      } else {
        text += `👤 You: <i>Not registered yet</i>\n`;
      }
    }

    if (cfg.event_end_date) {
      text += `⏳ Ends: ${cfg.event_end_date}`;
    }

    return text;
  } catch (e) {
    console.error('Leaderboard error:', e);
    return '❌ Could not load leaderboard.';
  }
}

const leaderboardKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Refresh', 'refresh_leaderboard')]
]);

// --- User Flow Handlers ---

bot.start(async (ctx) => {
  if (!ctx.from) return;
  const payload = ctx.startPayload;
  const userId = ctx.from.id;
  const fName = ctx.from.first_name || 'User';

  try {
    const db = await getDb();
    const cfg = await getEventConfig(db);

    if (payload === 'leaderboard') {
      const text = await renderLeaderboardText(ctx);
      return ctx.reply(text, { parse_mode: 'HTML', ...leaderboardKeyboard });
    }

    const existingUser = await db.collection('event_users').findOne({ _id: userId });

    if (!existingUser) {
      const welcomeNew = `👋 Welcome <b>${fName}</b> to <b>Hot Lanka Event Bot</b>!\n\n` +
        `🎁 <b>VIP Giveaway Challenge!</b>\n` +
        `Videos unlock කර හෝ යහළුවන් Invite කර XP ලබාගන්න. Target එක සම්පූර්ණ කරන <b>මුල් ${cfg.max_winners} දෙනාට Hot Lanka VIP එක Free</b> හිමිවේ!\n\n` +
        `⚡️ <b>Rates:</b>\n` +
        `• 1 Video Unlock = <b>1 XP</b>\n` +
        `• 1 Verified Referral = <b>20 XP</b>\n` +
        `🎯 <b>Target:</b> <b>${cfg.target_points} XP</b>\n\n` +
        `Challenge එකට එකතු වෙන්න පහත <b>Join Event</b> බටන් එක ක්ලික් කරන්න:`;

      return ctx.reply(welcomeNew, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🚀 Join Event', 'action_join_event')]
        ])
      });
    }

    const welcomeReturning = `👋 Welcome back <b>${fName}</b> to <b>Hot Lanka Event Bot</b>!\n\n` +
      `⚡️ <b>Rates:</b> 1 Video = 1 XP | 1 Referral = 20 XP\n` +
      `🎯 <b>Target:</b> <b>${cfg.target_points} XP</b>`;

    return ctx.reply(welcomeReturning, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔗 Get Invite Link', 'get_invite_link')],
        [Markup.button.callback('🏆 Leader Board', 'view_leaderboard')]
      ])
    });
  } catch (err) {
    console.error('Start error:', err);
  }
});

// Join Event Button Action
bot.action('action_join_event', async (ctx) => {
  if (!ctx.from) return;
  const userId = ctx.from.id;

  try {
    const db = await getDb();
    const cfg = await getEventConfig(db);

    if (!cfg.reg_enabled) {
      const regClosedMsg = `⚠️ <b>Registration is currently closed!</b>\n` +
        `දැනට Referral Program එක තාවකාලිකව නවතා ඇත.\n` +
        `💬 Contact Admin: <a href="https://t.me/LankaAdmin_bot">Hot Lanka Admin</a>`;
      await ctx.answerCbQuery('Registration Closed', { show_alert: true });
      return ctx.reply(regClosedMsg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }

    const existingUser = await db.collection('event_users').findOne({ _id: userId });
    if (existingUser) {
      await ctx.answerCbQuery();
      return ctx.reply('ඔබ දැනටමත් ලියාපදිංචි වී ඇත!', {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔗 Get Invite Link', 'get_invite_link')],
          [Markup.button.callback('🏆 Leader Board', 'view_leaderboard')]
        ])
      });
    }

    await db.collection('event_users').updateOne(
      { _id: userId },
      { 
        $set: {
          first_name: ctx.from.first_name || 'User',
          username: ctx.from.username || null
        },
        $setOnInsert: { 
          registered_at: new Date(),
          points: 0,
          claimed_files: [],
          referral_count: 0,
          vip_claimed: false
        }
      },
      { upsert: true }
    );

    await ctx.answerCbQuery('සාර්ථකව ලියාපදිංචි විය!');

    const msg = `🎉 <b>VIP Challenge Registered!</b>\n\n` +
      `ඔබ සාර්ථකව Event එකට ලියාපදිංචි විය! දැන් videos unlock කර හෝ මිතුරන් එකතු කර <b>XP</b> වැඩි කරගන්න.\n\n` +
      `🎯 <b>Target:</b> <b>${cfg.target_points} XP</b>`;

    return ctx.reply(msg, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔗 Get Invite Link', 'get_invite_link')],
        [Markup.button.callback('🏆 Leader Board', 'view_leaderboard')]
      ])
    });
  } catch (e) {
    console.error('Join error:', e);
  }
});

// Button: Get Invite Link
bot.action('get_invite_link', async (ctx) => {
  if (!ctx.from) return;
  const userId = ctx.from.id;

  try {
    const db = await getDb();
    const cfg = await getEventConfig(db);

    if (!cfg.referrals_enabled) {
      const pausedMsg = `⚠️ <b>Referral Program Temporarily Paused!</b>\n` +
        `දැනට Referral Program එක තාවකාලිකව නවතා ඇත.\n` +
        `💬 Contact Admin: <a href="https://t.me/LankaAdmin_bot">Hot Lanka Admin</a>`;
      await ctx.answerCbQuery('Referrals Paused', { show_alert: true });
      return ctx.reply(pausedMsg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }

    await ctx.answerCbQuery('Generating Link...');
    let user = await db.collection('event_users').findOne({ _id: userId });

    if (!user) {
      await db.collection('event_users').updateOne(
        { _id: userId },
        {
          $set: { first_name: ctx.from.first_name || 'User', username: ctx.from.username || null },
          $setOnInsert: { registered_at: new Date(), points: 0, claimed_files: [], referral_count: 0, vip_claimed: false }
        },
        { upsert: true }
      );
      user = await db.collection('event_users').findOne({ _id: userId });
    }

    if (user.vip_claimed) {
      return ctx.reply("🚫 <b>Access Denied!</b>\nYou have already claimed your VIP reward.", { parse_mode: 'HTML' });
    }

    let inviteLink = user.invite_link;
    if (!inviteLink) {
      const linkObj = await ctx.telegram.createChatInviteLink(MAIN_CHANNEL_ID, {
        name: `ref_${userId}`,
        creates_join_request: true
      });
      inviteLink = linkObj.invite_link;

      await Promise.all([
        db.collection('event_users').updateOne({ _id: userId }, { $set: { invite_link: inviteLink } }),
        db.collection('inviters').updateOne(
          { _id: userId },
          { $set: { invite_link: inviteLink, first_name: ctx.from.first_name || 'User', username: ctx.from.username || null } },
          { upsert: true }
        )
      ]);
    }

    const currentPts = user.points || 0;
    const msg = `🔗 <b>Your Personal Invite Link:</b>\n` +
      `${inviteLink}\n\n` +
      `📊 <b>Current Points:</b> <b>${currentPts} / ${cfg.target_points} XP</b>\n` +
      `<i>(1 Verified Referral = +20 XP)</i>`;

    return ctx.reply(msg, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📝 Invite Msg', 'gen_invite_msg'),
          Markup.button.callback('📊 Progress', 'my_progress')
        ]
      ])
    });
  } catch (err) {
    console.error('Invite link generation error:', err);
    return ctx.reply("❌ Error generating invite link. Make sure the Bot is an Admin in the Main Channel.");
  }
});

// Button: Generate Invite Message
bot.action('gen_invite_msg', async (ctx) => {
  if (!ctx.from) return;
  const userId = ctx.from.id;
  await ctx.answerCbQuery();

  const db = await getDb();
  const [user, cfg] = await Promise.all([
    db.collection('event_users').findOne({ _id: userId }),
    getEventConfig(db)
  ]);

  if (!user || !user.invite_link) {
    return ctx.reply("⚠️ Please click '🔗 Get Invite Link' first.");
  }

  const caption = `<b>Hot Lanka Exclusive !</b> 🔥 \n` +
    `<b>Tap here to Join</b> 👇\n` +
    `${user.invite_link}`;

  const inviteKeyboard = Markup.inlineKeyboard([
    [Markup.button.url('🔗 Join Hot Lanka', user.invite_link)]
  ]);

  if (cfg.banner_file_id) {
    return ctx.replyWithPhoto(cfg.banner_file_id, {
      caption: caption,
      parse_mode: 'HTML',
      ...inviteKeyboard
    }).catch(async () => {
      return ctx.reply(caption, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...inviteKeyboard });
    });
  }

  return ctx.reply(caption, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...inviteKeyboard
  });
});

// Button: My Progress
bot.action(['my_progress', 'refresh_user_progress'], async (ctx) => {
  if (!ctx.from) return;
  const userId = ctx.from.id;

  const db = await getDb();
  const [user, cfg] = await Promise.all([
    db.collection('event_users').findOne({ _id: userId }),
    getEventConfig(db)
  ]);

  const currentPts = user ? (user.points || 0) : 0;
  const refCount = user ? (user.referral_count || 0) : 0;
  const remaining = Math.max(0, cfg.target_points - currentPts);

  const progressText = `📊 <b>Your Event Progress</b>\n\n` +
    `• <b>Completed:</b> <b>${currentPts} / ${cfg.target_points} XP</b>\n` +
    `• <b>Remaining:</b> <b>${remaining} XP</b> more needed\n` +
    `• <b>Verified Referrals:</b> <b>${refCount}</b> <i>(+ ${refCount * 20} XP)</i>\n\n` +
    `⚠️ මිතුරන් Main Channel එකට Join වී, videos unlock කරගත් පසු පමණක් Referral එක verified වේ.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh Progress', 'refresh_user_progress')]
  ]);

  if (ctx.callbackQuery.data === 'refresh_user_progress') {
    await ctx.answerCbQuery('Updated!');
    return ctx.editMessageText(progressText, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  }

  await ctx.answerCbQuery();
  return ctx.reply(progressText, { parse_mode: 'HTML', ...keyboard });
});

bot.command('leaderboard', async (ctx) => {
  const text = await renderLeaderboardText(ctx);
  return ctx.reply(text, { parse_mode: 'HTML', ...leaderboardKeyboard });
});

bot.action('view_leaderboard', async (ctx) => {
  await ctx.answerCbQuery();
  const text = await renderLeaderboardText(ctx);
  return ctx.reply(text, { parse_mode: 'HTML', ...leaderboardKeyboard });
});

bot.action('refresh_leaderboard', async (ctx) => {
  try {
    const text = await renderLeaderboardText(ctx);
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...leaderboardKeyboard });
    return ctx.answerCbQuery('Updated!');
  } catch (e) {
    return ctx.answerCbQuery();
  }
});

// --- Referral Webhook Events ---

// Tracking Step 1: Join Request on Main Channel
bot.on('chat_join_request', async (ctx) => {
  try {
    const req = ctx.chatJoinRequest;
    if (!req || String(req.chat.id) !== MAIN_CHANNEL_ID) return;

    const inviteeId = req.from.id;
    const inviteLink = req.invite_link ? req.invite_link.invite_link : null;
    if (!inviteLink) return;

    const db = await getDb();
    const inviter = await db.collection('event_users').findOne({ invite_link: inviteLink });
    if (!inviter || inviter._id === inviteeId || inviter.vip_claimed) return;

    await db.collection('invitees').updateOne(
      { invitee_id: inviteeId },
      {
        $setOnInsert: {
          invitee_id: inviteeId,
          inviter_id: inviter._id,
          main_joined: true,
          backup_joined: false,
          is_counted: false,
          created_at: new Date()
        }
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('chat_join_request error:', err);
  }
});

// Tracking Step 2: Member Joins Backup Channel -> Verification +20 XP
bot.on('chat_member', async (ctx) => {
  try {
    const cm = ctx.chatMember;
    if (!cm || String(cm.chat.id) !== BACKUP_CHANNEL_ID) return;

    const newStatus = cm.new_chat_member ? cm.new_chat_member.status : null;
    const oldStatus = cm.old_chat_member ? cm.old_chat_member.status : null;

    if (newStatus === 'member' && ['left', 'kicked'].includes(oldStatus)) {
      const inviteeId = cm.new_chat_member.user.id;
      const joinedName = cm.new_chat_member.user.first_name || 'Member';
      const db = await getDb();
      const cfg = await getEventConfig(db);

      const updateResult = await db.collection('invitees').findOneAndUpdate(
        { invitee_id: inviteeId, is_counted: false },
        { $set: { backup_joined: true, is_counted: true, verified_at: new Date() } },
        { returnDocument: 'after' }
      );

      const record = updateResult.value || updateResult;
      if (!record || !record.inviter_id) return;

      const inviterId = record.inviter_id;

      // Add +20 XP and increment referral_count
      const userUpdate = await db.collection('event_users').findOneAndUpdate(
        { _id: inviterId },
        { $inc: { points: 20, referral_count: 1 } },
        { returnDocument: 'after' }
      );

      const updatedInviter = userUpdate.value || userUpdate;
      if (!updatedInviter) return;

      const currentPts = updatedInviter.points || 0;
      const inviterName = updatedInviter.first_name || 'Inviter';

      // 1. Admin Alert
      if (ADMIN_ID) {
        const adminReferralAlert = `🔔 <b>New Verified Referral!</b>\n\n` +
          `👤 <b>Inviter:</b> ${inviterName} (${currentPts} / ${cfg.target_points} XP)\n` +
          `➕ <b>Joined User:</b> ${joinedName}\n` +
          `⚡️ <b>Added:</b> +20 XP`;
        bot.telegram.sendMessage(ADMIN_ID, adminReferralAlert, { parse_mode: 'HTML' }).catch(() => {});
      }

      // 2. Inviter Instant Notification
      const refSuccessMsg = `🎉 <b>New Referral Completed!</b>\n\n` +
        `යාලුවෙක් ඔබේ link එකෙන් සම්බන්ධ වීම තහවුරු විය!\n` +
        `➕ <b>+20 XP</b> ඔබේ ගිණුමට එකතු විය.\n\n` +
        `📊 <b>Total XP:</b> <b>${currentPts} / ${cfg.target_points} XP</b>`;

      await bot.telegram.sendMessage(inviterId, refSuccessMsg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('🏆 Leader Board', 'view_leaderboard')]])
      }).catch(() => {});

      // 3. Check for VIP Win
      await evaluateWinner(db, cfg, updatedInviter);
    }
  } catch (err) {
    console.error('chat_member error:', err);
  }
});

// Shared VIP Award Evaluator
async function evaluateWinner(db, cfg, user) {
  if (user.points >= cfg.target_points && !user.vip_claimed) {
    if (cfg.claimed_winners < cfg.max_winners) {
      const confUpdate = await db.collection('event_config').findOneAndUpdate(
        { _id: 'main_event', claimed_winners: { $lt: cfg.max_winners } },
        { $inc: { claimed_winners: 1 } },
        { returnDocument: 'after' }
      );

      const currentSlot = (confUpdate.value || confUpdate).claimed_winners;

      if (confUpdate.value || confUpdate) {
        await db.collection('event_users').updateOne(
          { _id: user._id },
          { $set: { vip_claimed: true, vip_claimed_at: new Date() } }
        );

        // 24h single-use VIP link
        const expireDate = Math.floor(Date.now() / 1000) + (24 * 60 * 60);
        const invite = await bot.telegram.createChatInviteLink(VIP_CHANNEL_ID, {
          member_limit: 1,
          expire_date: expireDate
        });

        const winMsg = `🏆 <b>Congratulations!</b>\n\n` +
          `You are one of the first ${cfg.max_winners} winners to reach the target!\n\n` +
          `🔗 <a href="${invite.invite_link}">Join VIP Channel</a>\n` +
          `<i>(Valid for 1 person / 24 hours only)</i>`;

        await bot.telegram.sendMessage(user._id, winMsg, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.url('👑 Join VIP Channel', invite.invite_link)]])
        }).catch(() => {});

        if (ADMIN_ID) {
          const uNameText = user.username ? `@${user.username}` : 'No username';
          const fNameText = user.first_name || 'User';
          const adminAlert = `🚨 <b>New VIP Winner Claimed!</b>\n\n` +
            `• <b>Slot:</b> ${currentSlot} / ${cfg.max_winners}\n` +
            `• <b>Name:</b> ${fNameText}\n` +
            `• <b>Username:</b> ${uNameText}\n` +
            `• <b>User ID:</b> <code>${user._id}</code>\n` +
            `• <b>Points:</b> ${user.points} XP`;

          bot.telegram.sendMessage(ADMIN_ID, adminAlert, { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    } else {
      await bot.telegram.sendMessage(user._id, '⏳ <b>VIP Slots Full!</b>\n\nAll winners have already claimed their VIP access.', { parse_mode: 'HTML' }).catch(() => {});
    }
  }
}

// --- Claim Handler (From File Bot - Asynchronous Non-Blocking) ---

async function processClaimInBackground(userId, fileKey) {
  try {
    const db = await getDb();
    const cfg = await getEventConfig(db);

    if (cfg.event_end_date) {
      const endTimestamp = new Date(`${cfg.event_end_date}T23:59:59+05:30`).getTime();
      if (!isNaN(endTimestamp) && Date.now() > endTimestamp) return;
    }

    const user = await db.collection('event_users').findOne({ _id: Number(userId) });
    if (!user) return;

    if (user.claimed_files && user.claimed_files.includes(String(fileKey))) return;

    const updateRes = await db.collection('event_users').findOneAndUpdate(
      { _id: Number(userId), claimed_files: { $ne: String(fileKey) } },
      { 
        $push: { claimed_files: String(fileKey) },
        $inc: { points: 1 }
      },
      { returnDocument: 'after' }
    );

    const updatedUser = updateRes.value || updateRes;
    if (updatedUser) {
      await evaluateWinner(db, cfg, updatedUser);
    }
  } catch (err) {
    console.error('processClaimInBackground error:', err.message);
  }
}

// --- Admin Control Panel Handlers ---

async function buildAdminPanel(db, cfg) {
  const [totalRegistered, totalVerifiedRef, totalPointsAgg] = await Promise.all([
    db.collection('event_users').countDocuments(),
    db.collection('invitees').countDocuments({ is_counted: true }),
    db.collection('event_users').aggregate([{ $group: { _id: null, totalPoints: { $sum: "$points" } } }]).toArray()
  ]);

  const totalPoints = totalPointsAgg.length > 0 ? totalPointsAgg[0].totalPoints : 0;
  const totalVideoUnlocks = Math.max(0, totalPoints - (totalVerifiedRef * 20));

  const text = `⚙️ <b>Event Control Panel</b>\n\n` +
    `• Registration: ${cfg.reg_enabled ? '🟢 OPEN' : '🔴 CLOSED'}\n` +
    `• Referrals: ${cfg.referrals_enabled ? '🟢 ACTIVE' : '🔴 PAUSED'}\n` +
    `• Event End Date: ${cfg.event_end_date || 'Not Set'}\n` +
    `• Target Points: ${cfg.target_points} XP\n` +
    `• VIP Slots: ${cfg.claimed_winners} / ${cfg.max_winners} Claimed\n\n` +
    `👥 <b>Registered Users:</b> ${totalRegistered}\n` +
    `🔓 <b>Total Video Unlocks:</b> ${totalVideoUnlocks}\n` +
    `🤝 <b>Total Verified Referrals:</b> ${totalVerifiedRef}`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`Reg: ${cfg.reg_enabled ? '🟢 ON' : '🔴 OFF'}`, 'toggle_reg'),
      Markup.button.callback(`Referrals: ${cfg.referrals_enabled ? '🟢 ON' : '🔴 OFF'}`, 'toggle_referrals')
    ],
    [
      Markup.button.callback('📅 Set End Date', 'admin_pick_date'),
      Markup.button.callback('🎯 Set Target', 'admin_set_target')
    ],
    [
      Markup.button.callback('🖼 Set Banner', 'prompt_banner_upload'),
      Markup.button.callback('🔄 Refresh Panel', 'refresh_admin_panel')
    ],
    [
      Markup.button.callback('🔄 Reset Event Data', 'admin_reset_confirm')
    ]
  ]);

  return { text, keyboard };
}

bot.command('admin', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;
  const db = await getDb();
  const cfg = await getEventConfig(db);
  const { text, keyboard } = await buildAdminPanel(db, cfg);
  return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
});

bot.action('refresh_admin_panel', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  cachedConfig = null;
  const db = await getDb();
  const cfg = await getEventConfig(db);
  const { text, keyboard } = await buildAdminPanel(db, cfg);
  await ctx.answerCbQuery('Updated!');
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action('toggle_reg', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  const cfg = await getEventConfig(db);
  await db.collection('event_config').updateOne({ _id: 'main_event' }, { $set: { reg_enabled: !cfg.reg_enabled } });
  cachedConfig = null;
  const newCfg = await getEventConfig(db);
  const { text, keyboard } = await buildAdminPanel(db, newCfg);
  await ctx.answerCbQuery('Updated!');
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action('toggle_referrals', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  const cfg = await getEventConfig(db);
  await db.collection('event_config').updateOne({ _id: 'main_event' }, { $set: { referrals_enabled: !cfg.referrals_enabled } });
  cachedConfig = null;
  const newCfg = await getEventConfig(db);
  const { text, keyboard } = await buildAdminPanel(db, newCfg);
  await ctx.answerCbQuery('Updated!');
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action('admin_pick_date', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  const cfg = await getEventConfig(db);
  await ctx.answerCbQuery();
  return ctx.reply(`⏱️ <b>Select Event Duration:</b>\n\n📌 <b>Current End Date:</b> ${cfg.event_end_date || 'Not Set'}`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('+7 Days', 'set_days_7'), Markup.button.callback('+14 Days', 'set_days_14')],
      [Markup.button.callback('+30 Days', 'set_days_30'), Markup.button.callback('❌ Clear Date', 'set_days_clear')],
      [Markup.button.callback('🔙 Back to Panel', 'admin_back_to_panel')]
    ])
  });
});

async function applyDays(ctx, days) {
  const db = await getDb();
  let dateStr = null;
  if (days > 0) {
    const futureTimestamp = Date.now() + (days * 24 * 60 * 60 * 1000);
    dateStr = getSLDateOnlyString(futureTimestamp);
  }
  await db.collection('event_config').updateOne({ _id: 'main_event' }, { $set: { event_end_date: dateStr } });
  cachedConfig = null;
  await ctx.answerCbQuery('Date Updated!');
  return ctx.reply(`✅ Event End Date set to: <b>${dateStr || 'Cleared'}</b>`, { parse_mode: 'HTML' });
}

bot.action('set_days_7', (ctx) => applyDays(ctx, 7));
bot.action('set_days_14', (ctx) => applyDays(ctx, 14));
bot.action('set_days_30', (ctx) => applyDays(ctx, 30));
bot.action('set_days_clear', (ctx) => applyDays(ctx, 0));

bot.action('admin_back_to_panel', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getEventConfig(db);
  const { text, keyboard } = await buildAdminPanel(db, cfg);
  return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
});

bot.action('admin_set_target', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  await db.collection('event_config').updateOne({ _id: 'main_event' }, { $set: { admin_state: 'awaiting_target' } });
  await ctx.answerCbQuery();
  return ctx.reply('Send target XP number (e.g. 200).\n\nSend /cancel to abort.');
});

// Set Banner Image
bot.action('prompt_banner_upload', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  await db.collection('event_config').updateOne({ _id: 'main_event' }, { $set: { admin_state: 'awaiting_banner' } });
  await ctx.answerCbQuery();
  return ctx.reply('🖼 <b>Send New Banner Image</b>\n\nSend the photo to this chat now.\nSend /cancel to abort.', { parse_mode: 'HTML' });
});

bot.on('photo', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;
  const db = await getDb();
  const cfg = await getEventConfig(db);

  if (cfg.admin_state === 'awaiting_banner') {
    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    await db.collection('event_config').updateOne(
      { _id: 'main_event' },
      { $set: { banner_file_id: bestPhoto.file_id }, $unset: { admin_state: '' } }
    );
    cachedConfig = null;
    return ctx.reply('✅ <b>Banner photo updated successfully!</b>', { parse_mode: 'HTML' });
  }
});

// Full Wipe / Reset Confirmation
bot.action('admin_reset_confirm', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  return ctx.reply(
    '⚠️ <b>Warning: Permanent Full Database Action!</b>\n\n' +
    'This will completely wipe:\n' +
    '• All registered users & points\n' +
    '• All unlocked video claims\n' +
    '• All pending & verified referrals\n' +
    '• Reset VIP claimed slots to 0\n\n' +
    'Are you sure you want to proceed?',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Yes, Wipe Everything', 'admin_reset_execute')],
        [Markup.button.callback('❌ Cancel', 'admin_reset_abort')]
      ])
    }
  );
});

bot.action('admin_reset_abort', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery('Reset cancelled.');
  return ctx.deleteMessage().catch(() => {});
});

bot.action('admin_reset_execute', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  
  // Wipe all 3 collections simultaneously
  await Promise.all([
    db.collection('event_users').deleteMany({}),
    db.collection('invitees').deleteMany({}),
    db.collection('inviters').deleteMany({}),
    db.collection('event_config').updateOne({ _id: 'main_event' }, { $set: { claimed_winners: 0 } })
  ]);

  cachedConfig = null;
  await ctx.answerCbQuery('Database Wiped!');
  return ctx.reply('✅ <b>All event & referral data has been permanently deleted and reset.</b>', { parse_mode: 'HTML' });
});

bot.command('cancel', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;
  const db = await getDb();
  await db.collection('event_config').updateOne({ _id: 'main_event' }, { $unset: { admin_state: '' } });
  return ctx.reply('🚫 Operation cancelled.');
});

bot.on('text', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;
  const db = await getDb();
  const cfg = await getEventConfig(db);

  if (cfg.admin_state === 'awaiting_target') {
    const pts = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(pts) || pts <= 0) return ctx.reply('❌ Invalid number.');
    await db.collection('event_config').updateOne(
      { _id: 'main_event' },
      { $set: { target_points: pts }, $unset: { admin_state: '' } }
    );
    cachedConfig = null;
    return ctx.reply(`✅ Target Points set to: <b>${pts} XP</b>`, { parse_mode: 'HTML' });
  }
});

// --- Vercel Serverless Entry Point ---

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    // 1. Instant Fire-and-Forget Response for File Bot
    if (req.url.includes('/api/claim') || (req.body && req.body.fileKey)) {
      res.status(200).json({ ok: true });
      const { userId, fileKey } = req.body || {};
      if (userId && fileKey) {
        processClaimInBackground(userId, fileKey).catch((e) => console.error('BG Claim Error:', e));
      }
      return;
    }

    // 2. Telegram Webhook Updates
    initSystem().catch(() => {});
    try {
      let body = req.body;
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }
      if (body) {
        await bot.handleUpdate(body);
      }
    } catch (err) {
      console.error('Webhook processing error:', err);
    }
    return res.status(200).send('OK');
  }

  // GET request (Health Check)
  await initSystem().catch(() => {});
  return res.status(200).send('Hot Lanka Event Bot is Running and Webhook is Active!');
};
