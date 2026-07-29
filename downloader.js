const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const isWindows = process.platform === 'win32';
const YTDLP_BINARY = isWindows ? 'yt-dlp.exe' : 'yt-dlp';
const YTDLP_URL = isWindows
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
const YTDLP_PATH = path.join(__dirname, YTDLP_BINARY);
const TEMP_DIR = path.join(__dirname, 'temp');

// Ensure the temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Runs a command-line executable and returns stdout.
 */
function runExec(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Checks for a cookies.txt file locally or in Render's secret mount folder.
 */
function getCookiesPath() {
  const localCookies = path.join(__dirname, 'cookies.txt');
  const secretCookies = '/etc/secrets/cookies.txt';

  if (fs.existsSync(localCookies)) {
    return localCookies;
  } else if (fs.existsSync(secretCookies)) {
    return secretCookies;
  }
  return null;
}

/**
 * Calculates target audio bitrate to fit within Telegram's 50MB file size limit.
 */
function getTargetBitrate(duration) {
  if (!duration || duration <= 3000) return '128K'; // Up to 50 mins -> 128 kbps (approx 45MB)
  if (duration <= 4000) return '96K';               // Up to 66 mins -> 96 kbps (approx 45MB)
  if (duration <= 6000) return '64K';               // Up to 100 mins -> 64 kbps (approx 45MB)
  return '32K';                                     // Up to 200 mins -> 32 kbps (approx 45MB)
}

/**
 * Ensures yt-dlp binary is present in the project directory.
 * If not, downloads it from GitHub releases.
 */
async function ensureYtdlp() {
  if (fs.existsSync(YTDLP_PATH)) {
    return YTDLP_PATH;
  }
  console.log(`[Downloader] ${YTDLP_BINARY} not found. Downloading from GitHub...`);
  try {
    const response = await fetch(YTDLP_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch yt-dlp from GitHub: ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(YTDLP_PATH, buffer);

    if (!isWindows) {
      // Make it executable on UNIX-like systems
      await fs.promises.chmod(YTDLP_PATH, 0o755);
    }
    console.log(`[Downloader] ${YTDLP_BINARY} downloaded successfully.`);
    return YTDLP_PATH;
  } catch (error) {
    console.error(`[Downloader] Error downloading ${YTDLP_BINARY}:`, error);
    throw error;
  }
}

/**
 * Extracts metadata for a YouTube URL.
 */
async function getVideoInfo(url) {
  await ensureYtdlp();
  console.log(`[Downloader] Fetching metadata for: ${url}`);
  try {
    const args = ['--dump-json', '--no-playlist', '--js-runtimes', 'node'];
    
    const cookiesPath = getCookiesPath();
    if (cookiesPath) {
      args.push('--cookies', cookiesPath);
      console.log(`[Downloader] Using cookies from: ${cookiesPath}`);
    }
    
    args.push(url);
    const output = await runExec(YTDLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 });
    const info = JSON.parse(output);

    return {
      id: info.id,
      title: info.title,
      duration: info.duration || 0, // in seconds
      uploader: info.uploader || 'Unknown Creator',
      thumbnailUrl: info.thumbnail || null,
      estimatedSizeMb: ((info.duration || 0) * 128 * 1000) / (8 * 1024 * 1024) // size at 128 kbps
    };
  } catch (error) {
    console.error('[Downloader] Error fetching metadata:', error);
    throw new Error('Failed to retrieve video metadata. Make sure the link is correct and public.');
  }
}

/**
 * Downloads a YouTube video and converts it to MP3.
 * Runs callback with progress percentage if provided.
 */
async function downloadAudio(url, videoId, onProgress = null, bitrate = '128K') {
  await ensureYtdlp();

  const outputPath = path.join(TEMP_DIR, `${videoId}.%(ext)s`);
  const finalMp3Path = path.join(TEMP_DIR, `${videoId}.mp3`);

  // Clean up any existing file for this ID
  if (fs.existsSync(finalMp3Path)) {
    try {
      fs.unlinkSync(finalMp3Path);
    } catch (e) {
      console.warn(`[Downloader] Could not delete existing file: ${finalMp3Path}`, e);
    }
  }

  const ffmpegDir = path.dirname(ffmpegPath);
  const args = [
    '--ffmpeg-location', ffmpegDir,
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', bitrate, // Dynamic CBR quality to keep files under Telegram's 50MB limit
    '--no-playlist',
    '--js-runtimes', 'node',
    '-o', outputPath
  ];

  const cookiesPath = getCookiesPath();
  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
    console.log(`[Downloader] Using cookies from: ${cookiesPath}`);
  }

  args.push(url);

  console.log(`[Downloader] Downloading and converting: ${url}`);
  return new Promise((resolve, reject) => {
    const process = spawn(YTDLP_PATH, args);
    let errorOutput = '';

    process.stdout.on('data', (data) => {
      const output = data.toString();
      if (onProgress) {
        // Match yt-dlp download progress format, e.g. "[download]  34.5% of..."
        const match = output.match(/\[download\]\s+(\d+\.\d+)%/);
        if (match) {
          const percent = parseFloat(match[1]);
          onProgress(percent);
        }
      }
    });

    process.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    process.on('close', (code) => {
      if (code === 0) {
        if (fs.existsSync(finalMp3Path)) {
          console.log(`[Downloader] Conversion complete: ${finalMp3Path}`);
          resolve(finalMp3Path);
        } else {
          reject(new Error('Conversion finished but MP3 file not found.'));
        }
      } else {
        console.error(`[Downloader] yt-dlp exited with code ${code}. Error: ${errorOutput}`);
        reject(new Error(`Failed to download and convert video. Make sure the video is available.`));
      }
    });
  });
}

/**
 * Downloads a video thumbnail image to local disk.
 */
async function downloadThumbnail(url, videoId) {
  if (!url) return null;
  const thumbPath = path.join(TEMP_DIR, `${videoId}.jpg`);
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(thumbPath, buffer);
    return thumbPath;
  } catch (error) {
    console.error('[Downloader] Failed to download thumbnail:', error);
    return null;
  }
}

/**
 * Cleans up temporary files.
 */
async function cleanupFiles(filePaths) {
  for (const filePath of filePaths) {
    if (filePath && fs.existsSync(filePath)) {
      try {
        await fs.promises.unlink(filePath);
        console.log(`[Downloader] Cleaned up file: ${filePath}`);
      } catch (error) {
        console.error(`[Downloader] Failed to delete file: ${filePath}`, error);
      }
    }
  }
}

module.exports = {
  getVideoInfo,
  downloadAudio,
  downloadThumbnail,
  cleanupFiles,
  ensureYtdlp,
  getTargetBitrate
};
