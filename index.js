const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const fs = require('fs');
const { translate } = require('@vitalets/google-translate-api');

const bot = new Telegraf(process.env.BOT_TOKEN);

if (!process.env.BOT_PASSWORD) {
  console.error('ERROR: BOT_PASSWORD environment variable is required!');
  process.exit(1);
}

const BOT_PASSWORD = process.env.BOT_PASSWORD;

const authenticatedUsers = new Set();
const userChannels = new Map();
const selectedChannel = new Map();
const userStates = new Map();

const channelData = new Map();

const AUTH_FILE = '.bot_auth.json';
const CHANNELS_FILE = '.user_channels.json';
const CHANNEL_DATA_FILE = '.channel_data.json';

function escapeHtml(text) {
  if (!text) return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getChannelData(channelId) {
  if (!channelData.has(channelId)) {
    channelData.set(channelId, {
      messageIds: [],
      usernameToIdMap: new Map(),
      lastMessageId: null,
      autoMessageConfig: {
        messageText: '',
        urlButtons: [],
        isActive: false,
        interval: '*/1 * * * *',
        deletePrevious: true
      },
      translationEnabled: false,
      autoMessageJob: null
    });
  }
  return channelData.get(channelId);
}

function saveAuthenticatedUsers() {
  try {
    const users = Array.from(authenticatedUsers);
    fs.writeFileSync(AUTH_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error('Error saving authenticated users:', err.message);
  }
}

function loadAuthenticatedUsers() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const data = fs.readFileSync(AUTH_FILE, 'utf8');
      const users = JSON.parse(data);
      users.forEach(userId => authenticatedUsers.add(userId));
    }
  } catch (err) {
    console.error('Error loading authenticated users:', err.message);
  }
}

function saveUserChannels() {
  try {
    const data = {};
    userChannels.forEach((channels, userId) => {
      data[userId] = Array.from(channels);
    });
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving user channels:', err.message);
  }
}

function loadUserChannels() {
  try {
    if (fs.existsSync(CHANNELS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
      Object.entries(data).forEach(([userId, channels]) => {
        userChannels.set(parseInt(userId), new Set(channels));
      });
    }
  } catch (err) {
    console.error('Error loading user channels:', err.message);
  }
}

function saveChannelData() {
  try {
    const data = {};
    channelData.forEach((chData, channelId) => {
      data[channelId] = {
        autoMessageConfig: chData.autoMessageConfig,
        translationEnabled: chData.translationEnabled
      };
    });
    fs.writeFileSync(CHANNEL_DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving channel data:', err.message);
  }
}

function loadChannelData() {
  try {
    if (fs.existsSync(CHANNEL_DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHANNEL_DATA_FILE, 'utf8'));
      Object.entries(data).forEach(([channelId, chData]) => {
        const channelInfo = getChannelData(channelId);
        channelInfo.autoMessageConfig = chData.autoMessageConfig || channelInfo.autoMessageConfig;
        channelInfo.translationEnabled = chData.translationEnabled !== undefined ? chData.translationEnabled : false;
        
        if (channelInfo.autoMessageConfig.isActive && channelInfo.autoMessageConfig.messageText) {
          startAutoMessages(channelId);
        }
      });
    }
  } catch (err) {
    console.error('Error loading channel data:', err.message);
  }
}

function resolveUserIdentifier(identifier, channelId) {
  const trimmed = identifier.trim();
  
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed);
  }
  
  const username = trimmed.startsWith('@') ? trimmed.substring(1).toLowerCase() : trimmed.toLowerCase();
  const chData = getChannelData(channelId);
  
  if (chData.usernameToIdMap.has(username)) {
    return chData.usernameToIdMap.get(username);
  }
  
  throw new Error(`Username @${username} not found. The user must have posted in the channel before they can be targeted by username, or use their numeric user ID instead.`);
}

function getIntervalDisplay(cronPattern) {
  const presets = {
    '*/1 * * * *': 'Every minute',
    '*/5 * * * *': 'Every 5 minutes',
    '*/10 * * * *': 'Every 10 minutes',
    '*/15 * * * *': 'Every 15 minutes',
    '*/30 * * * *': 'Every 30 minutes',
    '0 * * * *': 'Every hour',
    '0 */2 * * *': 'Every 2 hours',
    '0 */6 * * *': 'Every 6 hours',
    '0 */12 * * *': 'Every 12 hours',
    '0 0 * * *': 'Every day'
  };
  
  return presets[cronPattern] || cronPattern;
}

const mainMenu = (userId) => {
  const hasChannel = selectedChannel.has(userId);
  const buttons = [[Markup.button.callback('📺 My Channels', 'menu_channels')]];
  
  if (hasChannel) {
    buttons.push(
      [Markup.button.callback('📨 Message Management', 'menu_messages')],
      [Markup.button.callback('🤖 Auto Messages', 'menu_auto_messages')],
      [Markup.button.callback('🌐 Translation Settings', 'menu_translation')],
      [Markup.button.callback('👥 User Management', 'menu_users')],
      [Markup.button.callback('👑 Admin Management', 'menu_admins')],
      [Markup.button.callback('📊 Channel Info', 'menu_info')]
    );
  }
  
  buttons.push([Markup.button.callback('❓ Help', 'show_help')]);
  
  return Markup.inlineKeyboard(buttons);
};

const messageMenu = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📤 Send Message', 'send_message')],
    [Markup.button.callback('🗑️ Delete Message', 'delete_message')],
    [Markup.button.callback('🗑️ Delete All Messages', 'delete_all_messages')],
    [Markup.button.callback('« Back to Main Menu', 'main_menu')]
  ]);
};

const userMenu = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚫 Ban User', 'ban_user'), Markup.button.callback('✅ Unban User', 'unban_user')],
    [Markup.button.callback('🔇 Mute User', 'mute_user'), Markup.button.callback('🔊 Unmute User', 'unmute_user')],
    [Markup.button.callback('« Back to Main Menu', 'main_menu')]
  ]);
};

const adminMenu = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⭐ Promote to Admin', 'promote_user')],
    [Markup.button.callback('📉 Demote Admin', 'demote_user')],
    [Markup.button.callback('« Back to Main Menu', 'main_menu')]
  ]);
};

const infoMenu = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Channel Stats', 'channel_info')],
    [Markup.button.callback('👥 List Admins', 'list_admins')],
    [Markup.button.callback('« Back to Main Menu', 'main_menu')]
  ]);
};

const autoMessageMenu = (userId) => {
  const channelId = selectedChannel.get(userId);
  if (!channelId) {
    return Markup.inlineKeyboard([[Markup.button.callback('« Back to Main Menu', 'main_menu')]]);
  }
  
  const chData = getChannelData(channelId);
  const statusEmoji = chData.autoMessageConfig.isActive ? '🟢' : '🔴';
  const statusText = chData.autoMessageConfig.isActive ? 'Active' : 'Inactive';
  const actionButton = chData.autoMessageConfig.isActive 
    ? Markup.button.callback('⏹️ Stop Auto-Messages', 'stop_auto_messages')
    : Markup.button.callback('▶️ Start Auto-Messages', 'start_auto_messages');
  
  const deleteToggleEmoji = chData.autoMessageConfig.deletePrevious ? '✅' : '❌';
  const deleteToggleText = chData.autoMessageConfig.deletePrevious ? 'ON' : 'OFF';
  
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Set Message Text', 'set_auto_message_text')],
    [Markup.button.callback('⏱️ Set Timer/Interval', 'set_auto_message_interval')],
    [Markup.button.callback('🔗 Add URL Button', 'add_url_button')],
    [Markup.button.callback('📋 Clear URL Buttons', 'clear_url_buttons')],
    [Markup.button.callback(`${deleteToggleEmoji} Delete Previous: ${deleteToggleText}`, 'toggle_delete_previous')],
    [Markup.button.callback('👁️ Preview Message', 'preview_auto_message')],
    [actionButton],
    [Markup.button.callback('« Back to Main Menu', 'main_menu')]
  ]);
};

function startAutoMessages(channelId) {
  const chData = getChannelData(channelId);
  
  if (chData.autoMessageJob) {
    chData.autoMessageJob.stop();
  }
  
  chData.autoMessageJob = cron.schedule(chData.autoMessageConfig.interval, async () => {
    try {
      if (!chData.autoMessageConfig.messageText) {
        console.log(`No message text configured for auto-messages in channel ${channelId}`);
        return;
      }
      
      if (chData.autoMessageConfig.deletePrevious && chData.lastMessageId) {
        try {
          await bot.telegram.deleteMessage(channelId, chData.lastMessageId);
        } catch (err) {
          console.log('Could not delete previous auto-message:', err.message);
        }
      }
      
      const options = {
        parse_mode: 'HTML'
      };
      
      if (chData.autoMessageConfig.urlButtons.length > 0) {
        options.reply_markup = {
          inline_keyboard: chData.autoMessageConfig.urlButtons.map(btn => [{
            text: btn.text,
            url: btn.url
          }])
        };
      }
      
      const sentMessage = await bot.telegram.sendMessage(channelId, chData.autoMessageConfig.messageText, options);
      chData.lastMessageId = sentMessage.message_id;
    } catch (err) {
      console.error(`Error sending auto-message to channel ${channelId}:`, err);
    }
  });
  
  chData.autoMessageConfig.isActive = true;
  saveChannelData();
}

function stopAutoMessages(channelId) {
  const chData = getChannelData(channelId);
  
  if (chData.autoMessageJob) {
    chData.autoMessageJob.stop();
    chData.autoMessageJob = null;
  }
  chData.autoMessageConfig.isActive = false;
  saveChannelData();
}

bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  
  if (authenticatedUsers.has(userId)) {
    if (!selectedChannel.has(userId) && userChannels.has(userId)) {
      const channels = userChannels.get(userId);
      if (channels.size === 1) {
        const channelId = Array.from(channels)[0];
        selectedChannel.set(userId, channelId);
        console.log(`Auto-selected channel ${channelId} for user ${userId}`);
      }
    }
    
    return ctx.reply('🎉 Welcome back! You are authenticated.\n\nUse the menu below to manage your channels:', mainMenu(userId));
  }
  
  ctx.reply('🔐 Welcome to Multi-Channel Manager Bot!\n\nPlease enter the password to access the bot:');
});

bot.command('menu', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!authenticatedUsers.has(userId)) {
    return ctx.reply('⛔ Access denied! Please use /start and enter the password first.');
  }
  
  userStates.delete(userId);
  userStates.delete(userId + '_button_text');
  ctx.reply('🏠 Main Menu\n\nSelect an option below:', mainMenu(userId));
});

bot.action('main_menu', async (ctx) => {
  const userId = ctx.from.id;
  userStates.delete(userId);
  userStates.delete(userId + '_button_text');
  await ctx.editMessageText('🏠 Main Menu\n\nSelect an option below:', mainMenu(userId));
  await ctx.answerCbQuery();
});

bot.action('menu_channels', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!authenticatedUsers.has(userId)) {
    return ctx.answerCbQuery('⛔ Access denied!');
  }
  
  const channels = userChannels.get(userId) || new Set();
  const currentChannel = selectedChannel.get(userId);
  
  const buttons = [];
  
  for (const channelId of channels) {
    try {
      const chat = await bot.telegram.getChat(channelId);
      const isSelected = channelId === currentChannel;
      const emoji = isSelected ? '✅' : '📺';
      const title = chat.title || channelId;
      
      buttons.push([
        Markup.button.callback(`${emoji} ${title}`, `select_channel_${channelId}`),
        Markup.button.callback('🗑️', `remove_channel_${channelId}`)
      ]);
    } catch (err) {
      console.error(`Error getting channel info for ${channelId}:`, err.message);
    }
  }
  
  buttons.push([Markup.button.callback('➕ Add New Channel', 'add_channel')]);
  buttons.push([Markup.button.callback('« Back to Main Menu', 'main_menu')]);
  
  const text = channels.size > 0 
    ? '📺 <b>My Channels</b>\n\nSelect a channel to manage it, or add a new one:'
    : '📺 <b>My Channels</b>\n\nYou have no channels yet. Add one to get started!';
  
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
});

bot.action('add_channel', async (ctx) => {
  const userId = ctx.from.id;
  userStates.set(userId, 'awaiting_channel_forward');
  await ctx.answerCbQuery();
  await ctx.reply('➕ <b>Add New Channel</b>\n\nPlease forward a message from the channel you want to add, or send the channel ID (e.g., @channelname or -100123456789).', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'menu_channels')]])
  });
});

bot.action(/^select_channel_(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const channelId = ctx.match[1];
  
  if (!authenticatedUsers.has(userId)) {
    return ctx.answerCbQuery('⛔ Access denied!');
  }
  
  const channels = userChannels.get(userId) || new Set();
  if (!channels.has(channelId)) {
    return ctx.answerCbQuery('❌ Channel not found in your list!');
  }
  
  selectedChannel.set(userId, channelId);
  
  try {
    const chat = await bot.telegram.getChat(channelId);
    await ctx.answerCbQuery(`✅ Selected: ${chat.title || channelId}`);
  } catch (err) {
    await ctx.answerCbQuery(`✅ Selected channel ${channelId}`);
  }
  
  await ctx.editMessageText('🏠 Main Menu\n\nSelect an option below:', mainMenu(userId));
});

bot.action(/^remove_channel_(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const channelId = ctx.match[1];
  
  if (!authenticatedUsers.has(userId)) {
    return ctx.answerCbQuery('⛔ Access denied!');
  }
  
  const channels = userChannels.get(userId);
  if (!channels || !channels.has(channelId)) {
    return ctx.answerCbQuery('❌ Channel not found!');
  }
  
  const chData = getChannelData(channelId);
  if (chData.autoMessageJob) {
    chData.autoMessageJob.stop();
    chData.autoMessageJob = null;
  }
  
  channels.delete(channelId);
  if (channels.size === 0) {
    userChannels.delete(userId);
  }
  
  if (selectedChannel.get(userId) === channelId) {
    selectedChannel.delete(userId);
    if (channels.size === 1) {
      selectedChannel.set(userId, Array.from(channels)[0]);
    }
  }
  
  saveUserChannels();
  
  try {
    const chat = await bot.telegram.getChat(channelId);
    await ctx.answerCbQuery(`🗑️ Removed: ${chat.title || channelId}`);
  } catch (err) {
    await ctx.answerCbQuery(`🗑️ Channel removed`);
  }
  
  const remainingChannels = userChannels.get(userId) || new Set();
  const buttons = [];
  
  for (const cId of remainingChannels) {
    try {
      const chat = await bot.telegram.getChat(cId);
      const isSelected = cId === selectedChannel.get(userId);
      const emoji = isSelected ? '✅' : '📺';
      const title = chat.title || cId;
      
      buttons.push([
        Markup.button.callback(`${emoji} ${title}`, `select_channel_${cId}`),
        Markup.button.callback('🗑️', `remove_channel_${cId}`)
      ]);
    } catch (err) {
      console.error(`Error getting channel info for ${cId}:`, err.message);
    }
  }
  
  buttons.push([Markup.button.callback('➕ Add New Channel', 'add_channel')]);
  buttons.push([Markup.button.callback('« Back to Main Menu', 'main_menu')]);
  
  const text = remainingChannels.size > 0 
    ? '📺 <b>My Channels</b>\n\nSelect a channel to manage it, or add a new one:'
    : '📺 <b>My Channels</b>\n\nYou have no channels yet. Add one to get started!';
  
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action('menu_messages', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!authenticatedUsers.has(userId)) {
    return ctx.answerCbQuery('⛔ Access denied!');
  }
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.editMessageText('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.delete(userId);
  await ctx.editMessageText('📨 Message Management\n\nChoose an action:', messageMenu());
  await ctx.answerCbQuery();
});

bot.action('menu_users', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!authenticatedUsers.has(userId)) {
    return ctx.answerCbQuery('⛔ Access denied!');
  }
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.editMessageText('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.delete(userId);
  await ctx.editMessageText('👥 User Management\n\nChoose an action:', userMenu());
  await ctx.answerCbQuery();
});

bot.action('menu_admins', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!authenticatedUsers.has(userId)) {
    return ctx.answerCbQuery('⛔ Access denied!');
  }
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.editMessageText('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.delete(userId);
  await ctx.editMessageText('👑 Admin Management\n\nChoose an action:', adminMenu());
  await ctx.answerCbQuery();
});

bot.action('menu_info', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!authenticatedUsers.has(userId)) {
    return ctx.answerCbQuery('⛔ Access denied!');
  }
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.editMessageText('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.delete(userId);
  await ctx.editMessageText('📊 Channel Information\n\nChoose an option:', infoMenu());
  await ctx.answerCbQuery();
});

bot.action('menu_auto_messages', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!authenticatedUsers.has(userId)) {
    return ctx.answerCbQuery('⛔ Access denied!');
  }
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.editMessageText('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.delete(userId);
  userStates.delete(userId + '_button_text');
  
  const channelId = selectedChannel.get(userId);
  const chData = getChannelData(channelId);
  
  const statusEmoji = chData.autoMessageConfig.isActive ? '🟢' : '🔴';
  const statusText = chData.autoMessageConfig.isActive ? 'Active' : 'Inactive';
  const messagePreview = chData.autoMessageConfig.messageText 
    ? escapeHtml(chData.autoMessageConfig.messageText.substring(0, 50)) + (chData.autoMessageConfig.messageText.length > 50 ? '...' : '')
    : 'Not set';
  const buttonsCount = chData.autoMessageConfig.urlButtons.length;
  
  const intervalDisplay = getIntervalDisplay(chData.autoMessageConfig.interval);
  
  const menuText = `🤖 <b>Auto-Message System</b>

${statusEmoji} Status: <b>${statusText}</b>
📝 Message: ${messagePreview}
⏱️ Interval: ${intervalDisplay}
🔗 URL Buttons: ${buttonsCount}

Configure and control automated channel messages.`;
  
  await ctx.editMessageText(menuText, { parse_mode: 'HTML', ...autoMessageMenu(userId) });
  await ctx.answerCbQuery();
});

bot.action('set_auto_message_text', async (ctx) => {
  const userId = ctx.from.id;
  userStates.set(userId, 'awaiting_auto_message_text');
  await ctx.answerCbQuery();
  await ctx.reply('✏️ Please send the message text you want to use for auto-messages.\n\nYou can use HTML formatting (<b>bold</b>, <i>italic</i>, etc.):', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'menu_auto_messages')]
  ]));
});

bot.action('set_auto_message_interval', async (ctx) => {
  await ctx.answerCbQuery();
  
  const intervalOptions = Markup.inlineKeyboard([
    [Markup.button.callback('⏱️ Every 1 minute', 'interval_*/1 * * * *')],
    [Markup.button.callback('⏱️ Every 5 minutes', 'interval_*/5 * * * *')],
    [Markup.button.callback('⏱️ Every 10 minutes', 'interval_*/10 * * * *')],
    [Markup.button.callback('⏱️ Every 15 minutes', 'interval_*/15 * * * *')],
    [Markup.button.callback('⏱️ Every 30 minutes', 'interval_*/30 * * * *')],
    [Markup.button.callback('⏱️ Every hour', 'interval_0 * * * *')],
    [Markup.button.callback('⏱️ Every 2 hours', 'interval_0 */2 * * *')],
    [Markup.button.callback('⏱️ Every 6 hours', 'interval_0 */6 * * *')],
    [Markup.button.callback('⏱️ Every 12 hours', 'interval_0 */12 * * *')],
    [Markup.button.callback('⏱️ Every day', 'interval_0 0 * * *')],
    [Markup.button.callback('« Back', 'menu_auto_messages')]
  ]);
  
  await ctx.editMessageText('⏱️ <b>Set Auto-Message Interval</b>\n\nChoose how often you want the auto-message to be sent:', { parse_mode: 'HTML', ...intervalOptions });
});

bot.action(/^interval_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const interval = ctx.match[1];
  const channelId = selectedChannel.get(userId);
  
  if (!channelId) {
    return ctx.answerCbQuery('⚠️ No channel selected!');
  }
  
  const chData = getChannelData(channelId);
  const wasActive = chData.autoMessageConfig.isActive;
  
  if (wasActive) {
    stopAutoMessages(channelId);
  }
  
  chData.autoMessageConfig.interval = interval;
  saveChannelData();
  
  if (wasActive && chData.autoMessageConfig.messageText) {
    startAutoMessages(channelId);
  }
  
  const intervalDisplay = getIntervalDisplay(interval);
  await ctx.answerCbQuery(`✅ Interval set to: ${intervalDisplay}`);
  
  const statusEmoji = chData.autoMessageConfig.isActive ? '🟢' : '🔴';
  const statusText = chData.autoMessageConfig.isActive ? 'Active' : 'Inactive';
  const messagePreview = chData.autoMessageConfig.messageText 
    ? escapeHtml(chData.autoMessageConfig.messageText.substring(0, 50)) + (chData.autoMessageConfig.messageText.length > 50 ? '...' : '')
    : 'Not set';
  const buttonsCount = chData.autoMessageConfig.urlButtons.length;
  
  const menuText = `🤖 <b>Auto-Message System</b>

${statusEmoji} Status: <b>${statusText}</b>
📝 Message: ${messagePreview}
⏱️ Interval: ${intervalDisplay}
🔗 URL Buttons: ${buttonsCount}

Configure and control automated channel messages.`;
  
  await ctx.editMessageText(menuText, { parse_mode: 'HTML', ...autoMessageMenu(userId) });
});

bot.action('add_url_button', async (ctx) => {
  const userId = ctx.from.id;
  userStates.set(userId, 'awaiting_url_button_text');
  await ctx.answerCbQuery();
  await ctx.reply('🔗 Step 1/2: Send the button text (what users will see):', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'menu_auto_messages')]
  ]));
});

bot.action('clear_url_buttons', async (ctx) => {
  const userId = ctx.from.id;
  const channelId = selectedChannel.get(userId);
  
  if (!channelId) {
    return ctx.answerCbQuery('⚠️ No channel selected!');
  }
  
  const chData = getChannelData(channelId);
  chData.autoMessageConfig.urlButtons = [];
  saveChannelData();
  await ctx.answerCbQuery('✅ All URL buttons cleared!');
  
  const statusEmoji = chData.autoMessageConfig.isActive ? '🟢' : '🔴';
  const statusText = chData.autoMessageConfig.isActive ? 'Active' : 'Inactive';
  const messagePreview = chData.autoMessageConfig.messageText 
    ? escapeHtml(chData.autoMessageConfig.messageText.substring(0, 50)) + (chData.autoMessageConfig.messageText.length > 50 ? '...' : '')
    : 'Not set';
  const intervalDisplay = getIntervalDisplay(chData.autoMessageConfig.interval);
  
  const menuText = `🤖 <b>Auto-Message System</b>

${statusEmoji} Status: <b>${statusText}</b>
📝 Message: ${messagePreview}
⏱️ Interval: ${intervalDisplay}
🔗 URL Buttons: 0

Configure and control automated channel messages.`;
  
  await ctx.editMessageText(menuText, { parse_mode: 'HTML', ...autoMessageMenu(userId) });
});

bot.action('preview_auto_message', async (ctx) => {
  const userId = ctx.from.id;
  const channelId = selectedChannel.get(userId);
  
  await ctx.answerCbQuery();
  
  if (!channelId) {
    return ctx.reply('⚠️ No channel selected!', Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_auto_messages')]
    ]));
  }
  
  const chData = getChannelData(channelId);
  
  if (!chData.autoMessageConfig.messageText) {
    return ctx.reply('⚠️ No message text configured yet. Please set a message first.', Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_auto_messages')]
    ]));
  }
  
  const options = {
    parse_mode: 'HTML'
  };
  
  if (chData.autoMessageConfig.urlButtons.length > 0) {
    options.reply_markup = {
      inline_keyboard: [
        ...chData.autoMessageConfig.urlButtons.map(btn => [{
          text: btn.text,
          url: btn.url
        }]),
        [{ text: '« Back to Menu', callback_data: 'menu_auto_messages' }]
      ]
    };
  } else {
    options.reply_markup = {
      inline_keyboard: [[{ text: '« Back to Menu', callback_data: 'menu_auto_messages' }]]
    };
  }
  
  await ctx.reply('👁️ <b>Preview of Auto-Message:</b>\n\n' + chData.autoMessageConfig.messageText, options);
});

bot.action('start_auto_messages', async (ctx) => {
  const userId = ctx.from.id;
  const channelId = selectedChannel.get(userId);
  
  await ctx.answerCbQuery();
  
  if (!channelId) {
    return ctx.reply('⚠️ No channel selected!', Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_auto_messages')]
    ]));
  }
  
  const chData = getChannelData(channelId);
  
  if (!chData.autoMessageConfig.messageText) {
    return ctx.reply('⚠️ Cannot start auto-messages: No message text configured.\n\nPlease set a message first.', Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_auto_messages')]
    ]));
  }
  
  startAutoMessages(channelId);
  
  const intervalDisplay = getIntervalDisplay(chData.autoMessageConfig.interval);
  const messagePreview = chData.autoMessageConfig.messageText 
    ? escapeHtml(chData.autoMessageConfig.messageText.substring(0, 50)) + (chData.autoMessageConfig.messageText.length > 50 ? '...' : '')
    : 'Not set';
  
  const menuText = `🤖 <b>Auto-Message System</b>

🟢 Status: <b>Active</b>
📝 Message: ${messagePreview}
⏱️ Interval: ${intervalDisplay}
🔗 URL Buttons: ${chData.autoMessageConfig.urlButtons.length}

Configure and control automated channel messages.`;
  
  await ctx.editMessageText(menuText, { parse_mode: 'HTML', ...autoMessageMenu(userId) });
});

bot.action('stop_auto_messages', async (ctx) => {
  const userId = ctx.from.id;
  const channelId = selectedChannel.get(userId);
  
  await ctx.answerCbQuery();
  
  if (!channelId) {
    return ctx.reply('⚠️ No channel selected!', Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_auto_messages')]
    ]));
  }
  
  stopAutoMessages(channelId);
  
  const chData = getChannelData(channelId);
  const messagePreview = chData.autoMessageConfig.messageText 
    ? escapeHtml(chData.autoMessageConfig.messageText.substring(0, 50)) + (chData.autoMessageConfig.messageText.length > 50 ? '...' : '')
    : 'Not set';
  const intervalDisplay = getIntervalDisplay(chData.autoMessageConfig.interval);
  
  const menuText = `🤖 <b>Auto-Message System</b>

🔴 Status: <b>Inactive</b>
📝 Message: ${messagePreview}
⏱️ Interval: ${intervalDisplay}
🔗 URL Buttons: ${chData.autoMessageConfig.urlButtons.length}

Configure and control automated channel messages.`;
  
  await ctx.editMessageText(menuText, { parse_mode: 'HTML', ...autoMessageMenu(userId) });
});

bot.action('toggle_delete_previous', async (ctx) => {
  const userId = ctx.from.id;
  const channelId = selectedChannel.get(userId);
  
  await ctx.answerCbQuery();
  
  if (!channelId) {
    return ctx.reply('⚠️ No channel selected!', Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_auto_messages')]
    ]));
  }
  
  const chData = getChannelData(channelId);
  chData.autoMessageConfig.deletePrevious = !chData.autoMessageConfig.deletePrevious;
  saveChannelData();
  
  const status = chData.autoMessageConfig.deletePrevious ? 'enabled' : 'disabled';
  await ctx.answerCbQuery(`✅ Delete previous message ${status}!`);
  
  const statusEmoji = chData.autoMessageConfig.isActive ? '🟢' : '🔴';
  const statusText = chData.autoMessageConfig.isActive ? 'Active' : 'Inactive';
  const messagePreview = chData.autoMessageConfig.messageText 
    ? escapeHtml(chData.autoMessageConfig.messageText.substring(0, 50)) + (chData.autoMessageConfig.messageText.length > 50 ? '...' : '')
    : 'Not set';
  const buttonsCount = chData.autoMessageConfig.urlButtons.length;
  const intervalDisplay = getIntervalDisplay(chData.autoMessageConfig.interval);
  
  const menuText = `🤖 <b>Auto-Message System</b>

${statusEmoji} Status: <b>${statusText}</b>
📝 Message: ${messagePreview}
⏱️ Interval: ${intervalDisplay}
🔗 URL Buttons: ${buttonsCount}

Configure and control automated channel messages.`;
  
  await ctx.editMessageText(menuText, { parse_mode: 'HTML', ...autoMessageMenu(userId) });
});

bot.action('menu_translation', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!authenticatedUsers.has(userId)) {
    return ctx.answerCbQuery('⛔ Access denied!');
  }
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.editMessageText('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.delete(userId);
  
  const channelId = selectedChannel.get(userId);
  const chData = getChannelData(channelId);
  
  const statusEmoji = chData.translationEnabled ? '🟢' : '🔴';
  const statusText = chData.translationEnabled ? 'Enabled' : 'Disabled';
  const toggleButton = chData.translationEnabled 
    ? Markup.button.callback('⏹️ Disable Translation', 'toggle_translation')
    : Markup.button.callback('▶️ Enable Translation', 'toggle_translation');
  
  const menuText = `🌐 <b>Translation Settings</b>

${statusEmoji} Status: <b>${statusText}</b>

When enabled, the bot will:
• Monitor all channel posts
• Detect non-English messages
• Delete the original message
• Post an English translation

English messages are left unchanged.`;
  
  await ctx.editMessageText(menuText, { 
    parse_mode: 'HTML', 
    ...Markup.inlineKeyboard([
      [toggleButton],
      [Markup.button.callback('« Back to Main Menu', 'main_menu')]
    ])
  });
  await ctx.answerCbQuery();
});

bot.action('toggle_translation', async (ctx) => {
  const userId = ctx.from.id;
  const channelId = selectedChannel.get(userId);
  
  await ctx.answerCbQuery();
  
  if (!channelId) {
    return ctx.reply('⚠️ No channel selected!', Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_translation')]
    ]));
  }
  
  const chData = getChannelData(channelId);
  chData.translationEnabled = !chData.translationEnabled;
  saveChannelData();
  
  const status = chData.translationEnabled ? 'enabled' : 'disabled';
  await ctx.answerCbQuery(`✅ Translation ${status}!`);
  
  const statusEmoji = chData.translationEnabled ? '🟢' : '🔴';
  const statusText = chData.translationEnabled ? 'Enabled' : 'Disabled';
  const toggleButton = chData.translationEnabled 
    ? Markup.button.callback('⏹️ Disable Translation', 'toggle_translation')
    : Markup.button.callback('▶️ Enable Translation', 'toggle_translation');
  
  const menuText = `🌐 <b>Translation Settings</b>

${statusEmoji} Status: <b>${statusText}</b>

When enabled, the bot will:
• Monitor all channel posts
• Detect non-English messages
• Delete the original message
• Post an English translation

English messages are left unchanged.`;
  
  await ctx.editMessageText(menuText, { 
    parse_mode: 'HTML', 
    ...Markup.inlineKeyboard([
      [toggleButton],
      [Markup.button.callback('« Back to Main Menu', 'main_menu')]
    ])
  });
});

bot.action('show_help', async (ctx) => {
  const userId = ctx.from.id;
  userStates.delete(userId);
  
  const helpText = `
📋 <b>Channel Manager Help</b>

<b>📨 Message Management:</b>
• Send Message - Post a message to the channel
• Delete Message - Remove a specific message
• Delete All - Remove tracked non-pinned messages

<b>🤖 Auto Messages:</b>
• Set Message Text - Configure automated message
• Add URL Button - Attach clickable URL buttons
• Preview - See how your message looks
• Start/Stop - Control automated posting

<b>👥 User Management:</b>
• Ban/Unban - Block or restore user access
• Mute/Unmute - Control messaging permissions

<b>👑 Admin Management:</b>
• Promote - Give full admin permissions
• Demote - Remove admin privileges

<b>📊 Channel Info:</b>
• Channel Stats - View channel details
• List Admins - See all administrators

All actions require authentication and admin permissions in the channel.
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('« Back to Main Menu', 'main_menu')]
  ]);
  
  await ctx.editMessageText(helpText, { parse_mode: 'HTML', ...keyboard });
  await ctx.answerCbQuery();
});

bot.action('send_message', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.reply('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.set(userId, 'awaiting_message');
  await ctx.answerCbQuery();
  await ctx.reply('📝 Please send the message you want to post to the channel:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'main_menu')]
  ]));
});

bot.action('delete_message', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.reply('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.set(userId, 'awaiting_delete_id');
  await ctx.answerCbQuery();
  await ctx.reply('🗑️ Please send the message ID you want to delete:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'main_menu')]
  ]));
});

bot.action('delete_all_messages', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.reply('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  await ctx.answerCbQuery();
  
  const channelId = selectedChannel.get(userId);
  const chData = getChannelData(channelId);
  
  if (chData.messageIds.length === 0) {
    return ctx.reply('⚠️ No channel messages tracked yet.\n\nThe bot tracks messages as they are posted to the channel.', Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Main Menu', 'main_menu')]
    ]));
  }
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Yes, Delete All', 'confirm_delete_all')],
    [Markup.button.callback('❌ Cancel', 'main_menu')]
  ]);
  
  await ctx.reply(`⚠️ <b>Delete All Messages</b>\n\nThis will delete ${chData.messageIds.length} tracked non-pinned messages from the channel.\n\nAre you sure?`, { parse_mode: 'HTML', ...keyboard });
});

bot.action('confirm_delete_all', async (ctx) => {
  const userId = ctx.from.id;
  const channelId = selectedChannel.get(userId);
  
  if (!channelId) {
    await ctx.answerCbQuery('⚠️ No channel selected!');
    return ctx.editMessageText('⚠️ No channel selected!', mainMenu(userId));
  }
  
  await ctx.answerCbQuery();
  await ctx.editMessageText('🔄 Deleting messages... Please wait...');
  
  const chData = getChannelData(channelId);
  
  try {
    let deletedCount = 0;
    let skippedCount = 0;
    const pinnedMessageIds = new Set();
    
    try {
      const chat = await bot.telegram.getChat(channelId);
      if (chat.pinned_message) {
        pinnedMessageIds.add(chat.pinned_message.message_id);
      }
    } catch (err) {
      console.log('Could not fetch pinned messages info');
    }
    
    const messagesToDelete = [...chData.messageIds];
    const deletedIds = [];
    
    for (const msgId of messagesToDelete) {
      if (pinnedMessageIds.has(msgId)) {
        skippedCount++;
        deletedIds.push(msgId);
        continue;
      }
      
      try {
        await bot.telegram.deleteMessage(channelId, msgId);
        deletedCount++;
        deletedIds.push(msgId);
        
        if (deletedCount % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (err) {
        if (err.description && err.description.includes('message can\'t be deleted')) {
          skippedCount++;
          deletedIds.push(msgId);
        }
      }
    }
    
    for (const msgId of deletedIds) {
      const index = chData.messageIds.indexOf(msgId);
      if (index !== -1) {
        chData.messageIds.splice(index, 1);
      }
    }
    
    await ctx.editMessageText(`✅ <b>Deletion Complete!</b>\n\n📊 Deleted: ${deletedCount} messages\n📌 Skipped/Protected: ${skippedCount} messages\n📋 Remaining tracked: ${chData.messageIds.length} messages`, { parse_mode: 'HTML', ...mainMenu(userId) });
  } catch (err) {
    console.error('Error deleting all messages:', err);
    await ctx.editMessageText('❌ Failed to delete messages. Make sure the bot has delete message permissions.', mainMenu(userId));
  }
});

bot.action('ban_user', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.reply('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.set(userId, 'awaiting_ban_id');
  await ctx.answerCbQuery();
  await ctx.reply('🚫 Please send the user ID or username (with @) to ban:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'main_menu')]
  ]));
});

bot.action('unban_user', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.reply('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.set(userId, 'awaiting_unban_id');
  await ctx.answerCbQuery();
  await ctx.reply('✅ Please send the user ID or username (with @) to unban:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'main_menu')]
  ]));
});

bot.action('mute_user', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.reply('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.set(userId, 'awaiting_mute_id');
  await ctx.answerCbQuery();
  await ctx.reply('🔇 Please send the user ID or username (with @) to mute:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'main_menu')]
  ]));
});

bot.action('unmute_user', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.reply('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.set(userId, 'awaiting_unmute_id');
  await ctx.answerCbQuery();
  await ctx.reply('🔊 Please send the user ID or username (with @) to unmute:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'main_menu')]
  ]));
});

bot.action('promote_user', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.reply('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.set(userId, 'awaiting_promote_id');
  await ctx.answerCbQuery();
  await ctx.reply('⭐ Please send the user ID or username (with @) to promote to admin:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'main_menu')]
  ]));
});

bot.action('demote_user', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!selectedChannel.has(userId)) {
    await ctx.answerCbQuery('⚠️ Please select a channel first!');
    return ctx.reply('⚠️ <b>No Channel Selected</b>\n\nPlease select a channel from the channel management menu first.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📺 My Channels', 'menu_channels')], [Markup.button.callback('« Back to Main Menu', 'main_menu')]])
    });
  }
  
  userStates.set(userId, 'awaiting_demote_id');
  await ctx.answerCbQuery();
  await ctx.reply('📉 Please send the user ID or username (with @) to demote:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'main_menu')]
  ]));
});

bot.action('channel_info', async (ctx) => {
  const userId = ctx.from.id;
  const channelId = selectedChannel.get(userId);
  
  await ctx.answerCbQuery();
  
  if (!channelId) {
    return ctx.editMessageText('⚠️ No channel selected!', Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_info')]
    ]));
  }
  
  try {
    const chat = await bot.telegram.getChat(channelId);
    
    const infoText = `
📊 <b>Channel Information</b>

<b>Title:</b> ${chat.title || 'N/A'}
<b>Username:</b> @${chat.username || 'N/A'}
<b>Type:</b> ${chat.type}
<b>ID:</b> ${chat.id}
<b>Description:</b> ${chat.description || 'No description'}
${chat.invite_link ? `<b>Invite Link:</b> ${chat.invite_link}` : ''}
    `;
    
    await ctx.editMessageText(infoText, { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_info')]
    ]) });
  } catch (err) {
    console.error('Error getting channel info:', err);
    await ctx.editMessageText('❌ Failed to get channel information. Make sure the bot is added to the channel.', Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_info')]
    ]));
  }
});

bot.action('list_admins', async (ctx) => {
  const userId = ctx.from.id;
  const channelId = selectedChannel.get(userId);
  
  await ctx.answerCbQuery();
  
  if (!channelId) {
    return ctx.editMessageText('⚠️ No channel selected!', Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_info')]
    ]));
  }
  
  try {
    const admins = await bot.telegram.getChatAdministrators(channelId);
    
    let adminList = '👥 <b>Channel Administrators:</b>\n\n';
    admins.forEach((admin, index) => {
      const name = admin.user.first_name + (admin.user.last_name ? ' ' + admin.user.last_name : '');
      const username = admin.user.username ? `@${admin.user.username}` : 'No username';
      const status = admin.status === 'creator' ? '👑 Creator' : '⭐ Admin';
      adminList += `${index + 1}. ${status}\n   Name: ${name}\n   ${username}\n   ID: ${admin.user.id}\n\n`;
    });
    
    await ctx.editMessageText(adminList, { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_info')]
    ]) });
  } catch (err) {
    console.error('Error getting admins:', err);
    await ctx.editMessageText('❌ Failed to get administrators list.', Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_info')]
    ]));
  }
});

bot.on('channel_post', async (ctx) => {
  const messageId = ctx.channelPost.message_id;
  const channelId = ctx.channelPost.chat.id.toString();
  
  const chData = getChannelData(channelId);
  
  if (!chData.messageIds.includes(messageId)) {
    chData.messageIds.push(messageId);
    if (chData.messageIds.length > 5000) {
      chData.messageIds.shift();
    }
  }
  
  if (ctx.channelPost.sender_chat && ctx.channelPost.sender_chat.username) {
    const username = ctx.channelPost.sender_chat.username.toLowerCase();
    const userId = ctx.channelPost.sender_chat.id;
    chData.usernameToIdMap.set(username, userId);
  }
  
  const text = ctx.channelPost.text || ctx.channelPost.caption;
  const hasPhoto = ctx.channelPost.photo && ctx.channelPost.photo.length > 0;
  const photoFileId = hasPhoto ? ctx.channelPost.photo[ctx.channelPost.photo.length - 1].file_id : null;
  
  if (chData.translationEnabled && text) {
    try {
      const result = await translate(text, { to: 'en' });
      
      const isNonEnglish = (result.from && result.from.language && result.from.language.iso !== 'en') || 
                           (result.text && result.text.toLowerCase().trim() !== text.toLowerCase().trim());
      
      if (isNonEnglish) {
        await ctx.deleteMessage();
        const detectedLang = result.from?.language?.iso || 'unknown';
        
        if (hasPhoto && photoFileId) {
          await bot.telegram.sendPhoto(channelId, photoFileId, { caption: result.text });
        } else {
          await bot.telegram.sendMessage(channelId, result.text);
        }
        return;
      } else {
        console.log(`Message is already in English, not translating`);
      }
    } catch (err) {
      console.error('Error translating message:', err);
    }
  }
  
  if (text && text.length > 90) {
    try {
      await ctx.deleteMessage();
      console.log(`Deleted a channel post over 90 characters in channel ${channelId}`);
    } catch (err) {
      console.error('Error deleting long channel post:', err);
    }
  }
});

bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  
  if (text.startsWith('/')) {
    return next();
  }
  
  if (!authenticatedUsers.has(userId)) {
    if (text === BOT_PASSWORD) {
      authenticatedUsers.add(userId);
      saveAuthenticatedUsers();
      ctx.reply('✅ Password accepted! You now have full access to the multi-channel manager bot.\n\nUse the menu below:', mainMenu(userId));
    } else {
      ctx.reply('❌ Incorrect password. Please try again or use /start to restart.');
    }
    return;
  }
  
  const state = userStates.get(userId);
  if (!state) return;
  
  const channelId = selectedChannel.get(userId);
  
  switch (state) {
    case 'awaiting_channel_forward':
      try {
        let newChannelId;
        
        if (ctx.message.forward_from_chat) {
          newChannelId = ctx.message.forward_from_chat.id.toString();
        } else if (text.startsWith('@')) {
          const chat = await bot.telegram.getChat(text);
          newChannelId = chat.id.toString();
        } else if (text.match(/^-?\d+$/)) {
          newChannelId = text;
        } else {
          return ctx.reply('❌ Invalid channel ID or username. Please forward a message from the channel or send a valid channel ID.', Markup.inlineKeyboard([
            [Markup.button.callback('❌ Cancel', 'menu_channels')]
          ]));
        }
        
        try {
          const chat = await bot.telegram.getChat(newChannelId);
          const botMember = await bot.telegram.getChatMember(newChannelId, bot.botInfo.id);
          
          if (botMember.status !== 'administrator') {
            return ctx.reply(`❌ Bot is not an administrator in ${chat.title || newChannelId}. Please add the bot as an admin first.`, Markup.inlineKeyboard([
              [Markup.button.callback('❌ Cancel', 'menu_channels')]
            ]));
          }
          
          if (!userChannels.has(userId)) {
            userChannels.set(userId, new Set());
          }
          
          userChannels.get(userId).add(newChannelId);
          saveUserChannels();
          
          if (!selectedChannel.has(userId)) {
            selectedChannel.set(userId, newChannelId);
          }
          
          await loadChannelAdmins(newChannelId);
          
          userStates.delete(userId);
          ctx.reply(`✅ Channel added successfully: ${chat.title || newChannelId}`, mainMenu(userId));
        } catch (err) {
          console.error('Error adding channel:', err);
          ctx.reply('❌ Failed to add channel. Make sure the bot is added as an administrator.', Markup.inlineKeyboard([
            [Markup.button.callback('❌ Cancel', 'menu_channels')]
          ]));
        }
      } catch (err) {
        console.error('Error processing channel:', err);
        ctx.reply('❌ Failed to process channel information.', Markup.inlineKeyboard([
          [Markup.button.callback('❌ Cancel', 'menu_channels')]
        ]));
      }
      break;
    
    case 'awaiting_message':
      if (!channelId) {
        return ctx.reply('⚠️ No channel selected!', mainMenu(userId));
      }
      try {
        const sentMessage = await bot.telegram.sendMessage(channelId, text);
        ctx.reply(`✅ Message sent successfully!\nMessage ID: ${sentMessage.message_id}`, mainMenu(userId));
        userStates.delete(userId);
      } catch (err) {
        console.error('Error sending custom message:', err);
        ctx.reply('❌ Failed to send the message.', mainMenu(userId));
        userStates.delete(userId);
      }
      break;
      
    case 'awaiting_delete_id':
      if (!channelId) {
        return ctx.reply('⚠️ No channel selected!', mainMenu(userId));
      }
      try {
        await bot.telegram.deleteMessage(channelId, text);
        ctx.reply('✅ Message deleted successfully!', mainMenu(userId));
        userStates.delete(userId);
      } catch (err) {
        console.error('Error deleting message:', err);
        ctx.reply('❌ Failed to delete the message. Make sure the message ID is correct.', mainMenu(userId));
        userStates.delete(userId);
      }
      break;
      
    case 'awaiting_ban_id':
      if (!channelId) {
        return ctx.reply('⚠️ No channel selected!', mainMenu(userId));
      }
      try {
        const targetUserId = resolveUserIdentifier(text, channelId);
        await bot.telegram.banChatMember(channelId, targetUserId);
        ctx.reply(`✅ User ${text} has been banned from the channel.`, mainMenu(userId));
        userStates.delete(userId);
      } catch (err) {
        console.error('Error banning user:', err);
        ctx.reply(`❌ ${err.message || 'Failed to ban the user. Make sure the user ID is correct or the user has posted in the channel.'}`, mainMenu(userId));
        userStates.delete(userId);
      }
      break;
      
    case 'awaiting_unban_id':
      if (!channelId) {
        return ctx.reply('⚠️ No channel selected!', mainMenu(userId));
      }
      try {
        const targetUserId = resolveUserIdentifier(text, channelId);
        await bot.telegram.unbanChatMember(channelId, targetUserId);
        ctx.reply(`✅ User ${text} has been unbanned from the channel.`, mainMenu(userId));
        userStates.delete(userId);
      } catch (err) {
        console.error('Error unbanning user:', err);
        ctx.reply(`❌ ${err.message || 'Failed to unban the user. Make sure the user ID is correct or the user has posted in the channel.'}`, mainMenu(userId));
        userStates.delete(userId);
      }
      break;
      
    case 'awaiting_mute_id':
      if (!channelId) {
        return ctx.reply('⚠️ No channel selected!', mainMenu(userId));
      }
      try {
        const targetUserId = resolveUserIdentifier(text, channelId);
        await bot.telegram.restrictChatMember(channelId, targetUserId, {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false
        });
        ctx.reply(`✅ User ${text} has been muted.`, mainMenu(userId));
        userStates.delete(userId);
      } catch (err) {
        console.error('Error muting user:', err);
        ctx.reply(`❌ ${err.message || 'Failed to mute the user. Make sure the user ID is correct or the user has posted in the channel.'}`, mainMenu(userId));
        userStates.delete(userId);
      }
      break;
      
    case 'awaiting_unmute_id':
      if (!channelId) {
        return ctx.reply('⚠️ No channel selected!', mainMenu(userId));
      }
      try {
        const targetUserId = resolveUserIdentifier(text, channelId);
        await bot.telegram.restrictChatMember(channelId, targetUserId, {
          can_send_messages: true,
          can_send_media_messages: true,
          can_send_polls: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true
        });
        ctx.reply(`✅ User ${text} has been unmuted.`, mainMenu(userId));
        userStates.delete(userId);
      } catch (err) {
        console.error('Error unmuting user:', err);
        ctx.reply(`❌ ${err.message || 'Failed to unmute the user. Make sure the user ID is correct or the user has posted in the channel.'}`, mainMenu(userId));
        userStates.delete(userId);
      }
      break;
      
    case 'awaiting_promote_id':
      if (!channelId) {
        return ctx.reply('⚠️ No channel selected!', mainMenu(userId));
      }
      try {
        const targetUserId = resolveUserIdentifier(text, channelId);
        await bot.telegram.promoteChatMember(channelId, targetUserId, {
          can_manage_chat: true,
          can_post_messages: true,
          can_edit_messages: true,
          can_delete_messages: true,
          can_manage_video_chats: true,
          can_restrict_members: true,
          can_promote_members: true,
          can_change_info: true,
          can_invite_users: true,
          can_pin_messages: true
        });
        ctx.reply(`✅ User ${text} has been promoted to admin with full permissions.`, mainMenu(userId));
        userStates.delete(userId);
      } catch (err) {
        console.error('Error promoting user:', err);
        ctx.reply(`❌ ${err.message || 'Failed to promote the user. Make sure the user ID is correct or the user has posted in the channel.'}`, mainMenu(userId));
        userStates.delete(userId);
      }
      break;
      
    case 'awaiting_demote_id':
      if (!channelId) {
        return ctx.reply('⚠️ No channel selected!', mainMenu(userId));
      }
      try {
        const targetUserId = resolveUserIdentifier(text, channelId);
        await bot.telegram.promoteChatMember(channelId, targetUserId, {
          can_manage_chat: false,
          can_post_messages: false,
          can_edit_messages: false,
          can_delete_messages: false,
          can_manage_video_chats: false,
          can_restrict_members: false,
          can_promote_members: false,
          can_change_info: false,
          can_invite_users: false,
          can_pin_messages: false
        });
        ctx.reply(`✅ User ${text} has been demoted to regular member.`, mainMenu(userId));
        userStates.delete(userId);
      } catch (err) {
        console.error('Error demoting user:', err);
        ctx.reply(`❌ ${err.message || 'Failed to demote the user. Make sure the user ID is correct or the user has posted in the channel.'}`, mainMenu(userId));
        userStates.delete(userId);
      }
      break;
      
    case 'awaiting_auto_message_text':
      if (!channelId) {
        return ctx.reply('⚠️ No channel selected!', mainMenu(userId));
      }
      const chData = getChannelData(channelId);
      chData.autoMessageConfig.messageText = text;
      saveChannelData();
      ctx.reply('✅ Auto-message text set successfully!\n\nYou can now add URL buttons or start the auto-messages.', Markup.inlineKeyboard([
        [Markup.button.callback('🔗 Add URL Button', 'add_url_button')],
        [Markup.button.callback('👁️ Preview Message', 'preview_auto_message')],
        [Markup.button.callback('« Back to Auto Messages', 'menu_auto_messages')]
      ]));
      userStates.delete(userId);
      break;
      
    case 'awaiting_url_button_text':
      if (!userStates.has(userId + '_button_text')) {
        userStates.set(userId + '_button_text', text);
        userStates.set(userId, 'awaiting_url_button_url');
        ctx.reply(`✏️ Button text saved: "${text}"\n\n🔗 Step 2/2: Now send the URL for this button:`, Markup.inlineKeyboard([
          [Markup.button.callback('❌ Cancel', 'menu_auto_messages')]
        ]));
      }
      break;
      
    case 'awaiting_url_button_url':
      if (!channelId) {
        return ctx.reply('⚠️ No channel selected!', mainMenu(userId));
      }
      const urlButtonText = userStates.get(userId + '_button_text');
      if (urlButtonText) {
        const urlPattern = /^https?:\/\/.+/;
        if (!urlPattern.test(text)) {
          return ctx.reply('❌ Invalid URL! Please send a valid URL starting with http:// or https://', Markup.inlineKeyboard([
            [Markup.button.callback('❌ Cancel', 'menu_auto_messages')]
          ]));
        }
        
        const urlChData = getChannelData(channelId);
        urlChData.autoMessageConfig.urlButtons.push({
          text: urlButtonText,
          url: text
        });
        saveChannelData();
        
        userStates.delete(userId + '_button_text');
        userStates.delete(userId);
        
        ctx.reply(`✅ URL button added successfully!\n\n📝 Text: ${urlButtonText}\n🔗 URL: ${text}\n\nYou now have ${urlChData.autoMessageConfig.urlButtons.length} button(s).`, Markup.inlineKeyboard([
          [Markup.button.callback('🔗 Add Another Button', 'add_url_button')],
          [Markup.button.callback('👁️ Preview Message', 'preview_auto_message')],
          [Markup.button.callback('« Back to Auto Messages', 'menu_auto_messages')]
        ]));
      }
      break;
  }
});

async function loadChannelAdmins(channelId) {
  try {
    const admins = await bot.telegram.getChatAdministrators(channelId);
    const chData = getChannelData(channelId);
    admins.forEach(admin => {
      if (admin.user.username) {
        const username = admin.user.username.toLowerCase();
        chData.usernameToIdMap.set(username, admin.user.id);
      }
    });
  } catch (err) {
    console.error(`Error loading channel admins for ${channelId}:`, err.message);
  }
}

console.log('Bot Is Running...');

loadAuthenticatedUsers();
loadUserChannels();
loadChannelData();

bot.launch().catch((err) => {
  console.error('Failed to launch bot:', err);
  process.exit(1);
});

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  console.log('The BOT Has Stopped');
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  console.log('The Bot Has Stopped');
});