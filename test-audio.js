/**
 * Local test for has_audio detection — mirrors the logic in src/index.ts
 *
 * Usage:
 *   node test-audio.js <path-to-video>
 *   node test-audio.js video1.mp4 video2.mp4 video3.mp4
 *
 * Requires ffmpeg to be installed and on PATH.
 * On Windows, run in Git Bash / WSL / PowerShell — all work.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execAsync = promisify(exec);

// Use 'NUL' on Windows, '/dev/null' on Linux/Mac
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

async function detectAudio(filePath) {
  let output = '';
  try {
    const result = await execAsync(
      `ffmpeg -i "${filePath}" -af volumedetect -vn -sn -dn -f null ${nullDevice}`,
      { maxBuffer: 1024 * 1024 * 10 }
    );
    output = result.stdout + result.stderr;
  } catch (error) {
    // ffmpeg always exits non-zero with -f null — this is expected
    output = (error.stdout || '') + (error.stderr || '');
  }

  const match = output.match(/max_volume:\s*([-\d.]+)\s*dB/);
  if (!match) {
    console.log('  [WARN] No volumedetect output found — may not be a video, or ffmpeg not installed');
    console.log('  Raw ffmpeg output (first 800 chars):');
    console.log(' ', output.slice(0, 800).replace(/\n/g, '\n  '));
    return null;
  }

  const maxVolume = parseFloat(match[1]);
  const meanMatch = output.match(/mean_volume:\s*([-\d.]+)\s*dB/);
  const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : null;

  const hasAudio = maxVolume > -80;

  return { maxVolume, meanVolume, hasAudio };
}

async function main() {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    console.error('Usage: node test-audio.js <path-to-video> [path2] [path3] ...');
    process.exit(1);
  }

  console.log(`Testing ${files.length} file(s)...\n`);

  for (const filePath of files) {
    const name = path.basename(filePath);
    console.log(`File: ${name}`);

    const result = await detectAudio(filePath);
    if (result) {
      console.log(`  max_volume : ${result.maxVolume} dB`);
      if (result.meanVolume !== null) {
        console.log(`  mean_volume: ${result.meanVolume} dB`);
      }
      console.log(`  has_audio  : ${result.hasAudio}  (threshold: max_volume > -80 dB)`);
    }
    console.log('');
  }
}

main().catch(console.error);
