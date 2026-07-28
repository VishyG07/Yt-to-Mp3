# YouTube to MP3 Telegram Bot 🎵

A lightweight, modern Telegram bot written in Node.js that converts YouTube videos (including shorts and normal links) to high-quality MP3 audio tracks. The tracks are fully tagged with their title, creator/uploader (as artist), duration, and thumbnail image as cover art.

## Features
- **Modern Tech Stack**: Powered by `grammY`, the ultra-fast and type-safe Telegram framework.
- **Zero Global Dependencies**:
  - Automatically fetches the latest standalone `yt-dlp` executable on startup.
  - Bundles the FFmpeg binary using `ffmpeg-static` (no system-wide FFmpeg installation required).
- **Rich Audio Tracks**: Attaches the YouTube video's title, uploader (as performer), duration, and high-quality thumbnail (as album cover art) to the MP3.
- **Smart Size Checks**: Automatically estimates the audio file size and alerts the user if the video exceeds Telegram's standard 50 MB bot upload limit before starting the download.
- **Dynamic Progress Updates**: Displays real-time download and conversion progress directly in the Telegram chat message.

---

## Setup Instructions

### 1. Prerequisites
Ensure you have **Node.js (v18 or higher)** installed on your machine. You can verify this by running:
```bash
node -v
```

### 2. Configure the Bot Token
1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Start a chat with BotFather and send the command `/newbot`.
3. Follow the prompts to name your bot and choose a username.
4. Copy the **HTTP API Token** provided by BotFather.
5. In your project directory, copy the `.env.example` file and rename it to `.env`:
   ```bash
   copy .env.example .env
   ```
6. Open the newly created `.env` file and replace `YOUR_TELEGRAM_BOT_TOKEN_HERE` with your actual token:
   ```env
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
   ```

### 3. Install Dependencies
Run the following command in the project directory to install all required libraries:
```bash
npm install
```
*(This will install `grammy`, `dotenv`, `ffmpeg-static`, and `sanitize-filename`.)*

### 4. Start the Bot
Run the bot using the development command:
```bash
npm run dev
```
On the first startup, the bot will automatically download the correct `yt-dlp` executable for your operating system. Once you see the following message, your bot is ready:
```text
[Bot] Initializing YouTube to MP3 Telegram Bot...
[Bot] Bot is running and polling for updates! Press Ctrl+C to stop.
```

---

## Usage Guide
1. Open Telegram and search for your bot username, then click **Start** (or send `/start`).
2. Paste any YouTube video or shorts link in the chat.
3. The bot will:
   - Analyze the video.
   - Show progress updates while downloading and converting.
   - Send the final MP3 track with cover art.
4. Enjoy your offline audio!
