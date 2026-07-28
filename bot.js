require('dotenv').config();
const { Bot, InputFile } = require('grammy');
const fs = require('fs');
const path = require('path');
const { getVideoInfo, downloadAudio, downloadThumbnail, cleanupFiles, ensureYtdlp } = require('./downloader');

// Verify token exists
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('\n======================================================');
  console.error('ERROR: TELEGRAM_BOT_TOKEN is missing or not set in .env');
  console.error('Please copy .env.example to .env and fill in your token.');
  console.error('======================================================\n');
  process.exit(1);
}

// Initialize GrammY Bot
const bot = new Bot(token);

// YouTube URL Regex
const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;

// Command: /start
bot.command('start', async (ctx) => {
  const username = ctx.from?.first_name || 'there';
  await ctx.reply(
    `👋 Hello, *${username}*\!\n\n` +
    `Welcome to the *YouTube to MP3 Downloader Bot* 🎵\n\n` +
    `Simply send me any YouTube link (video, shorts, etc.), and I will extract the audio and send it to you as an MP3 file.\n\n` +
    `⚡ _Fast and high quality!_`,
    { parse_mode: 'MarkdownV2' }
  );
});

// Command: /help
bot.command('help', async (ctx) => {
  await ctx.reply(
    `ℹ️ *How to use this bot:*\n\n` +
    `1. Copy a YouTube link (e.g., \`https://www.youtube.com/watch?v=...\` or \`https://youtu.be/...\`).\n` +
    `2. Paste it here in the chat.\n` +
    `3. Wait for the bot to process, download, convert, and send your MP3 track.\n\n` +
    `⚠️ *Note:* Standard Telegram bots have a limit of **50 MB** per uploaded file. Videos longer than ~50 minutes might not be deliverable due to this restriction.`,
    { parse_mode: 'Markdown' }
  );
});

// Handler for all text messages
bot.on('message:text', async (ctx) => {
  const messageText = ctx.message.text.trim();
  const match = messageText.match(YOUTUBE_REGEX);

  if (!match) {
    // If not a youtube link, ignore or send a polite prompt
    return ctx.reply('⚠️ Please send a valid YouTube link (e.g., https://www.youtube.com/watch?v=... or https://youtu.be/...).');
  }

  const youtubeUrl = match[0];
  const videoId = match[1];

  let statusMessage;
  let mp3Path = null;
  let thumbPath = null;

  try {
    // 1. Analyze link
    statusMessage = await ctx.reply('🔍 *Analyzing video link...*', { parse_mode: 'Markdown' });

    // Fetch video info
    const info = await getVideoInfo(youtubeUrl);

    // 2. Validate file size and duration
    // Telegram Bot API upload limit is 50MB (52,428,800 bytes)
    const MAX_UPLOAD_SIZE_MB = 49.5;
    if (info.estimatedSizeMb > MAX_UPLOAD_SIZE_MB) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        `❌ *Video is too long!*\n\n` +
        `• Title: _${info.title}_\n` +
        `• Duration: _${Math.floor(info.duration / 60)} minutes_\n\n` +
        `Telegram bots can only upload files up to *50 MB*. At standard quality, this video's audio is estimated to be *${info.estimatedSizeMb.toFixed(1)} MB*, which exceeds the limit.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 3. Start download and conversion
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      `⏳ *Downloading audio...*\n\n` +
      `• Title: _${info.title}_\n` +
      `• Channel: _${info.uploader}_\n` +
      `• Progress: 0%`,
      { parse_mode: 'Markdown' }
    );

    // Throttle progress updates to avoid hitting Telegram Rate Limits
    let lastUpdateTime = Date.now();
    let lastPercent = 0;

    const onProgress = async (percent) => {
      const now = Date.now();
      // Update at most once every 3.5 seconds, and only if progress advanced by >= 8%
      if (now - lastUpdateTime > 3500 && percent - lastPercent >= 8) {
        lastUpdateTime = now;
        lastPercent = percent;
        try {
          await ctx.api.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            `⏳ *Downloading and converting...*\n\n` +
            `• Title: _${info.title}_\n` +
            `• Channel: _${info.uploader}_\n` +
            `• Progress: ${percent.toFixed(0)}%`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {
          // Ignore edits that fail due to identical content or fast rate
        }
      }
    };

    // Download audio and convert to MP3
    mp3Path = await downloadAudio(youtubeUrl, videoId, onProgress);

    // 4. Download thumbnail for album art
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      `🎵 *Preparing audio track...*`,
      { parse_mode: 'Markdown' }
    );
    thumbPath = await downloadThumbnail(info.thumbnailUrl, videoId);

    // 5. Send the audio file
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      `📤 *Sending MP3 to Telegram...*`,
      { parse_mode: 'Markdown' }
    );

    const audioOptions = {
      title: info.title,
      performer: info.uploader,
      duration: Math.round(info.duration),
    };

    // If thumbnail was successfully downloaded, attach it
    if (thumbPath && fs.existsSync(thumbPath)) {
      audioOptions.thumbnail = new InputFile(thumbPath);
    }

    await ctx.replyWithAudio(new InputFile(mp3Path), audioOptions);

    // 6. Delete status message and clean up
    await ctx.api.deleteMessage(ctx.chat.id, statusMessage.message_id);
    console.log(`[Bot] Successfully sent MP3 for ${videoId}`);

  } catch (error) {
    console.error('[Bot] Error processing request:', error);
    
    const errorMessage = error.message || 'Unknown error occurred.';
    if (statusMessage) {
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          `❌ *Failed to convert video:*\n_${errorMessage}_`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        await ctx.reply(`❌ *Failed to convert video:*\n_${errorMessage}_`, { parse_mode: 'Markdown' });
      }
    } else {
      await ctx.reply(`❌ *Failed to convert video:*\n_${errorMessage}_`, { parse_mode: 'Markdown' });
    }
  } finally {
    // Ensure cleanup of local files in all cases
    await cleanupFiles([mp3Path, thumbPath]);
  }
});

// Start the bot and ensure yt-dlp is ready
(async () => {
  console.log('[Bot] Initializing YouTube to MP3 Telegram Bot...');
  try {
    // Trigger download of yt-dlp on startup if missing
    await ensureYtdlp();
    
    // Start bot polling
    bot.start();
    console.log('[Bot] Bot is running and polling for updates! Press Ctrl+C to stop.');
  } catch (error) {
    console.error('[Bot] Failed to start bot:', error);
    process.exit(1);
  }
})();
