const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

const BOT_TOKEN = process.env.BOT_TOKEN || '9219700583:AAGSAXsd3g34KHI0fTYoJzCbfiv2mlLCJ48';
const MONGODB_URI = process.env.MONGODB_URI;
const VIP_CHANNEL_ID = process.env.VIP_CHANNEL_ID || '-1004316350899';
const ADMIN_ID = String(process.env.ADMIN_ID || '5411921025').trim();

let cachedClient = null;
async function getDb() {
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 1,
      maxIdleTimeMS: 60000
    });
    await cachedClient.connect();
  }
  return cachedClient.db('vip_event_bot');
}

async function getEventConfig(db) {
  const col = db.collection('event_config');
  let cfg = await col.findOne({ _id: 'main_event' });
  if (!cfg) {
    cfg = {
      _id: 'main_event',
      reg_enabled: true,
      event_end_date: null, // Format: YYYY-MM-DD
      target_points: 30,
      max_winners: 5,
      claimed_winners: 0
    };
    await col.insertOne(cfg);
  }
  return cfg;
}

function maskId(id) {
  const str = String(id);
  if (str.length <= 4) return '***';
  return `${str.slice(0, 3)}***${str.slice(-3)}`;
}

// Sri Lanka Standard Time (+05:30) Formatter (YYYY-MM-DD)
function getSLDateOnlyString(futureTimestamp) {
  const slOffset = 5.5 * 60 * 60 * 1000;
  const slDate = new Date(futureTimestamp + slOffset);
  const y = slDate.getUTCFullYear();
  const m = String(slDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(slDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const bot = new Telegraf(BOT_TOKEN);

// Auto-configure Scoped Commands
let commandsConfigured = false;
async function setupBotCommands() {
  if (commandsConfigured) return;
  try {
    await bot.telegram.setMyCommands(
      [
        { command: 'start', description: 'Start bot & register' },
        { command: 'leaderboard', description: 'View leaderboard' }
      ],
      { scope: { type: 'default' } }
    );

    if (ADMIN_ID) {
      await bot.telegram.setMyCommands(
        [
          { command: 'start', description: 'Start bot' },
          { command: 'leaderboard', description: 'View leaderboard' },
          { command: 'admin', description: 'Admin Control Panel' }
        ],
        { scope: { type: 'chat', chat_id: Number(ADMIN_ID) } }
      );
    }
    commandsConfigured = true;
  } catch (e) {
    console.error('Commands setup error:', e.message);
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
    const badges = ['🥇', '🥈', '🥉', '🏅', '🎖️'];

    for (let i = 0; i < 5; i++) {
      const u = topUsers[i];
      if (u) {
        text += `${badges[i]}  ${maskId(u._id)} : ⭐️ ${u.points} Pts\n`;
      } else {
        text += `${badges[i]}  --- : ⭐️ 0 Pts\n`;
      }
    }

    text += `━━━━━━━━━━━━━━━\n`;
    text += `🎁 Claimed: <b>${cfg.claimed_winners} / ${cfg.max_winners}</b>\n`;

    if (userId) {
      const currentUser = await db.collection('event_users').findOne({ _id: userId });
      if (currentUser) {
        const higherCount = await db.collection('event_users').countDocuments({ points: { $gt: currentUser.points } });
        text += `👤 You: ${maskId(userId)} | Rank #${higherCount + 1} (⭐️ ${currentUser.points} Pts)\n`;
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

// --- User Handlers ---

bot.start(async (ctx) => {
  if (!ctx.from) return;
  const payload = ctx.startPayload;
  const userId = ctx.from.id;

  try {
    const db = await getDb();
    const cfg = await getEventConfig(db);

    if (payload === 'leaderboard') {
      const text = await renderLeaderboardText(ctx);
      return ctx.reply(text, { parse_mode: 'HTML', ...leaderboardKeyboard });
    }

    if (payload === 'JOIN_EVENT') {
      if (!cfg.reg_enabled) {
        return ctx.reply('⚠️ Registration is currently closed!');
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
            vip_claimed: false
          }
        },
        { upsert: true }
      );

      const msg = `🎉 <b>VIP Challenge Registered!</b>\n\nUnlock videos to earn points. First <b>${cfg.max_winners} users</b> to reach the target win <b>Free VIP!</b>\n\n🎯 Target: <b>${cfg.target_points} Points</b>`;
      return ctx.reply(msg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Check Leader Board', 'view_leaderboard')]
        ])
      });
    }

    return ctx.reply(
      `👋 Welcome to VIP Event Bot!\n\nCheck your rank, target and points below:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🏆 Leader Board', 'view_leaderboard')]
        ])
      }
    );
  } catch (err) {
    console.error('Start error:', err);
  }
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

// --- Admin Dashboard Handlers ---

async function buildAdminPanel(db, cfg) {
  const totalRegistered = await db.collection('event_users').countDocuments();
  const totalStats = await db.collection('event_users').aggregate([
    { $group: { _id: null, totalPoints: { $sum: "$points" } } }
  ]).toArray();
  const totalUnlocks = totalStats.length > 0 ? totalStats[0].totalPoints : 0;

  const text = `⚙️ <b>VIP Event Control Panel</b>\n\n` +
    `• Registration: ${cfg.reg_enabled ? '🟢 OPEN' : '🔴 CLOSED'}\n` +
    `• Event End Date: ${cfg.event_end_date || 'Not Set'}\n` +
    `• Target Points: ${cfg.target_points}\n` +
    `• VIP Slots: ${cfg.claimed_winners} / ${cfg.max_winners} Claimed\n\n` +
    `👥 Registered Users: ${totalRegistered}\n` +
    `🔓 Total Unlocks: ${totalUnlocks}`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`Reg: ${cfg.reg_enabled ? '🟢 ON' : '🔴 OFF'}`, 'toggle_reg')
    ],
    [
      Markup.button.callback('📅 Set End Date', 'admin_pick_date'),
      Markup.button.callback('🎯 Set Target', 'admin_set_target')
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

bot.action('toggle_reg', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  const cfg = await getEventConfig(db);
  await db.collection('event_config').updateOne(
    { _id: 'main_event' },
    { $set: { reg_enabled: !cfg.reg_enabled } }
  );
  await ctx.answerCbQuery('Updated!');
  const newCfg = await getEventConfig(db);
  const { text, keyboard } = await buildAdminPanel(db, newCfg);
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
});

bot.action('admin_pick_date', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  const cfg = await getEventConfig(db);
  await ctx.answerCbQuery();
  return ctx.reply(`⏱️ <b>Select Event Duration:</b>\n\n📌 <b>Current End Date:</b> ${cfg.event_end_date || 'Not Set'}`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('+7 Days', 'set_days_7'),
        Markup.button.callback('+14 Days', 'set_days_14')
      ],
      [
        Markup.button.callback('+30 Days', 'set_days_30'),
        Markup.button.callback('❌ Clear Date', 'set_days_clear')
      ],
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
  await db.collection('event_config').updateOne(
    { _id: 'main_event' },
    { $set: { event_end_date: dateStr } }
  );
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
  await db.collection('event_config').updateOne(
    { _id: 'main_event' },
    { $set: { admin_state: 'awaiting_target' } }
  );
  await ctx.answerCbQuery();
  return ctx.reply('Send target points number (e.g. 30).\n\nSend /cancel to abort.');
});

// 2-Step Confirmation Reset
bot.action('admin_reset_confirm', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery();
  return ctx.reply(
    '⚠️ <b>Warning: Permanent Action!</b>\n\nThis will completely wipe all registered users, claims, and leaderboard points. Are you sure?',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Yes, Delete Everything', 'admin_reset_execute')],
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
  await db.collection('event_users').deleteMany({});
  await db.collection('event_config').updateOne(
    { _id: 'main_event' },
    { $set: { claimed_winners: 0 } }
  );
  await ctx.answerCbQuery('Database Cleared!');
  return ctx.reply('✅ All event data has been permanently deleted and reset.');
});

bot.command('cancel', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;
  const db = await getDb();
  await db.collection('event_config').updateOne(
    { _id: 'main_event' },
    { $unset: { admin_state: '' } }
  );
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
    return ctx.reply(`✅ Target Points set to: ${pts}`);
  }
});

// --- Claim Handler (From File Bot) ---

async function handleClaim(reqBody) {
  try {
    const { userId, fileKey } = reqBody;
    if (!userId || !fileKey) return { ok: false, reason: 'missing_params' };

    const db = await getDb();
    const cfg = await getEventConfig(db);

    // End date validation (Active until 23:59:59 Sri Lanka Time of that date)
    if (cfg.event_end_date) {
      const endTimestamp = new Date(`${cfg.event_end_date}T23:59:59+05:30`).getTime();
      if (!isNaN(endTimestamp) && Date.now() > endTimestamp) {
        return { ok: false, reason: 'event_ended' };
      }
    }

    const user = await db.collection('event_users').findOne({ _id: Number(userId) });
    if (!user) return { ok: false, reason: 'not_registered' };

    if (user.claimed_files && user.claimed_files.includes(String(fileKey))) {
      return { ok: false, reason: 'already_claimed' };
    }

    const updateRes = await db.collection('event_users').findOneAndUpdate(
      { _id: Number(userId), claimed_files: { $ne: String(fileKey) } },
      { 
        $push: { claimed_files: String(fileKey) },
        $inc: { points: 1 }
      },
      { returnDocument: 'after' }
    );

    const updatedUser = updateRes.value || updateRes;
    if (!updatedUser) return { ok: false };

    // Target reached & VIP link delivery
    if (updatedUser.points >= cfg.target_points && !updatedUser.vip_claimed) {
      if (cfg.claimed_winners < cfg.max_winners) {
        const confUpdate = await db.collection('event_config').findOneAndUpdate(
          { _id: 'main_event', claimed_winners: { $lt: cfg.max_winners } },
          { $inc: { claimed_winners: 1 } },
          { returnDocument: 'after' }
        );

        const currentSlot = (confUpdate.value || confUpdate).claimed_winners;

        if (confUpdate.value || confUpdate) {
          await db.collection('event_users').updateOne(
            { _id: Number(userId) },
            { $set: { vip_claimed: true } }
          );

          // 24h single-use VIP link
          const expireDate = Math.floor(Date.now() / 1000) + (24 * 60 * 60);
          const invite = await bot.telegram.createChatInviteLink(VIP_CHANNEL_ID, {
            member_limit: 1,
            expire_date: expireDate
          });

          // 1. Winner Message
          const winMsg = `🏆 <b>Congratulations!</b>\n\nYou are one of the first ${cfg.max_winners} winners to reach the target!\n\n🔗 <a href="${invite.invite_link}">Join VIP Channel</a>\n<i>(Valid for 1 person / 24 hours only)</i>`;
          await bot.telegram.sendMessage(userId, winMsg, { parse_mode: 'HTML' });

          // 2. Alert to Admin
          if (ADMIN_ID) {
            const uNameText = updatedUser.username ? `@${updatedUser.username}` : 'No username';
            const fNameText = updatedUser.first_name || 'User';
            const adminAlert = `🚨 <b>New VIP Winner Claimed!</b>\n\n` +
              `• <b>Slot:</b> ${currentSlot} / ${cfg.max_winners}\n` +
              `• <b>Name:</b> ${fNameText}\n` +
              `• <b>Username:</b> ${uNameText}\n` +
              `• <b>User ID:</b> <code>${userId}</code>\n` +
              `• <b>Points:</b> ${updatedUser.points}`;

            bot.telegram.sendMessage(ADMIN_ID, adminAlert, { parse_mode: 'HTML' }).catch(() => {});
          }
        }
      } else {
        await bot.telegram.sendMessage(userId, '⏳ <b>VIP Slots Full!</b>\n\nAll winners have already claimed their VIP access.', { parse_mode: 'HTML' });
      }
    }

    return { ok: true };
  } catch (err) {
    console.error('Claim error:', err.message);
    return { ok: false, error: err.message };
  }
}

// --- Vercel Serverless Entry Point ---

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    setupBotCommands().catch(() => {});

    if (req.url.includes('/api/claim') || (req.body && req.body.fileKey)) {
      const result = await handleClaim(req.body);
      return res.status(200).json(result);
    }

    try {
      if (req.body && typeof req.body === 'object') {
        await bot.handleUpdate(req.body);
      }
    } catch (err) {
      console.error('Webhook error:', err);
    }
    return res.status(200).send('OK');
  }

  return res.status(200).send('HL Event Bot is Running!');
};
