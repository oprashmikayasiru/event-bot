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
  return cachedClient.db('file_store_bot');
}

async function getEventConfig(db) {
  const col = db.collection('event_config');
  let cfg = await col.findOne({ _id: 'main_event' });
  if (!cfg) {
    cfg = {
      _id: 'main_event',
      reg_enabled: true,
      event_end_date: null, // format: "YYYY-MM-DD HH:mm"
      target_points: 30,
      max_winners: 5,
      claimed_winners: 0
    };
    await col.insertOne(cfg);
  }
  return cfg;
}

const bot = new Telegraf(BOT_TOKEN);

// --- User Commands ---

bot.start(async (ctx) => {
  if (!ctx.from) return;
  const payload = ctx.startPayload;
  const userId = ctx.from.id;

  try {
    const db = await getDb();
    const cfg = await getEventConfig(db);

    if (payload === 'JOIN_EVENT') {
      if (!cfg.reg_enabled) {
        return ctx.reply('⚠️ Registration Closed!');
      }

      await db.collection('event_users').updateOne(
        { _id: userId },
        { 
          $setOnInsert: { 
            registered_at: new Date(),
            points: 0,
            claimed_files: [],
            vip_claimed: false,
            first_name: ctx.from.first_name || 'User'
          }
        },
        { upsert: true }
      );

      const msg = `🎉 <b>VIP Challenge Registered!</b>\n\nVideos unlock කරලා Points ගන්න. මුලින්ම Target එක ගහන <b>පළමු ${cfg.max_winners} දෙනාට VIP Free!</b>\n\n🎯 Target: <b>${cfg.target_points} Points</b>`;
      return ctx.reply(msg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Check Leaderboard', 'view_leaderboard')]
        ])
      });
    }

    return ctx.reply('👋 Welcome to VIP Event Bot!\n\nUse /leaderboard to check top ranks.');
  } catch (err) {
    console.error('Start error:', err);
  }
});

async function renderLeaderboard(ctx) {
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
    const ranks = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

    for (let i = 0; i < 5; i++) {
      const u = topUsers[i];
      if (u) {
        text += `${ranks[i]} Rank ${i + 1} : ⭐️ ${u.points} Pts\n`;
      } else {
        text += `${ranks[i]} Rank ${i + 1} : ⭐️ 0 Pts\n`;
      }
    }

    text += `━━━━━━━━━━━━\n`;
    text += `🎁 Claimed: <b>${cfg.claimed_winners} / ${cfg.max_winners}</b>\n`;

    if (userId) {
      const currentUser = await db.collection('event_users').findOne({ _id: userId });
      if (currentUser) {
        const higherCount = await db.collection('event_users').countDocuments({ points: { $gt: currentUser.points } });
        text += `👤 You: <b>Rank #${higherCount + 1}</b> (${currentUser.points} Pts)\n`;
      } else {
        text += `👤 You: Not registered yet\n`;
      }
    }

    if (cfg.event_end_date) {
      text += `⏳ Ends: <code>${cfg.event_end_date}</code>`;
    }

    return text;
  } catch (e) {
    console.error('Leaderboard error:', e);
    return '❌ Could not load leaderboard.';
  }
}

bot.command('leaderboard', async (ctx) => {
  const text = await renderLeaderboard(ctx);
  return ctx.reply(text, { parse_mode: 'HTML' });
});

bot.action('view_leaderboard', async (ctx) => {
  await ctx.answerCbQuery();
  const text = await renderLeaderboard(ctx);
  return ctx.reply(text, { parse_mode: 'HTML' });
});

// --- Admin Dashboard ---

function buildAdminPanel(cfg, totalRegistered) {
  const text = `⚙️ <b>VIP Event Control Panel</b>\n\n` +
    `• <b>Registration:</b> ${cfg.reg_enabled ? '🟢 OPEN' : '🔴 CLOSED'}\n` +
    `• <b>Event End Date:</b> <code>${cfg.event_end_date || 'Not Set'}</code>\n` +
    `• <b>Target Points:</b> <code>${cfg.target_points}</code>\n` +
    `• <b>VIP Slots:</b> <code>${cfg.claimed_winners} / ${cfg.max_winners} Claimed</code>\n\n` +
    `👥 <b>Registered Users:</b> <code>${totalRegistered}</code>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`Reg: ${cfg.reg_enabled ? '🟢 ON' : '🔴 OFF'}`, 'toggle_reg')
    ],
    [
      Markup.button.callback('⏱️ Set End Date', 'admin_set_date'),
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
  const total = await db.collection('event_users').countDocuments();
  const { text, keyboard } = buildAdminPanel(cfg, total);
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
  const total = await db.collection('event_users').countDocuments();
  const { text, keyboard } = buildAdminPanel(newCfg, total);
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
});

bot.action('admin_set_date', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Unauthorized');
  const db = await getDb();
  await db.collection('event_config').updateOne(
    { _id: 'main_event' },
    { $set: { admin_state: 'awaiting_end_date' } }
  );
  await ctx.answerCbQuery();
  return ctx.reply('Send End Date (Format: YYYY-MM-DD HH:mm)\nExample: 2026-12-06 23:59\n\nSend /cancel to abort.');
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
    { $unset: { admin_state: "" } }
  );
  return ctx.reply('🚫 Operation cancelled.');
});

bot.on('text', async (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== ADMIN_ID) return;
  const db = await getDb();
  const cfg = await getEventConfig(db);

  if (cfg.admin_state === 'awaiting_end_date') {
    const val = ctx.message.text.trim();
    await db.collection('event_config').updateOne(
      { _id: 'main_event' },
      { $set: { event_end_date: val }, $unset: { admin_state: "" } }
    );
    return ctx.reply(`✅ Event End Date set to: ${val}`);
  }

  if (cfg.admin_state === 'awaiting_target') {
    const pts = parseInt(ctx.message.text.trim());
    if (isNaN(pts) || pts <= 0) return ctx.reply('❌ Invalid number.');
    await db.collection('event_config').updateOne(
      { _id: 'main_event' },
      { $set: { target_points: pts }, $unset: { admin_state: "" } }
    );
    return ctx.reply(`✅ Target Points set to: ${pts}`);
  }
});

// --- Claim Processing Function (Called via File Bot Fetch) ---

async function handleClaim(reqBody) {
  try {
    const { userId, fileKey } = reqBody;
    if (!userId || !fileKey) return { ok: false, reason: 'missing_params' };

    const db = await getDb();
    const cfg = await getEventConfig(db);

    // End date check
    if (cfg.event_end_date) {
      const endTimestamp = new Date(cfg.event_end_date).getTime();
      if (!isNaN(endTimestamp) && Date.now() > endTimestamp) {
        return { ok: false, reason: 'event_ended' };
      }
    }

    // Check if registered
    const user = await db.collection('event_users').findOne({ _id: Number(userId) });
    if (!user) return { ok: false, reason: 'not_registered' };

    // Anti-cheat: Check if file already claimed
    if (user.claimed_files && user.claimed_files.includes(String(fileKey))) {
      return { ok: false, reason: 'already_claimed' };
    }

    // Atomic increment
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

    // Winner check
    if (updatedUser.points >= cfg.target_points && !updatedUser.vip_claimed) {
      if (cfg.claimed_winners < cfg.max_winners) {
        // Reserve slot
        const confUpdate = await db.collection('event_config').findOneAndUpdate(
          { _id: 'main_event', claimed_winners: { $lt: cfg.max_winners } },
          { $inc: { claimed_winners: 1 } },
          { returnDocument: 'after' }
        );

        if (confUpdate.value || confUpdate) {
          await db.collection('event_users').updateOne(
            { _id: Number(userId) },
            { $set: { vip_claimed: true } }
          );

          // Generate 24h 1-person link
          const expireDate = Math.floor(Date.now() / 1000) + (24 * 60 * 60);
          const invite = await bot.telegram.createChatInviteLink(VIP_CHANNEL_ID, {
            member_limit: 1,
            expire_date: expireDate
          });

          const winMsg = `🏆 <b>Congratulations!</b>\n\nඔබ මුල් ${cfg.max_winners} දෙනා අතරට තේරී පත් විය. මෙන්න ඔබේ පැය 24 VIP Link එක:\n\n🔗 <a href="${invite.invite_link}">👉 Join VIP Channel</a>\n<i>(1 Person / 24 Hours Only)</i>`;
          await bot.telegram.sendMessage(userId, winMsg, { parse_mode: 'HTML' });
        }
      } else {
        await bot.telegram.sendMessage(userId, '⏳ <b>VIP Slots Full!</b>\n\nමුල් 5 දෙනා දැනටමත් VIP Claim කර අවසන්.', { parse_mode: 'HTML' });
      }
    }

    return { ok: true };
  } catch (err) {
    console.error('Claim processing error:', err.message);
    return { ok: false, error: err.message };
  }
}

// --- Vercel Serverless Handler ---

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    // Check if it's internal fetch from File Bot
    if (req.url.includes('/api/claim') || (req.body && req.body.fileKey)) {
      const result = await handleClaim(req.body);
      return res.status(200).json(result);
    }

    // Telegram Bot Webhook
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
