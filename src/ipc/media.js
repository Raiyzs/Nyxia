'use strict';

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');

module.exports = function registerMediaIPC(ipcMain, { loadConfig }) {

  // ElevenLabs TTS — kept for non-streaming use
  ipcMain.handle('tts-speak', (_, text, voiceId) => {
    return new Promise((resolve) => {
      const cfg = loadConfig();
      const apiKey = process.env.ELEVENLABS_API_KEY || cfg?.keys?.elevenlabs || '';
      if (!apiKey || !voiceId) return resolve(null);
      const body = JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true } });
      const req = https.request({
        hostname: 'api.elevenlabs.io', path: `/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey, 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
      });
      req.on('error', () => resolve(null));
      req.write(body); req.end();
    });
  });

  // Whisper STT — local, free, no API key needed
  ipcMain.handle('transcribe-audio', (_, audioBase64) => {
    return new Promise((resolve) => {
      const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxia-'));
      const webmPath  = path.join(tmpDir, 'input.webm');
      const wavPath   = path.join(tmpDir, 'input.wav');
      fs.writeFileSync(webmPath, Buffer.from(audioBase64, 'base64'));

      const whisperBin = '/var/home/kvoldnes/.local/bin/whisper';
      const whisperEnv = { ...process.env, PATH: '/var/home/kvoldnes/.local/bin:/usr/bin:/bin:' + (process.env.PATH || '') };

      function runWhisper(audioFile, outStem) {
        return new Promise((res) => {
          const proc = spawn(whisperBin, [
            audioFile, '--model', 'tiny', '--output_format', 'txt',
            '--output_dir', tmpDir, '--language', 'en', '--fp16', 'False',
            '--condition_on_previous_text', 'False', '--temperature', '0'
          ], { env: whisperEnv });
          let stderr = '';
          proc.stderr.on('data', d => { stderr += d.toString(); });
          const timer = setTimeout(() => { proc.kill(); res({ ok: false, err: 'timeout' }); }, 30000);
          proc.on('close', (code) => {
            clearTimeout(timer);
            const txtPath = path.join(tmpDir, outStem + '.txt');
            if (fs.existsSync(txtPath)) {
              res({ ok: true, text: fs.readFileSync(txtPath, 'utf8').trim() });
            } else {
              res({ ok: false, err: stderr || `exit ${code}` });
            }
          });
          proc.on('error', (e) => { clearTimeout(timer); res({ ok: false, err: e.message }); });
        });
      }

      async function run() {
        await new Promise(res => {
          const ff = spawn('ffmpeg', ['-y', '-i', webmPath, '-ar', '16000', '-ac', '1', wavPath], { env: whisperEnv });
          ff.on('close', res); ff.on('error', res);
        });
        const audioFile = fs.existsSync(wavPath) ? wavPath : webmPath;
        const result = await runWhisper(audioFile, 'input');
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
        resolve(result.ok && result.text ? result.text : null);
      }
      run();
    });
  });

};
