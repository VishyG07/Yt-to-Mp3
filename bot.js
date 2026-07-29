require('dotenv').config();
const { Bot, InputFile, InlineKeyboard } = require('grammy');
const fs = require('fs');
const path = require('path');
const { getVideoInfo, downloadAudio, downloadThumbnail, cleanupFiles, ensureYtdlp, getTargetBitrate, getPlaylistInfo } = require('./downloader');

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

// Keep track of active downloading sessions
const activeSessions = new Map();

// Command: /stop
bot.command('stop', async (ctx) => {
  const chatId = ctx.chat.id;
  if (activeSessions.get(chatId)) {
    activeSessions.set(chatId, false);
    await ctx.reply('🛑 *Stopping playlist download...* The current track will finish, and the process will stop.', { parse_mode: 'Markdown' });
  } else {
    await ctx.reply('⚠️ No active download process to stop.', { parse_mode: 'Markdown' });
  }
});

// YouTube URL Regex (matches any valid youtube.com or youtu.be link)
const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/\S+/i;

// Command: /start
bot.command('start', async (ctx) => {
  const name = ctx.from?.first_name || 'there';
  await ctx.reply(
    `👋 *Welcome, ${name}!*\n\n` +
    `I am your personal *YouTube to MP3 Downloader* 🎵\n\n` +
    `⚡ *Features:*\n` +
    `• *High Quality:* Default 128 kbps audio encoding.\n` +
    `• *Smart Compression:* Fits long videos (up to 3.3 hours!) under Telegram's 50MB limit.\n` +
    `• *Metadata & Cover Art:* Automatically attaches the video title, creator, and thumbnail.\n\n` +
    `🚀 *How to use:*\n` +
    `1. Copy any YouTube video, Shorts, or Playlist link.\n` +
    `2. Paste the link here in this chat.\n\n` +
    `*Send me a link to get started!* 📥`,
    { parse_mode: 'Markdown' }
  );
});

// Command: /help
bot.command('help', async (ctx) => {
  await ctx.reply(
    `ℹ️ *How to use this bot:*\n\n` +
    `1. Copy a YouTube link (e.g., \`https://www.youtube.com/watch?v=...\` or \`https://youtu.be/...\` or a playlist link).\n` +
    `2. Paste it here in the chat.\n` +
    `3. If the link belongs to a playlist, select whether to download only the video or the entire playlist.\n` +
    `4. Wait for the bot to process, download, convert, and send your MP3 tracks.\n\n` +
    `⚠️ *Note:* Standard Telegram bots have a limit of **50 MB** per uploaded file. Long videos are dynamically compressed to fit within this restriction. Playlists are capped at **25 tracks** at a time.`,
    { parse_mode: 'Markdown' }
  );
});

// Handler for callback queries (Inline Keyboard choices)
bot.callbackQuery(/^single:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const videoId = ctx.match[1];
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    await ctx.deleteMessage();
  } catch (e) {}
  await processSingleVideo(ctx, url, videoId);
});

bot.callbackQuery(/^playlist:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const playlistId = ctx.match[1];
  try {
    await ctx.deleteMessage();
  } catch (e) {}
  await processPlaylist(ctx, playlistId);
});

// Handler for all text messages
bot.on('message:text', async (ctx) => {
  const messageText = ctx.message.text.trim();
  const match = messageText.match(YOUTUBE_REGEX);

  if (!match) {
    return ctx.reply('⚠️ Please send a valid YouTube link (e.g., https://www.youtube.com/watch?v=... or https://youtu.be/...).');
  }

  const youtubeUrl = match[0];
  let videoId = null;
  let playlistId = null;
  let isPlaylistOnly = false;

  try {
    let urlToParse = youtubeUrl;
    if (!/^https?:\/\//i.test(urlToParse)) {
      urlToParse = 'https://' + urlToParse;
    }
    const parsedUrl = new URL(urlToParse);
    
    playlistId = parsedUrl.searchParams.get('list');
    
    if (parsedUrl.pathname.includes('/playlist')) {
      isPlaylistOnly = true;
    } else if (parsedUrl.pathname.includes('/shorts/')) {
      const parts = parsedUrl.pathname.split('/');
      videoId = parts[parts.indexOf('shorts') + 1];
    } else if (parsedUrl.hostname === 'youtu.be') {
      videoId = parsedUrl.pathname.substring(1);
    } else {
      videoId = parsedUrl.searchParams.get('v');
    }

    if (videoId) videoId = videoId.split(/[?#&]/)[0];
    if (playlistId) playlistId = playlistId.split(/[?#&]/)[0];
  } catch (e) {
    console.error('[Bot] URL parsing failed', e);
  }

  if (!videoId && !playlistId) {
    return ctx.reply('⚠️ Please send a valid YouTube video or playlist link.');
  }

  // If it's a direct playlist link, process playlist immediately
  if (isPlaylistOnly || (playlistId && !videoId)) {
    return processPlaylist(ctx, playlistId);
  }

  // If it has both a video ID and playlist ID, ask the user
  if (videoId && playlistId) {
    const keyboard = new InlineKeyboard()
      .text('🎵 Single Video', `single:${videoId}`)
      .text('📋 Entire Playlist', `playlist:${playlistId}`);

    return ctx.reply(
      `📋 *This video belongs to a playlist.*\n\nWould you like to download only this single video or the entire playlist?`,
      { reply_markup: keyboard, parse_mode: 'Markdown' }
    );
  }

  // Standard single video download
  if (videoId) {
    return processSingleVideo(ctx, youtubeUrl, videoId);
  }
});

/**
 * Core function to download and send a single YouTube video.
 */
async function processSingleVideo(ctx, youtubeUrl, videoId) {
  let statusMessage;
  let mp3Path = null;
  let thumbPath = null;

  try {
    statusMessage = await ctx.reply('🔍 *Analyzing video link...*', { parse_mode: 'Markdown' });

    // Fetch video info
    const info = await getVideoInfo(youtubeUrl);

    // Calculate dynamic audio bitrate to fit inside Telegram's 50MB limit
    const bitrate = getTargetBitrate(info.duration);

    // If duration is too long (over 3.3 hours / 12000 seconds), reject
    const MAX_DURATION_SECONDS = 12000;
    if (info.duration > MAX_DURATION_SECONDS) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        `❌ *Video is too long!*\n\n` +
        `• Title: _${info.title}_\n` +
        `• Duration: _${Math.floor(info.duration / 60)} minutes_\n\n` +
        `Telegram bots can only upload files up to *50 MB*. This video exceeds the maximum supported length of 3.3 hours.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    let downloadNotice = '';
    if (bitrate !== '128K') {
      downloadNotice = `\n\n⚠️ _Note: This video is long (${Math.floor(info.duration / 60)} min). Audio will be optimized at ${bitrate.replace('K', ' kbps')} to fit inside Telegram's 50MB limit._`;
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      `⏳ *Downloading and converting...*${downloadNotice}\n\n` +
      `• Title: _${info.title}_\n` +
      `• Channel: _${info.uploader}_\n` +
      `• Progress: 0%`,
      { parse_mode: 'Markdown' }
    );

    let lastUpdateTime = Date.now();
    let lastPercent = 0;

    const onProgress = async (percent) => {
      const now = Date.now();
      if (now - lastUpdateTime > 3500 && percent - lastPercent >= 8) {
        lastUpdateTime = now;
        lastPercent = percent;
        try {
          await ctx.api.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            `⏳ *Downloading and converting...*${downloadNotice}\n\n` +
            `• Title: _${info.title}_\n` +
            `• Channel: _${info.uploader}_\n` +
            `• Progress: ${percent.toFixed(0)}%`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}
      }
    };

    // Download audio and convert to MP3
    mp3Path = await downloadAudio(youtubeUrl, videoId, onProgress, bitrate);

    // Download thumbnail for album art
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      `🎵 *Preparing audio track...*`,
      { parse_mode: 'Markdown' }
    );
    thumbPath = await downloadThumbnail(info.thumbnailUrl, videoId);

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

    if (thumbPath && fs.existsSync(thumbPath)) {
      audioOptions.thumbnail = new InputFile(thumbPath);
    }

    await ctx.replyWithAudio(new InputFile(mp3Path), audioOptions);
    await ctx.api.deleteMessage(ctx.chat.id, statusMessage.message_id);
    console.log(`[Bot] Successfully sent MP3 for ${videoId}`);

  } catch (error) {
    console.error('[Bot] Error processing single video:', error);
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
    await cleanupFiles([mp3Path, thumbPath]);
  }
}

/**
 * Core function to download and send an entire playlist.
 */
async function processPlaylist(ctx, playlistId) {
  const chatId = ctx.chat.id;
  let statusMessage;
  try {
    activeSessions.set(chatId, true);
    statusMessage = await ctx.reply('🔍 *Fetching playlist details...*', { parse_mode: 'Markdown' });
    const playlistUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
    const playlist = await getPlaylistInfo(playlistUrl);

    const MAX_PLAYLIST_TRACKS = 25;
    const tracksToProcess = playlist.entries.slice(0, MAX_PLAYLIST_TRACKS);
    const totalTracks = playlist.entries.length;

    let limitNotice = '';
    if (totalTracks > MAX_PLAYLIST_TRACKS) {
      limitNotice = `\n\n⚠️ _Note: Playlists are capped at ${MAX_PLAYLIST_TRACKS} tracks per request to keep downloads fast and stable._`;
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      `📋 *Playlist Found:*\n` +
      `• Title: _${playlist.title}_\n` +
      `• Total Tracks: _${totalTracks}_${limitNotice}\n\n` +
      `⏳ Starting downloads...`,
      { parse_mode: 'Markdown' }
    );

    // Loop through tracks sequentially
    for (let i = 0; i < tracksToProcess.length; i++) {
      // Check if user requested to stop the process
      if (!activeSessions.get(chatId)) {
        try {
          await ctx.api.deleteMessage(chatId, statusMessage.message_id);
        } catch (e) {}
        await ctx.reply('🛑 *Playlist download stopped.*', { parse_mode: 'Markdown' });
        return;
      }

      const entry = tracksToProcess[i];
      const trackIndex = i + 1;

      console.log(`[Bot] Playlist track ${trackIndex}/${tracksToProcess.length}: ${entry.title}`);

      // Calculate dynamic bitrate based on track duration
      const bitrate = getTargetBitrate(entry.duration);

      // Skip track if it exceeds 3.3 hours
      if (entry.duration > 12000) {
        await ctx.reply(`❌ *Track ${trackIndex} skipped:* _"${entry.title}"_ is too long (over 3.3 hours).`, { parse_mode: 'Markdown' });
        continue;
      }

      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        `📥 *Downloading Track ${trackIndex} of ${tracksToProcess.length}:*\n` +
        `• Title: _${entry.title}_\n` +
        `• Channel: _${entry.uploader}_\n` +
        `• Quality: _${bitrate.replace('K', ' kbps')}_\n` +
        `• Progress: 0%`,
        { parse_mode: 'Markdown' }
      );

      let lastUpdateTime = Date.now();
      let lastPercent = 0;

      const onProgress = async (percent) => {
        const now = Date.now();
        if (now - lastUpdateTime > 3500 && percent - lastPercent >= 10) {
          lastUpdateTime = now;
          lastPercent = percent;
          try {
            await ctx.api.editMessageText(
              ctx.chat.id,
              statusMessage.message_id,
              `📥 *Downloading Track ${trackIndex} of ${tracksToProcess.length}:*\n` +
              `• Title: _${entry.title}_\n` +
              `• Channel: _${entry.uploader}_\n` +
              `• Quality: _${bitrate.replace('K', ' kbps')}_\n` +
              `• Progress: ${percent.toFixed(0)}%`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {}
        }
      };

      let mp3Path = null;
      let thumbPath = null;

      try {
        // Download audio
        mp3Path = await downloadAudio(entry.url, entry.id, onProgress, bitrate);

        // Prepare metadata options
        const audioOptions = {
          title: entry.title,
          performer: entry.uploader,
          duration: Math.round(entry.duration),
        };

        // Download thumbnail
        const thumbnailUrl = `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;
        thumbPath = await downloadThumbnail(thumbnailUrl, entry.id);
        if (thumbPath && fs.existsSync(thumbPath)) {
          audioOptions.thumbnail = new InputFile(thumbPath);
        }

        // Send the track
        await ctx.replyWithAudio(new InputFile(mp3Path), audioOptions);

      } catch (err) {
        console.error(`[Bot] Error downloading track ${trackIndex}:`, err);
        await ctx.reply(`❌ *Failed to download track ${trackIndex}:* _"${entry.title}"_\nReason: _${err.message}_`, { parse_mode: 'Markdown' });
      } finally {
        await cleanupFiles([mp3Path, thumbPath]);
      }

      // 12 seconds cooldown to prevent YouTube rate-limiting and Telegram API limits
      await new Promise(resolve => setTimeout(resolve, 12000));
    }

    // Done
    await ctx.api.deleteMessage(ctx.chat.id, statusMessage.message_id);
    await ctx.reply(`✅ *Playlist download complete!* All available tracks from _"${playlist.title}"_ have been sent.`, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('[Bot] Playlist error:', error);
    const errorMessage = error.message || 'Unknown error occurred.';
    if (statusMessage) {
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          `❌ *Playlist download failed:*\n_${errorMessage}_`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        await ctx.reply(`❌ *Playlist download failed:*\n_${errorMessage}_`, { parse_mode: 'Markdown' });
      }
    } else {
      await ctx.reply(`❌ *Playlist download failed:*\n_${errorMessage}_`, { parse_mode: 'Markdown' });
    }
  } finally {
    activeSessions.delete(chatId);
  }
}

// Start the bot and ensure yt-dlp is ready
(async () => {
  console.log('[Bot] Initializing YouTube to MP3 Telegram Bot...');
  try {
    // Trigger download of yt-dlp on startup if missing
    await ensureYtdlp();
    
    // Start bot polling
    bot.start();
    console.log('[Bot] Bot is running and polling for updates! Press Ctrl+C to stop.');

    // Start a simple HTTP server for Render.com port binding and uptime checks
    const http = require('http');
    const PORT = process.env.PORT || 8080;
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('YouTube to MP3 Telegram Bot is active and running!');
    }).listen(PORT, () => {
      console.log(`[Server] Web server listening on port ${PORT}`);
    });

  } catch (error) {
    console.error('[Bot] Failed to start bot:', error);
    process.exit(1);
  }
})();
