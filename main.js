// ================================================================================
// FRbox Server v3.0 - Jackbox Games Private Server (Ecast + Blobcast)
// by @error_kill
// JPP1-TMP3
// ================================================================================
// ======================= IMPORTS =========================
import express from "express";
import http from "http";
import https from "https";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import * as urlNode from "url";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { spawn } from 'child_process';
import { SocksProxyAgent } from 'socks-proxy-agent';

// ======================= CONFIG ==========================
let CONFIG;
try {
  CONFIG = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
} catch (err) {
  console.error(`❌ Ошибка чтения config.json: ${err.message}`);
  CONFIG = {
    port: 3489,
    host: "jack.fenst4r.live",
    internalToken: "debug-token",
    xrayBin: "./xray-bin/xray",
    xrayLocalPort: 10808,
    xrayServers: []
  };
}

const INTERNAL_TOKEN = CONFIG.internalToken || "debug-token";
const PORT = CONFIG.port || 3489;
const accessibleHost = CONFIG.host || "jack.fenst4r.live";

// ======================= PANEL (регистрация + права) ==========================
// registrationEnabled: false — панель без открытой регистрации
// adminLogins — логины с полными правами (любые комнаты с любого IP)
const PANEL = {
  registrationEnabled: !(CONFIG.panel && CONFIG.panel.registrationEnabled === false),
  adminLogins: new Set(
    (Array.isArray(CONFIG.panel && CONFIG.panel.adminLogins) ? CONFIG.panel.adminLogins : [])
      .map(x => String(x).toLowerCase())
  )
};
log("PANEL", `🔐 registration=${PANEL.registrationEnabled ? "on" : "off"} admins=[${[...PANEL.adminLogins].join(", ") || "—"}]`);
function isPanelAdmin(username) {
  return PANEL.adminLogins.has(String(username || "").toLowerCase());
}

// ======================= TWITCH (требование входа) ===================
const TWITCH = {
  clientId: String((CONFIG.twitch && CONFIG.twitch.clientId) || ""),
  testToken: String((CONFIG.twitch && typeof CONFIG.twitch.testToken === "string") ? CONFIG.twitch.testToken : "LOCAL-TWITCH-TOKEN"),
  enabled: !(CONFIG.twitch && CONFIG.twitch.enabled === false),
  enforce: !(CONFIG.twitch && CONFIG.twitch.enforce === false)
};
// Проверка токена через /oauth2/validate не требует Client-ID/регистрации приложения,
// поэтому любой настоящий токен Twitch (от любого клиента) валиден. clientId нужен только
// для встроенного OAuth-редиректа контроллера (получение токена), не для проверки.
function twitchEnabled() { return TWITCH.enabled; }
function twitchMode() {
  if (!TWITCH.enabled) return "off";
  if (TWITCH.clientId) return "live";
  if (TWITCH.testToken) return "stub";
  return "validate";
}
// Валидация токена от контроллера: сначала тестовый токен (заглушка), затем реальный /oauth2/validate.
async function validateTwitchToken(accessToken) {
  if (!accessToken) return null;
  if (TWITCH.testToken && accessToken === TWITCH.testToken) {
    return { id: "local-test", login: "test", display: "Test Twitch" };
  }
  return await fetchTwitchUser(accessToken);
}
// Проверка токена Twitch без app/Client-ID (dev.twitch.tv/docs/authentication/validate-tokens).
async function fetchTwitchUser(accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${accessToken}` }
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !json.login) return null;
    return {
      id: json.user_id || json.login,
      login: json.login,
      display: json.login,
      clientId: json.client_id || null,
      expiresIn: json.expires_in || null
    };
  } catch (err) {
    log("TWITCH", `⚠️ token validation failed: ${err.message}`);
    return null;
  }
}

// Отклоняем вход в комнату, требующую Twitch: шлём код 2015 и закрываем сокет.
function twitchRejectJoin(socket, roomCode, ip) {
  log("TWITCH", `🚫 ${roomCode}: вход без валидного twitch-token (${ip})`);
  try { socket.send(JSON.stringify({ opcode: "error", result: { code: 2015, msg: "twitch login required" } })); } catch {}
  setTimeout(() => { try { socket.terminate(); } catch {} }, 300);
}

// ======================= MITM MIRROR ===================
const MITM = {
  enabled: !!(CONFIG.mitm && CONFIG.mitm.enabled === true),
  mirrorUrl: String((CONFIG.mitm && CONFIG.mitm.mirrorUrl) || "https://ecast-qa.jackboxgames.com").replace(/\/+$/, "")
};
try { MITM.parsed = new URL(MITM.mirrorUrl); } catch { MITM.parsed = null; }

function mitmActive() { return MITM.enabled && !!MITM.parsed; }

// ======================= TTS ==========================
// Любой mode можно переключить на лету: POST /admin/tts {"mode":"..."}
// Режимы-генераторы (результат всегда success+url, mp3 кладётся в кэш /tts/files/):
//   espeak       — локальный espeak-ng + ffmpeg
//   piper        — локальный Piper (нужны bin + model в tts.piper)
//   yandex       — Yandex SpeechKit (tts.cloud.yandex.*)
//   polly        — Amazon Polly (tts.cloud.polly.*, SigV4)
//   azure        — Azure Cognitive TTS (tts.cloud.azure.*)
//   google       — Google Cloud TTS (tts.cloud.google.*)
//   openai       — OpenAI TTS (tts.cloud.openai.*)
//   elevenlabs   — ElevenLabs (tts.cloud.elevenlabs.*)
// Режимы-транзит (mp3 остаётся на стороне Jackbox):
//   upstream     — ecast.jackboxgames.com, клиент качает S3 сам
//   mirror       — ecast-qa, клиент качает test-S3 сам
//   proxy-mp3    — генерация upstream/mirror, но mp3 качает наш сервер → /tts/files/
const TTS_ENGINES = new Set([
  "upstream", "mirror", "proxy-mp3",
  "espeak", "local", "piper",
  "yandex", "polly", "azure", "google", "openai", "elevenlabs"
]);
const TTS_CLOUD_MODES = new Set(["yandex", "polly", "azure", "google", "openai", "elevenlabs"]);
const TTS_LOCAL_MODES = new Set(["espeak", "local", "piper"]);
const TTS = {
  mode: String((CONFIG.tts && CONFIG.tts.mode) || "upstream").toLowerCase(),
  upstream: String((CONFIG.tts && CONFIG.tts.upstream) || "ecast").toLowerCase(),
  ffmpeg: String((CONFIG.tts && CONFIG.tts.ffmpeg) || "ffmpeg"),
  cacheDir: String((CONFIG.tts && CONFIG.tts.cacheDir) || "./data/tts-cache"),
  baseWpm: parseInt(CONFIG.tts && CONFIG.tts.baseWpm, 10) || 160,
  voices: (CONFIG.tts && CONFIG.tts.voices) || {
    maxim: { lang: "ru", pitch: 30 },
    tatyana: { lang: "ru", pitch: 60 }
  },
  espeak: Object.assign({ bin: "espeak-ng" }, CONFIG.tts && CONFIG.tts.espeak),
  piper: Object.assign({ bin: "", model: "", speaker: 0 }, CONFIG.tts && CONFIG.tts.piper),
  cloud: Object.assign({}, CONFIG.tts && CONFIG.tts.cloud)
};
if (!TTS_ENGINES.has(TTS.mode)) {
  log("TTS", `⚠️ Unknown tts.mode "${TTS.mode}", fallback to "upstream"`);
  TTS.mode = "upstream";
}
try { fs.mkdirSync(TTS.cacheDir, { recursive: true }); } catch {}
log("TTS", `🔊 mode=${TTS.mode} upstream=${TTS.upstream} cache=${TTS.cacheDir} engines=${[...TTS_ENGINES].join("|")}`);

function ttsPublicBase() {
  const proto = (accessibleHost.startsWith("localhost") || /^127\./.test(accessibleHost)) ? "http" : "https";
  return `${proto}://${accessibleHost}`;
}

function ttsStripSsml(text) {
  return String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function ttsRatePct(rate) {
  if (rate === null || rate === undefined || rate === "") return 100;
  if (typeof rate === "number" && isFinite(rate)) return rate;
  const m = String(rate).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 100;
}

function ttsParseRateWpm(rate) {
  const wpm = Math.round(TTS.baseWpm * (ttsRatePct(rate) / 100));
  return Math.max(80, Math.min(450, wpm));
}

function ttsCacheName(engine, voice, rate, text) {
  return crypto.createHash("sha1").update(`${engine}|${voice}|${rate}|${text}`).digest("hex") + ".mp3";
}

function ttsCloudCfg(name) {
  return Object.assign({}, (TTS.cloud && TTS.cloud[name]) || {});
}

function runProc(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 400)}`));
    });
  });
}

// Универсальный HTTP: возвращает { status, headers, buffer }
function ttsHttp(url, { method = "GET", headers = {}, body = null, timeout = 30000, agent = null } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;
    const payload = body == null ? null : (Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body));
    const hdrs = Object.assign({ host: parsed.host }, headers);
    if (payload && !hdrs["content-length"] && !hdrs["Content-Length"]) hdrs["content-length"] = Buffer.byteLength(payload);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method, headers: hdrs,
      rejectUnauthorized: false, servername: parsed.hostname
    };
    if (agent) options.agent = agent;
    const req = mod.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        ttsHttp(new URL(res.headers.location, url).toString(), { method, headers, body: payload, timeout, agent }).then(resolve, reject);
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (c) => { chunks.push(c); size += c.length; if (size > 30 * 1024 * 1024) req.destroy(new Error("too big")); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function ttsHttpJson(url, opts = {}) {
  const res = await ttsHttp(url, opts);
  const raw = res.buffer.toString("utf8");
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 250)}`);
  try { return JSON.parse(raw); } catch { throw new Error(`bad json: ${raw.slice(0, 250)}`); }
}

function ttsStoreMp3(buf, engine, voice, rate, text) {
  if (!buf || !buf.length) throw new Error("empty audio");
  const name = ttsCacheName(engine, voice, rate, text);
  const mp3Path = `${TTS.cacheDir}/${name}`;
  if (!(fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 0)) fs.writeFileSync(mp3Path, buf);
  return `${ttsPublicBase()}/tts/files/${name}`;
}

async function ttsMaybeViaXray(fn) {
  try { return await fn(null); } catch (errDirect) {
    if (xrayManager && xrayManager.isRunning) {
      const agent = await xrayManager.getAgent();
      if (agent) return await fn(agent);
    }
    throw errDirect;
  }
}

// ---- upstream / mirror / proxy-mp3 ----
async function ttsEcastGenerate(body, which) {
  const base = which === "mirror" ? MITM.mirrorUrl : "https://ecast.jackboxgames.com";
  return ttsMaybeViaXray((agent) => ttsHttpJson(`${base}/tts/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "JackboxGames/1.00 libcurl/7.57.0-DEV OpenSSL/1.1.1g zlib/1.2.7 (Win-Steam)"
    },
    body, agent
  }));
}

async function engineUpstream(body) { return ttsEcastGenerate(body, "ecast"); }
async function engineMirror(body) { return ttsEcastGenerate(body, "mirror"); }

async function engineProxyMp3(body) {
  const which = TTS.upstream === "mirror" ? "mirror" : "ecast";
  const gen = await ttsEcastGenerate(body, which);
  if (!gen || !gen.success || !gen.url) throw new Error(`generate failed: ${JSON.stringify(gen).slice(0, 200)}`);
  const name = ttsCacheName(which, body.voice || "", body.rate || "", ttsStripSsml(body.text));
  const mp3Path = `${TTS.cacheDir}/${name}`;
  if (!(fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 0)) {
    const buf = await ttsMaybeViaXray((agent) => ttsHttp(gen.url, { agent }).then(r => {
      if (r.status !== 200) throw new Error(`download ${r.status}`);
      return r.buffer;
    }));
    fs.writeFileSync(mp3Path, buf);
  }
  return { success: true, url: `${ttsPublicBase()}/tts/files/${name}`, sourceUrl: gen.url };
}

// ---- espeak-ng ----
async function engineEspeak(body) {
  const text = ttsStripSsml(body.text);
  if (!text) throw new Error("empty text");
  const key = String(body.voice || "Maxim").toLowerCase();
  const v = TTS.voices[key] || TTS.voices.maxim || { lang: "ru", pitch: 30 };
  const wpm = ttsParseRateWpm(body.rate);
  const bin = TTS.espeak.bin || "espeak-ng";
  const wavPath = `${TTS.cacheDir}/${ttsCacheName("espeak", body.voice, body.rate, text).replace(/\.mp3$/, ".wav")}`;
  const mp3BufPath = wavPath.replace(/\.wav$/, ".mp3");
  await runProc(bin, ["-v", v.lang || "ru", "-p", String(v.pitch || 30), "-s", String(wpm), "-w", wavPath, "--", text]);
  try {
    await runProc(TTS.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", wavPath, "-codec:a", "libmp3lame", "-qscale:a", "4", mp3BufPath]);
  } finally {
    try { fs.unlinkSync(wavPath); } catch {}
  }
  const buf = fs.readFileSync(mp3BufPath);
  return { success: true, url: ttsStoreMp3(buf, "espeak", body.voice, body.rate, text) };
}

// ---- Piper (локальный нейро) ----
async function enginePiper(body) {
  const cfg = TTS.piper;
  if (!cfg.bin || !cfg.model) throw new Error("piper not configured (tts.piper.bin + tts.piper.model)");
  const text = ttsStripSsml(body.text);
  if (!text) throw new Error("empty text");
  const wavPath = `${TTS.cacheDir}/${ttsCacheName("piper", body.voice, body.rate, text).replace(/\.mp3$/, ".wav")}`;
  // length_scale ~ 100/rate% (rate 120% → 0.83 быстрее)
  const lengthScale = (100 / Math.max(10, ttsRatePct(body.rate))).toFixed(3);
  // piper читает текст из stdin
  return await new Promise((resolve, reject) => {
    const p = spawn(cfg.bin, ["--model", cfg.model, "--output_file", wavPath, "--length_scale", lengthScale, "--speaker", String(cfg.speaker || 0)]);
    let err = "";
    p.stderr.on("data", d => { err += d; });
    p.on("error", reject);
    p.on("close", async (code) => {
      if (code !== 0) return reject(new Error(`piper exited ${code}: ${err.slice(0, 300)}`));
      try {
        await runProc(TTS.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", wavPath, "-codec:a", "libmp3lame", "-qscale:a", "4", wavPath.replace(/\.wav$/, ".mp3")]);
        const buf = fs.readFileSync(wavPath.replace(/\.wav$/, ".mp3"));
        resolve({ success: true, url: ttsStoreMp3(buf, "piper", body.voice, body.rate, text) });
      } catch (e) { reject(e); } finally {
        try { fs.unlinkSync(wavPath); } catch {}
      }
    });
    p.stdin.write(text);
    p.stdin.end();
  });
}

// ---- Yandex SpeechKit ----
async function engineYandex(body) {
  const cfg = ttsCloudCfg("yandex");
  if (!cfg.apiKey && !cfg.iamToken) throw new Error("yandex not configured (tts.cloud.yandex.apiKey)");
  const text = ttsStripSsml(body.text);
  const pct = ttsRatePct(body.rate);
  const form = new URLSearchParams({
    text,
    lang: cfg.lang || "ru-RU",
    voice: cfg.voice || (String(body.voice).toLowerCase() === "tatyana" ? "alena" : "zahar"),
    speed: String(cfg.speed || Math.max(0.3, Math.min(2.0, pct / 100))),
    format: "mp3",
    folderId: cfg.folderId || ""
  });
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": "FRbox-TTS/1.0"
  };
  if (cfg.iamToken) headers["Authorization"] = `Bearer ${cfg.iamToken}`;
  else headers["Authorization"] = `Api-Key ${cfg.apiKey}`;
  const res = await ttsMaybeViaXray((agent) => ttsHttp(
    cfg.endpoint || "https://tts.api.cloud.yandex.net/speech/v1/tts/synthesize",
    { method: "POST", headers, body: form.toString(), agent }
  ));
  if (res.status !== 200) throw new Error(`yandex ${res.status}: ${res.buffer.toString("utf8").slice(0, 200)}`);
  return { success: true, url: ttsStoreMp3(res.buffer, "yandex", body.voice, body.rate, text) };
}

// ---- Amazon Polly (SigV4) ----
function pollySign(key, secret, region, service, stringToSign) {
  const kDate = crypto.createHmac("sha256", "AWS4" + secret).update(region).digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(region).digest();
  const kService = crypto.createHmac("sha256", kRegion).update(service).digest();
  const kSigning = crypto.createHmac("sha256", kService).update("aws4_request").digest();
  return crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
}

async function enginePolly(body) {
  const cfg = ttsCloudCfg("polly");
  if (!cfg.accessKeyId || !cfg.secretAccessKey) throw new Error("polly not configured (tts.cloud.polly.accessKeyId)");
  const region = cfg.region || "us-east-1";
  const text = ttsStripSsml(body.text);
  const voiceMap = cfg.voices || { Maxim: "Maxim", Tatyana: "Tatyana" };
  const voiceId = cfg.voice || voiceMap[body.voice] || body.voice || "Maxim";
  const payload = JSON.stringify({
    Text: text,
    OutputFormat: "mp3",
    VoiceId: voiceId,
    Engine: cfg.engine || "standard",
    SampleRate: cfg.sampleRate || "22050",
    TextType: "text",
    Rate: String(Math.max(20, Math.min(500, ttsRatePct(body.rate)))) + "%"
  });
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");
  const host = cfg.endpoint || `polly.${region}.amazonaws.com`;
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/polly/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const sig = pollySign(cfg.accessKeyId, cfg.secretAccessKey, region, "polly", stringToSign);
  const res = await ttsMaybeViaXray((agent) => ttsHttp(`https://${host}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-amz-date": amzDate,
      "authorization": `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`
    },
    body: payload, agent
  }));
  if (res.status !== 200) throw new Error(`polly ${res.status}: ${res.buffer.toString("utf8").slice(0, 200)}`);
  return { success: true, url: ttsStoreMp3(res.buffer, "polly", body.voice, body.rate, text) };
}

// ---- Azure Cognitive TTS ----
async function engineAzure(body) {
  const cfg = ttsCloudCfg("azure");
  if (!cfg.key) throw new Error("azure not configured (tts.cloud.azure.key)");
  const text = ttsStripSsml(body.text);
  const region = cfg.region || "russiacentral";
  const voice = cfg.voice || (String(body.voice).toLowerCase() === "tatyana" ? "ru-RU-SvetlanaNeural" : "ru-RU-DmitryNeural");
  const pct = ttsRatePct(body.rate);
  const rateAttr = pct === 100 ? "" : ` rate="${pct > 100 ? "+" : ""}${Math.round(pct - 100)}%"`;
  const ssml = `<speak version='1.0' xml:lang='ru-RU'><voice name='${voice}'><prosody${rateAttr}>${text.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</prosody></voice></speak>`;
  const res = await ttsMaybeViaXray((agent) => ttsHttp(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "content-type": "application/ssml+xml",
        "x-microsoft-outputformat": cfg.format || "audio-24khz-96kbitrate-mono-mp3",
        "user-agent": "FRbox-TTS/1.0",
        "Ocp-Apim-Subscription-Key": cfg.key
      },
      body: ssml, agent
    }
  ));
  if (res.status !== 200) throw new Error(`azure ${res.status}: ${res.buffer.toString("utf8").slice(0, 200)}`);
  return { success: true, url: ttsStoreMp3(res.buffer, "azure", body.voice, body.rate, text) };
}

// ---- Google Cloud TTS ----
async function engineGoogle(body) {
  const cfg = ttsCloudCfg("google");
  if (!cfg.apiKey && !cfg.credentials) throw new Error("google not configured (tts.cloud.google.apiKey)");
  const text = ttsStripSsml(body.text);
  const pct = ttsRatePct(body.rate);
  const voiceName = cfg.voice || (String(body.voice).toLowerCase() === "tatyana"
    ? "ru-RU-Studio-O" : "ru-RU-Wavenet-C");
  const payload = {
    input: { text },
    voice: { languageCode: cfg.lang || "ru-RU", name: voiceName },
    audioConfig: { audioEncoding: "MP3", speakingRate: Math.max(0.25, Math.min(4, pct / 100)) }
  };
  let url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(cfg.apiKey || "")}`;
  let headers = { "content-type": "application/json" };
  if (!cfg.apiKey && cfg.credentials && cfg.credentials.access_token) {
    url = "https://texttospeech.googleapis.com/v1/text:synthesize";
    headers["Authorization"] = `Bearer ${cfg.credentials.access_token}`;
  }
  const json = await ttsMaybeViaXray((agent) => ttsHttpJson(url, { method: "POST", headers, body: payload, agent }));
  if (!json.audioContent) throw new Error("google: no audioContent");
  return { success: true, url: ttsStoreMp3(Buffer.from(json.audioContent, "base64"), "google", body.voice, body.rate, text) };
}

// ---- OpenAI TTS ----
async function engineOpenAI(body) {
  const cfg = ttsCloudCfg("openai");
  if (!cfg.apiKey) throw new Error("openai not configured (tts.cloud.openai.apiKey)");
  const text = ttsStripSsml(body.text);
  const pct = ttsRatePct(body.rate);
  const res = await ttsMaybeViaXray((agent) => ttsHttp(cfg.endpoint || "https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${cfg.apiKey}`
    },
    body: {
      model: cfg.model || "tts-1",
      voice: cfg.voice || (String(body.voice).toLowerCase() === "tatyana" ? "nova" : "onyx"),
      input: text,
      response_format: "mp3",
      speed: Math.max(0.25, Math.min(4, pct / 100))
    },
    agent
  }));
  if (res.status !== 200) throw new Error(`openai ${res.status}: ${res.buffer.toString("utf8").slice(0, 200)}`);
  return { success: true, url: ttsStoreMp3(res.buffer, "openai", body.voice, body.rate, text) };
}

// ---- ElevenLabs ----
async function engineElevenLabs(body) {
  const cfg = ttsCloudCfg("elevenlabs");
  if (!cfg.apiKey) throw new Error("elevenlabs not configured (tts.cloud.elevenlabs.apiKey)");
  const text = ttsStripSsml(body.text);
  const voiceId = cfg.voiceId || "21m00Tcm4TlvDq8ikWAM";
  const pct = ttsRatePct(body.rate);
  const res = await ttsMaybeViaXray((agent) => ttsHttp(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": cfg.apiKey
      },
      body: {
        text,
        model_id: cfg.model || "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        speed: Math.max(0.5, Math.min(2, pct / 100))
      },
      agent
    }
  ));
  if (res.status !== 200) throw new Error(`elevenlabs ${res.status}: ${res.buffer.toString("utf8").slice(0, 200)}`);
  return { success: true, url: ttsStoreMp3(res.buffer, "elevenlabs", body.voice, body.rate, text) };
}

const TTS_HANDLERS = {
  upstream: engineUpstream,
  mirror: engineMirror,
  "proxy-mp3": engineProxyMp3,
  espeak: engineEspeak,
  local: engineEspeak,
  piper: enginePiper,
  yandex: engineYandex,
  polly: enginePolly,
  azure: engineAzure,
  google: engineGoogle,
  openai: engineOpenAI,
  elevenlabs: engineElevenLabs
};

function ttsModeReady(mode) {
  try {
    if (TTS_LOCAL_MODES.has(mode) && mode === "espeak") return !!TTS.espeak.bin;
    if (mode === "piper") return !!(TTS.piper.bin && TTS.piper.model);
    if (mode === "yandex") return !!(ttsCloudCfg("yandex").apiKey || ttsCloudCfg("yandex").iamToken);
    if (mode === "polly") return !!(ttsCloudCfg("polly").accessKeyId && ttsCloudCfg("polly").secretAccessKey);
    if (mode === "azure") return !!ttsCloudCfg("azure").key;
    if (mode === "google") return !!(ttsCloudCfg("google").apiKey || ttsCloudCfg("google").credentials);
    if (mode === "openai") return !!ttsCloudCfg("openai").apiKey;
    if (mode === "elevenlabs") return !!ttsCloudCfg("elevenlabs").apiKey;
    return true;
  } catch { return false; }
}

async function ttsHandleGenerate(req, res) {
  const body = req.body || {};
  const text = ttsStripSsml(body.text).slice(0, 80);
  log("TTS", `🔊 POST /tts/generate [${TTS.mode}]`, { mode: TTS.mode, voice: body.voice, rate: body.rate, text });
  const handler = TTS_HANDLERS[TTS.mode] || TTS_HANDLERS.upstream;
  try {
    const result = await handler(body);
    log("TTS", `✅ done → ${result && result.url}`);
    res.status(201).json(result);
  } catch (err) {
    log("TTS", `❌ [${TTS.mode}] ${err.message}`);
    if (!res.headersSent) res.status(502).json({ success: false, error: String(err.message || err), mode: TTS.mode });
  }
}

function truncateBody(body, max = 4000) {
  if (body === null || body === undefined) return null;
  if (Buffer.isBuffer(body)) return `<binary ${body.length} bytes>`;
  if (typeof body === 'object') {
    try { body = JSON.stringify(body); } catch { body = String(body); }
  }
  body = String(body);
  return body.length > max ? body.substring(0, max) + '... [TRUNCATED]' : body;
}

// ======================= APP TAGS (games.json) ===================
let APP_TAGS = {};
try {
  APP_TAGS = JSON.parse(fs.readFileSync("./games.json", "utf-8")).appTags || {};
  log("APPTAGS", `📚 Loaded ${Object.keys(APP_TAGS).length} app tags from games.json`);
} catch (err) {
  log("APPTAGS", `⚠️ games.json not loaded: ${err.message}`);
}

// Игры, которые умеет отдавать этот сайт (ключи бандлов из манифеста controller-оболочки + games.json)
let KNOWN_GAME_TAGS = new Set();
const MANIFEST_PROBES = [
  CONFIG.manifestPath,
  new URL("BRQY40Mb.js", import.meta.url),   // новое полное зеркало контроллера
  new URL("script-0.js", import.meta.url),   // папка сервера (рядом с bot.js)
  "/var/www/jacksite/script-0.js"            // фолбэк: копия сайта
].filter(Boolean);
let shellSrc = null;
for (const cand of MANIFEST_PROBES) {
  try { shellSrc = fs.readFileSync(cand, "utf-8"); break; } catch {}
}
try {
  if (!shellSrc) throw new Error("script-0.js not found");
  const bundleRe = /\n\s*("?[\w@][\w.@-]*"?)\s*:\s*\{\s*\n\s*file:\s*"[^"]+",\s*\n\s*css:\s*\[[^\]]*\],\s*\n\s*base:\s*"[^"]+",\s*\n\s*version:\s*"[^"]+",/g;
  let bm;
  while ((bm = bundleRe.exec(shellSrc)) !== null) {
    KNOWN_GAME_TAGS.add(bm[1].replace(/^"|"$/g, "").toLowerCase());
  }
  const minBundleRe = /[{,:]\s*("?)([\w@][\w.@-]*)\1\s*:\s*\{\s*file\s*:\s*"/g;
  let mm;
  while ((mm = minBundleRe.exec(shellSrc)) !== null) {
    KNOWN_GAME_TAGS.add(mm[2].replace(/^"|"$/g, "").toLowerCase());
  }
  const tagRe = /\btag:\s*"([^"]+)"/g;
  let tm;
  while ((tm = tagRe.exec(shellSrc)) !== null) KNOWN_GAME_TAGS.add(tm[1].toLowerCase());
  for (const t of Object.keys(APP_TAGS)) KNOWN_GAME_TAGS.add(String(t).toLowerCase());
  log("APPTAGS", `🧩 Known game tags: ${KNOWN_GAME_TAGS.size}`);
} catch (err) {
  log("APPTAGS", `⚠️ Failed to build known game tags: ${err.message}`);
}

function isUnknownGameTag(tag) {
  if (!tag) return false;
  if (KNOWN_GAME_TAGS.size === 0) return false;
  return !KNOWN_GAME_TAGS.has(String(tag).toLowerCase());
}

function resolveAppId(body) {
  const appTag = body.appTag || body.apptag || body.tag || "jackboxpartypack3";
  return body.appId || body.appID || body.app || APP_TAGS[appTag] || appTag;
}


// ======================= UTILS ===========================
function log(type, message, data = null) {
  const time = new Date().toISOString();
  const prefix = `[${time}] [${type}]`;
  console.log(`\n${prefix} ${message}`);
  if (data !== null && data !== undefined) {
    let str;
    try { str = typeof data === 'string' ? data : JSON.stringify(data, null, 2); } catch { str = null; }
    if (typeof str !== 'string') { try { str = String(data); } catch { str = '[unserializable]'; } }
    const truncated = str.length > 500 ? str.substring(0, 500) + '...' : str;
    console.log(`  ${truncated.split('\n').map(l => '  ' + l).join('\n')}`);
  }
}

function safeStr(v, max = 200) {
  let s;
  try { s = JSON.stringify(v); } catch { s = null; }
  if (typeof s !== 'string') { try { s = String(v); } catch { s = '[unserializable]'; } }
  return s.substring(0, max);
}

process.on('uncaughtException', (err) => {
  try { console.error(`\n[FATAL] uncaughtException: ${(err && err.stack) || err}`); } catch {}
});
process.on('unhandledRejection', (reason) => {
  try { console.error(`\n[FATAL] unhandledRejection: ${(reason && reason.stack) || reason}`); } catch {}
});

function generateRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * 26)]).join("");
}
function pickPreparedRoom(ip) {
  const exact = preparedRooms.get(ip);
  if (exact) return exact;
  const cand = [...preparedRooms.values()]
    .filter(p => !rooms.has(p.code))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  return cand || null;
}
function generateToken() { return crypto.randomBytes(12).toString("hex"); }
function generateUUID() { return crypto.randomUUID(); }
function normalizeIP(ip) { return ip ? ip.replace(/^::ffff:/, "").split(",")[0].trim() : null; }
function getClientIP(req) { return normalizeIP(req.headers['x-forwarded-for'] || req.socket.remoteAddress); }

// ======================= XRAY MANAGER ====================
class XrayManager {
  constructor() {
    this.xrayBin = CONFIG.xrayBin || "./xray-bin/xray";
    this.localPort = CONFIG.xrayLocalPort || 10808;
    this.subscriptionUrl = CONFIG.xraySubscription || null;
    this.servers = [];
    this.currentServer = null;
    this.process = null;
    this.isRunning = false;
  }

  loadServers() {
    const list = Array.isArray(CONFIG.xrayServers) ? CONFIG.xrayServers : [];
    const servers = [];
    for (const line of list) {
      try {
        const s = this.parseShareLink(line.trim());
        if (s) servers.push(s);
      } catch (err) {
        log("XRAY", `⚠️ Parse error: ${line.substring(0, 60)}... -> ${err.message}`);
      }
    }
    this.servers = servers;
    log("XRAY", `✅ Loaded ${servers.length} servers from config.json`);
    for (const s of servers) {
      log("XRAY", `  - ${s.name} [${s.type}] ${s.address}:${s.port} ${s.security || ''}`);
    }
    return servers;
  }

  async fetchSubscription() {
    if (!this.subscriptionUrl) return false;
    const url = this.subscriptionUrl;
    log("XRAY", `📥 Fetching subscription: ${url}`);

    return new Promise((resolve) => {
      const mod = url.startsWith('https') ? https : http;
      const headers = (CONFIG.xraySubscriptionHeaders && typeof CONFIG.xraySubscriptionHeaders === 'object')
        ? { ...CONFIG.xraySubscriptionHeaders } : {};
      const req = mod.get(url, { timeout: 15000, rejectUnauthorized: false, headers }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            let body = Buffer.concat(chunks).toString('utf-8').trim();
            let lines;
            try {
              const decoded = Buffer.from(body, 'base64').toString('utf-8');
              lines = decoded.includes('://') ? decoded.split(/\r?\n/) : body.split(/\r?\n/);
            } catch {
              lines = body.split(/\r?\n/);
            }
            const servers = [];
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) continue;
              try {
                const s = this.parseShareLink(trimmed);
                if (s) servers.push(s);
              } catch (err) {
                log("XRAY", `⚠️ Sub parse error: ${trimmed.substring(0, 60)} -> ${err.message}`);
              }
            }
            if (servers.length > 0) {
              this.servers = servers;
              log("XRAY", `✅ Subscription: ${servers.length} servers loaded`);
              for (const s of servers) log("XRAY", `  - ${s.name} [${s.type}] ${s.address}:${s.port}`);
              resolve(true);
            } else {
              log("XRAY", `⚠️ Subscription returned 0 servers`);
              resolve(false);
            }
          } catch (err) {
            log("XRAY", `❌ Subscription parse error: ${err.message}`);
            resolve(false);
          }
        });
      });
      req.on('error', (err) => { log("XRAY", `❌ Subscription fetch error: ${err.message}`); resolve(false); });
      req.on('timeout', () => { req.destroy(); log("XRAY", `❌ Subscription fetch timeout`); resolve(false); });
    });
  }

  parseShareLink(link) {
    if (link.startsWith('vless://')) return this.parseVless(link);
    if (link.startsWith('vmess://')) return this.parseVmess(link);
    if (link.startsWith('trojan://')) return this.parseTrojan(link);
    if (link.startsWith('ss://')) return this.parseShadowsocks(link);
    return null;
  }

  parseVless(link) {
    const url = new URL(link);
    const params = Object.fromEntries(url.searchParams);
    return {
      type: 'vless',
      name: decodeURIComponent(url.hash.slice(1)) || 'VLESS',
      uuid: url.username,
      address: url.hostname,
      port: parseInt(url.port) || 443,
      encryption: params.encryption || 'none',
      security: params.security || 'tls',
      network: params.type || 'tcp',
      flow: params.flow || '',
      sni: params.sni || params.host || url.hostname,
      host: params.host || '',
      path: params.path || '',
      pbk: params.pbk || '',
      sid: params.sid || '',
      fp: params.fp || 'chrome',
      spiderX: params.spiderX || ''
    };
  }

  parseVmess(link) {
    const b64 = link.replace('vmess://', '');
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    return {
      type: 'vmess', name: json.ps || 'VMess',
      address: json.add, port: parseInt(json.port),
      uuid: json.id, alterId: parseInt(json.aid) || 0,
      security: json.scy || 'auto', network: json.net || 'tcp',
      tls: json.tls === 'tls' ? 'tls' : 'none',
      sni: json.sni || json.add, path: json.path || '', host: json.host || ''
    };
  }

  parseTrojan(link) {
    const url = new URL(link);
    const params = Object.fromEntries(url.searchParams);
    return {
      type: 'trojan',
      name: decodeURIComponent(url.hash.slice(1)) || 'Trojan',
      password: url.username,
      address: url.hostname, port: parseInt(url.port) || 443,
      sni: params.sni || url.hostname, fp: params.fp || 'chrome'
    };
  }

  parseShadowsocks(link) {
    const url = new URL(link);
    let method, password;
    if (url.username.includes(':')) {
      [method, password] = url.username.split(':');
    } else {
      const decoded = Buffer.from(url.username, 'base64').toString('utf-8');
      [method, password] = decoded.split(':');
    }
    return {
      type: 'shadowsocks',
      name: decodeURIComponent(url.hash.slice(1)) || 'SS',
      method, password, address: url.hostname, port: parseInt(url.port)
    };
  }

  generateConfig(server) {
    const config = {
      log: { loglevel: "warning" },
      inbounds: [{
        port: this.localPort, listen: "127.0.0.1",
        protocol: "socks",
        sniffing: { enabled: true, destOverride: ["http", "tls"] },
        settings: { auth: "noauth", udp: true }
      }],
      outbounds: []
    };

    if (server.type === 'vless') {
      const stream = { network: server.network };
      if (server.security === 'reality') {
        stream.security = 'reality';
        stream.realitySettings = {
          serverName: server.sni, publicKey: server.pbk,
          shortId: server.sid, fingerprint: server.fp,
          spiderX: server.spiderX || ''
        };
      } else if (server.security === 'tls') {
        stream.security = 'tls';
        stream.tlsSettings = { serverName: server.sni, fingerprint: server.fp };
      }
      if (server.network === 'tcp') stream.tcpSettings = {};
      else if (server.network === 'ws') stream.wsSettings = { path: server.path, headers: { Host: server.host || server.sni } };

      config.outbounds.push({
        protocol: "vless",
        settings: { vnext: [{ address: server.address, port: server.port, users: [{ id: server.uuid, encryption: server.encryption, flow: server.flow }] }] },
        streamSettings: stream
      });
    } else if (server.type === 'vmess') {
      config.outbounds.push({
        protocol: "vmess",
        settings: { vnext: [{ address: server.address, port: server.port, users: [{ id: server.uuid, alterId: server.alterId, security: server.security }] }] },
        streamSettings: { network: server.network, security: server.tls, tlsSettings: server.tls === 'tls' ? { serverName: server.sni } : undefined }
      });
    } else if (server.type === 'trojan') {
      config.outbounds.push({
        protocol: "trojan",
        settings: { servers: [{ address: server.address, port: server.port, password: server.password }] },
        streamSettings: { network: "tcp", security: "tls", tlsSettings: { serverName: server.sni, fingerprint: server.fp } }
      });
    } else if (server.type === 'shadowsocks') {
      config.outbounds.push({
        protocol: "shadowsocks",
        settings: { servers: [{ address: server.address, port: server.port, method: server.method, password: server.password }] }
      });
    }

    config.outbounds.push({ protocol: "freedom", tag: "direct" });
    config.routing = { rules: [{ type: "field", ip: ["geoip:private"], outboundTag: "direct" }] };
    return config;
  }

  async startWithServer(server) {
    await this.stop();
    const config = this.generateConfig(server);
    const configPath = `/tmp/xray-config-${Date.now()}.json`;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    log("XRAY", `🚀 Starting: ${server.name} [${server.type}] (${server.address}:${server.port})`);

    return new Promise((resolve, reject) => {
      this.process = spawn(this.xrayBin, ['run', '-config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let started = false;
      const timeout = setTimeout(() => { if (!started) reject(new Error('Xray start timeout')); }, 5000);

      this.process.stderr.on('data', (data) => { const l = data.toString().trim(); if (l) log("XRAY", `⚠️ ${l}`); });
      this.process.stdout.on('data', (data) => { const l = data.toString().trim(); if (l) log("XRAY", `📋 ${l}`); });

      this.process.on('close', (code) => {
        if (!started && code !== 0) { started = true; reject(new Error(`Xray exited: ${code}`)); }
        this.isRunning = false; this.currentServer = null;
        try { fs.unlinkSync(configPath); } catch {}
      });

      setTimeout(() => {
        if (!started) {
          started = true; clearTimeout(timeout);
          this.currentServer = server; this.isRunning = true;
          log("XRAY", `✅ Running on socks5://127.0.0.1:${this.localPort}`);
          resolve();
        }
      }, 2000);
    });
  }

  async stop() {
    if (this.process) {
      log("XRAY", `🛑 Stopping...`);
      const proc = this.process;
      this.process = null;
      proc.kill('SIGTERM');
      await new Promise(r => {
        let done = false;
        const finish = () => { if (!done) { done = true; r(); } };
        proc.on('close', finish);
        setTimeout(() => {
          if (!done) {
            log("XRAY", `⚠️ Xray не остановился за 2s → SIGKILL`);
            try { proc.kill('SIGKILL'); } catch {}
            finish();
          }
        }, 2000);
      });
      this.isRunning = false; this.currentServer = null;
    }
  }

  async testConnection() {
    return new Promise((resolve) => {
      try {
        const agent = new SocksProxyAgent(`socks5://127.0.0.1:${this.localPort}`);
        const req = https.get('https://api.telegram.org/bot123:ABC/getMe', {
          agent, timeout: 10000, rejectUnauthorized: false
        }, (res) => {
          res.resume();
          log("XRAY", `📡 Test: HTTP ${res.statusCode}`);
          resolve(res.statusCode < 500);
        });
        req.on('error', (e) => { log("XRAY", `📡 Test fail: ${e.message}`); resolve(false); });
        req.on('timeout', () => { req.destroy(); resolve(false); });
      } catch { resolve(false); }
    });
  }

  async tryNextServer() {
    if (!this.servers.length) this.loadServers();
    if (!this.servers.length) { log("XRAY", `❌ No servers`); return false; }

    let startIdx = 0;
    if (this.currentServer) {
      const idx = this.servers.findIndex(s => s.address === this.currentServer.address && s.port === this.currentServer.port);
      startIdx = idx >= 0 ? (idx + 1) % this.servers.length : 0;
    }

    for (let i = 0; i < this.servers.length; i++) {
      const server = this.servers[(startIdx + i) % this.servers.length];
      try {
        await this.startWithServer(server);
        if (await this.testConnection()) {
          log("XRAY", `✅ WORKING: ${server.name}`);
          return true;
        }
        log("XRAY", `⚠️ ${server.name} failed, trying next...`);
        await this.stop();
      } catch (err) {
        log("XRAY", `❌ ${server.name}: ${err.message}`);
        await this.stop();
      }
    }
    log("XRAY", `❌ No working servers`);
    return false;
  }

  async getAgent() {
    if (!this.isRunning) {
      if (!await this.tryNextServer()) return null;
    }
    return new SocksProxyAgent(`socks5://127.0.0.1:${this.localPort}`);
  }
}

const xrayManager = new XrayManager();

async function initXray() {
  if (xrayManager.subscriptionUrl) {
    const ok = await xrayManager.fetchSubscription();
    if (!ok) xrayManager.loadServers();
  } else {
    xrayManager.loadServers();
  }
  await xrayManager.tryNextServer().catch(e => log("XRAY", `❌ Init: ${e.message}`));
}

initXray();

// Обновляем подписку каждый час
setInterval(async () => {
  if (xrayManager.subscriptionUrl) {
    await xrayManager.fetchSubscription();
  }
}, 60 * 60 * 1000);

setInterval(async () => {
  if (xrayManager.isRunning) {
    if (!await xrayManager.testConnection()) {
      log("XRAY", `⚠️ Server dead, switching...`);
      await xrayManager.tryNextServer();
    }
  } else {
    await xrayManager.tryNextServer();
  }
}, 5 * 60 * 1000);

// ======================= ROOM STORAGE ===================
const rooms = new Map();
const preparedRooms = new Map();

const MODERATION_TAGS = new Set(["quiplash3-tjsp","awshirt-tjsp","drawful2international","bigsurvey","fakinitxl","jackbox-talks","quiplash3","worldchamps","fourbage","htmf","antique-freak","range-game","awshirt2","risky-text","us-them","fakinit2","drawful3","captcha","you-ruined-it","mic-game","cookies","dirty-detectives","grating-cards","megafriends","debate","reaction","processing"]);

function createRoom(appId, appTag, maxPlayers, roomCode, userId) {
  const room = {
    appId, appTag, userId,
    maxPlayers: maxPlayers || 8, minPlayers: 0, roomCode,
    locked: false, gameStarted: false,
    audienceEnabled: false, audienceConnected: false, audienceId: null,
    twitchRequired: false,
    gamePassword: null, moderatorPassword: null,
    players: new Map(), moderators: new Map(),
    disconnectedPlayers: new Map(), disconnectedTimers: new Map(),
    audience: new Map(),
    nextPlayerId: 2, nextModeratorId: 500, nextAudienceId: 1000,
    host: null, hostToken: generateToken(),
    objects: new Map(), versions: new Map(), fromMap: new Map(),
    restrictions: new Map(), locks: new Map(), types: new Map(), acls: new Map(),
    pcHost: 2, pcPlayers: new Map(),
    created: Date.now(), owner: null, creatorIP: null
  };
  return room;
}

// ======================= PROXY LOG ===================
const PROXY_LOG_FILE = "./data/proxy-log.json";
const proxyLog = [];
const MAX_PROXY_LOG = 500;

try {
  if (fs.existsSync(PROXY_LOG_FILE)) {
    const raw = fs.readFileSync(PROXY_LOG_FILE, "utf-8").trim();
    if (raw) {
      const loaded = JSON.parse(raw);
      if (Array.isArray(loaded)) {
        proxyLog.push(...loaded.slice(-MAX_PROXY_LOG));
        log("PROXY-LOG", `📂 Loaded ${proxyLog.length} entries from ${PROXY_LOG_FILE}`);
      }
    }
  }
} catch (err) {
  log("PROXY-LOG", `⚠️ Failed to load proxy log: ${err.message}`);
}

function logProxyEntry(entry) {
  proxyLog.push(entry);
  if (proxyLog.length > MAX_PROXY_LOG) proxyLog.shift();
  if (proxyLog.length % 10 === 0) {
    try { fs.writeFileSync(PROXY_LOG_FILE, JSON.stringify(proxyLog, null, 2)); } catch {}
  }
}

// ======================= UPSTREAM TARGET PROXY =======================
// Frontend can pick a custom Jackbox server. When proxy mode is active it
// sends `x-upstream-server: <target>` and we forward HTTP + WS there via xray.
const upstreamTargets = new Map(); // roomCode -> { host, ts }
const UPSTREAM_TTL = 5 * 60 * 1000;

function needsVpn(targetHost) {
  return /(^|\.)jackboxgames\.com$/i.test(String(targetHost || ""));
}

function normalizeUpstreamTarget(raw) {
  let t = String(raw || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!t || t === "live") return null;
  if (!t.includes(".")) t = `${t}.jackboxgames.com`;
  if (t === String(accessibleHost).toLowerCase()) return null;
  return t;
}

function pickUpstreamTarget(req) {
  const raw = req.headers["x-upstream-server"] || req.query.upstream || req.query.target;
  return normalizeUpstreamTarget(raw);
}

function pruneUpstreamTargets() {
  const now = Date.now();
  for (const [code, info] of upstreamTargets) {
    if (now - info.ts > UPSTREAM_TTL) upstreamTargets.delete(code);
  }
}

async function proxyToTarget(req, res, targetHost, source) {
  let path = req.originalUrl;
  try {
    const u = new URL(path, "http://x");
    u.searchParams.delete("upstream");
    u.searchParams.delete("target");
    path = u.pathname + (u.search || "");
  } catch (e) { /* keep original */ }

  let requestBody = null;
  if (req.body && Object.keys(req.body).length > 0) requestBody = JSON.stringify(req.body);

  const headers = {};
  const drop = new Set(["host", "content-length", "connection", "keep-alive", "transfer-encoding", "accept-encoding", "x-upstream-server", "x-internal-token", "x-forwarded-for"]);
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (!drop.has(k.toLowerCase())) headers[k] = v;
  }
  headers["host"] = targetHost;

  const vpnTries = req.method === "GET" ? 3 : 1;
  const plans = needsVpn(targetHost)
    ? [{ via: "xray", tries: vpnTries }, { via: "direct", tries: 1 }]
    : [{ via: "direct", tries: 1 }, { via: "xray", tries: vpnTries }];

  for (const plan of plans) {
    for (let attempt = 1; attempt <= plan.tries; attempt++) {
      const agent = plan.via === "xray" ? await xrayManager.getAgent() : null;
      if (plan.via === "xray" && !agent) break;
      const label = agent ? "vpn" : "direct";
      const startTime = Date.now();
      const entry = {
        timestamp: startTime, source, method: req.method, path,
        targetUrl: `https://${targetHost}${path}`, clientIP: getClientIP(req),
        requestHeaders: { ...headers }, requestBody: truncateBody(requestBody),
        upstream: targetHost, via: label
      };

      log(source, `🔀 ${req.method} ${path} → ${targetHost}${path} [${label}${plan.tries > 1 ? ` ${attempt}/${plan.tries}` : ""}]`);

      try {
        const result = await new Promise((resolve, reject) => {
          const options = {
            hostname: targetHost, port: 443, path, method: req.method, headers,
            rejectUnauthorized: false, servername: targetHost
          };
          if (agent) options.agent = agent;
          const proxyReq = https.request(options, (up) => {
            const chunks = [];
            up.on("data", (c) => chunks.push(c));
            up.on("end", () => resolve({ statusCode: up.statusCode, headers: up.headers, buf: Buffer.concat(chunks) }));
            up.on("error", reject);
          });
          proxyReq.setTimeout(30000, () => proxyReq.destroy(new Error("timeout")));
          proxyReq.on("error", reject);
          if (requestBody) proxyReq.write(requestBody);
          proxyReq.end();
        });

        let buf = result.buf;
        const ct = String(result.headers["content-type"] || "");
        if (ct.includes("json")) {
          try {
            const json = JSON.parse(buf.toString("utf8"));
            const body = json && json.body;
            if (body && body.code && (body.host || body.audienceHost)) {
              const code = String(body.code).toUpperCase();
              const realHost = String(body.host || body.audienceHost);
              upstreamTargets.set(code, { host: realHost, ts: Date.now() });
              log("UPSTREAM", `📌 Room ${code} → ${realHost}`);
              body.host = accessibleHost;
              body.audienceHost = accessibleHost;
              buf = Buffer.from(JSON.stringify(json));
            }
          } catch (e) { /* not a room payload, pass through */ }
        }

        entry.responseStatus = result.statusCode;
        entry.duration = Date.now() - startTime;
        entry.responseSize = buf.length;
        logProxyEntry(entry);
        const out = {};
        for (const [k, v] of Object.entries(result.headers)) {
          if (!["transfer-encoding", "connection", "keep-alive", "content-length"].includes(k.toLowerCase())) out[k] = v;
        }
        out["access-control-allow-origin"] = "*";
        out["content-length"] = String(buf.length);
        res.writeHead(result.statusCode, out);
        res.end(buf);
        return;
      } catch (err) {
        entry.error = err.message;
        entry.duration = Date.now() - startTime;
        logProxyEntry(entry);
        log(source, `❌ upstream ${targetHost} [${label} ${attempt}/${plan.tries}]: ${err.message}`);
        if (plan.via === "xray" && agent) { try { await xrayManager.tryNextServer(); } catch (e) { /* ignore */ } }
      }
    }
  }

  if (!res.headersSent) res.status(502).json({ error: "upstream proxy error" });
}

async function tunnelUpstreamWs(socket, req, realHost) {
  const proto = req.headers["sec-websocket-protocol"];
  const cleanUrl = String(req.url || "").replace(/([?&])(upstream|target)=[^&]*/gi, "$1").replace(/[?&]$/, "");

  const pending = [];
  let open = false;
  let active = null;
  socket.on("message", (data, isBinary) => {
    if (open && active) { try { active.send(data, { binary: isBinary }); } catch {} }
    else pending.push({ data, isBinary });
  });
  socket.on("close", () => { try { active && active.close(); } catch {} });
  socket.on("error", () => { try { active && active.terminate(); } catch {} });

  const strategies = needsVpn(realHost) ? ["xray", "direct"] : ["direct", "xray"];

  for (const via of strategies) {
    const agent = via === "xray" ? await xrayManager.getAgent() : null;
    if (via === "xray" && !agent) continue;

    const ok = await new Promise((resolve) => {
      const opts = { rejectUnauthorized: false, handshakeTimeout: 15000 };
      if (agent) opts.agent = agent;
      let upstream;
      try {
        upstream = new WebSocket(`wss://${realHost}${cleanUrl}`, proto ? [proto] : [], opts);
      } catch (e) {
        log("UPSTREAM-WS", `❌ ${realHost} [${via}] ${e.message}`);
        return resolve(false);
      }
      let done = false;
      upstream.on("open", () => {
        done = true; open = true; active = upstream;
        log("UPSTREAM-WS", `✅ ${realHost} [${via}]`);
        for (const m of pending) { try { upstream.send(m.data, { binary: m.isBinary }); } catch {} }
        pending.length = 0;
        upstream.on("message", (data, isBinary) => { try { socket.send(data, { binary: isBinary }); } catch {} });
        upstream.on("close", (code, reason) => { try { socket.close(code, reason); } catch { socket.terminate(); } });
        upstream.on("error", (e) => { log("UPSTREAM-WS", `❌ ${e.message}`); try { socket.terminate(); } catch {} });
        resolve(true);
      });
      upstream.on("error", (e) => { if (!done) { log("UPSTREAM-WS", `❌ ${realHost} [${via}] ${e.message}`); try { upstream.terminate(); } catch {} resolve(false); } });
      upstream.on("close", () => { if (!done) resolve(false); });
    });

    if (ok) return;
    if (via === "xray") { try { await xrayManager.tryNextServer(); } catch (e) { /* ignore */ } }
  }

  try { socket.terminate(); } catch (e) { /* ignore */ }
}

async function proxyToJackbox(req, res, source) {
  const path = req.originalUrl;
  const targetUrl = `https://ecast.jackboxgames.com${path}`;
  const parsed = urlNode.parse(targetUrl);
  const agent = await xrayManager.getAgent();

  log(source, `🌐 ${req.method} ${path} → ecast.jackboxgames.com${path}`);

  let requestBody = null;
  if (req.body && Object.keys(req.body).length > 0) requestBody = req.body;

  const headers = {
    'user-agent': req.headers['user-agent'] || "JackboxGames/1.00 libcurl/7.57.0-DEV OpenSSL/1.1.1g zlib/1.2.7 (Win-Steam)",
    'accept': req.headers.accept || '*/*',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    'host': 'ecast.jackboxgames.com',
    'connection': 'keep-alive',
  };
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  if (req.headers.referer) headers.referer = req.headers.referer;
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];

  log(source, `📤 REQUEST HEADERS`, headers);
  if (requestBody) log(source, `📤 REQUEST BODY`, requestBody);

  const options = {
    hostname: 'ecast.jackboxgames.com', port: 443,
    path: parsed.path, method: req.method, headers,
    rejectUnauthorized: false, servername: 'ecast.jackboxgames.com'
  };
  if (agent) options.agent = agent;

  const startTime = Date.now();
  const entry = {
    timestamp: startTime, source, method: req.method, path, targetUrl,
    requestHeaders: { ...headers }, requestBody,
    clientIP: getClientIP(req), via: agent ? 'xray' : 'direct'
  };

  const proxyReq = https.request(options, (proxyRes) => {
    const duration = Date.now() - startTime;
    log(source, `📥 ${proxyRes.statusCode} ${proxyRes.statusMessage || ''} for ${path} (${duration}ms)`);
    
    const responseHeaders = {};
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!['transfer-encoding', 'connection', 'keep-alive'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
        responseHeaders[key] = value;
      }
    }
    log(source, `📥 RESPONSE HEADERS`, responseHeaders);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(proxyRes.statusCode);

    const chunks = [];
    let totalSize = 0;
    const MAX_LOG_SIZE = 10000;

    proxyRes.on('data', (chunk) => {
      if (totalSize < MAX_LOG_SIZE) { chunks.push(chunk); totalSize += chunk.length; }
    });

    proxyRes.on('end', () => {
      entry.duration = duration;
      entry.responseStatus = proxyRes.statusCode;
      entry.responseHeaders = responseHeaders;
      entry.responseSize = totalSize;
      
      if (chunks.length > 0) {
        const bodyBuf = Buffer.concat(chunks);
        const ct = proxyRes.headers['content-type'] || '';
        if (ct.includes('json') || ct.includes('text') || ct.includes('html') || ct.includes('javascript')) {
          const bodyStr = bodyBuf.toString('utf8', 0, Math.min(MAX_LOG_SIZE, bodyBuf.length));
          entry.responseBody = bodyStr;
          res.__mirrorBody = bodyStr;
          const preview = bodyStr.length > 2000 ? bodyStr.substring(0, 2000) + '... [TRUNCATED]' : bodyStr;
          log(source, `📥 RESPONSE BODY (${bodyStr.length} chars):`, preview);
        } else {
          entry.responseBody = `<binary ${totalSize} bytes>`;
          log(source, `📥 RESPONSE BODY: <binary ${totalSize} bytes>`);
        }
      }
      logProxyEntry(entry);
    });

    proxyRes.pipe(res);
  });

  proxyReq.setTimeout(30000, () => {
    entry.error = 'timeout';
    logProxyEntry(entry);
    log(source, `❌ TIMEOUT for ${path}`);
    proxyReq.destroy(new Error('timeout'));
  });

  proxyReq.on('error', async (err) => {
    log(source, `❌ ${err.message}`);
    entry.error = err.message;
    logProxyEntry(entry);
    if (agent) await xrayManager.tryNextServer();
    if (!res.headersSent) res.status(502).json({ error: "proxy error" });
  });

  if (requestBody) proxyReq.write(JSON.stringify(requestBody));
  proxyReq.end();
}

// ======================= MITM MIRROR (HTTP + WS) ===================
function mitmSkipPath(path) {
  return path.startsWith('/admin/');
}

function mitmHeaders(req) {
  const headers = {};
  const drop = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'x-internal-token', 'x-forwarded-for']);
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (!drop.has(k.toLowerCase())) headers[k] = v;
  }
  return headers;
}

function mitmEncodeBody(req) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Object.keys(body).length === 0) return null;
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString();
  }
  return JSON.stringify(body);
}

function mirrorHTTP(req, res) {
  if (!mitmActive() || req.method === 'OPTIONS' || mitmSkipPath(req.originalUrl)) return;

  const path = req.originalUrl;
  const targetUrl = MITM.mirrorUrl + path;
  const payload = mitmEncodeBody(req);
  const headers = mitmHeaders(req);
  headers['host'] = MITM.parsed.host;
  if (payload !== null) headers['content-length'] = Buffer.byteLength(payload);
  delete headers['content-type'];
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];

  const entry = {
    timestamp: Date.now(),
    source: 'MITM',
    method: req.method,
    path,
    targetUrl,
    clientIP: getClientIP(req),
    requestHeaders: { ...headers },
    requestBody: truncateBody(payload),
    localStatus: res.statusCode,
    localBody: truncateBody(res.__mirrorBody),
    via: 'direct'
  };

  const startTime = Date.now();
  const mod = MITM.parsed.protocol === 'https:' ? https : http;

  const attemptMirror = (via) => {
    const options = {
      hostname: MITM.parsed.hostname,
      port: MITM.parsed.port || (MITM.parsed.protocol === 'https:' ? 443 : 80),
      path: MITM.parsed.pathname.replace(/\/+$/, '') + path,
      method: req.method,
      headers,
      rejectUnauthorized: false,
      servername: MITM.parsed.hostname,
      timeout: 20000
    };
    if (via === 'xray') {
      try { options.agent = new SocksProxyAgent(`socks5://127.0.0.1:${xrayManager.localPort}`); } catch { return; }
    }
    entry.via = via;

    const mirrorReq = mod.request(options, (mirrorRes) => {
      const chunks = [];
      let size = 0;
      mirrorRes.on('data', (c) => { if (size < 8000) { chunks.push(c); size += c.length; } });
      mirrorRes.on('end', () => {
        entry.duration = Date.now() - startTime;
        entry.mirrorStatus = mirrorRes.statusCode;
        entry.mirrorHeaders = mirrorRes.headers;
        entry.mirrorBody = truncateBody(Buffer.concat(chunks).toString('utf8'));
        logProxyEntry(entry);
        log('MITM', `📊 ${req.method} ${path} | LOCAL ${entry.localStatus} vs QA ${entry.mirrorStatus} (${entry.duration}ms, ${entry.via})`);
        log('MITM', `QA BODY:`, entry.mirrorBody);
      });
    });

    mirrorReq.on('timeout', () => { mirrorReq.destroy(new Error('timeout')); });
    mirrorReq.on('error', (err) => {
      if (via === 'direct' && xrayManager.isRunning) {
        entry.retry = err.message;
        log('MITM', `⚠️ direct mirror failed (${err.message}), retry via xray`);
        attemptMirror('xray');
        return;
      }
      entry.duration = Date.now() - startTime;
      entry.mirrorError = err.message;
      logProxyEntry(entry);
      log('MITM', `❌ ${req.method} ${path} → QA failed: ${err.message}`);
    });

    if (payload !== null) mirrorReq.write(payload);
    mirrorReq.end();
  };

  attemptMirror('direct');
}

function startWsMirror(req) {
  if (!mitmActive() || mitmSkipPath(req.url)) return null;

  const wsUrl = MITM.mirrorUrl.replace(/^http/, 'ws') + req.url;
  const entry = {
    timestamp: Date.now(),
    source: 'MITM-WS',
    method: 'WS',
    path: req.url,
    targetUrl: wsUrl,
    clientIP: getClientIP(req),
    requestHeaders: mitmHeaders(req),
    events: [],
    logged: false
  };
  const finish = () => {
    if (entry.logged) return;
    entry.logged = true;
    logProxyEntry(entry);
  };

  const mirror = {
    entry,
    ws: null,
    queue: [],
    closed: false,
    send(data, isBinary) {
      const preview = isBinary ? `<binary ${data.length} bytes>` : truncateBody(data.toString(), 1500);
      entry.events.push({ dir: 'local→mirror', t: Date.now(), data: preview });
      if (entry.events.length > 100) entry.events.shift();
      log('MITM', `WS → ${preview}`);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send(data, { binary: isBinary }); } catch {}
      } else if (this.queue.length < 300) {
        this.queue.push({ data, isBinary });
      }
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      const ws = this.ws;
      if (!ws) { finish(); return; }
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.close(); } catch {}
        return;
      }
      if (ws.readyState === WebSocket.CONNECTING) {
        // локальная сторона уже отвалилась — всё равно дождаться рукопожатия
        // с QA, забрать первый ответ и только потом закрыть зеркало
        const killer = setTimeout(() => { try { ws.close(); } catch {} }, 3000);
        ws.once('open', () => {
          clearTimeout(killer);
          setTimeout(() => { try { ws.close(); } catch {} }, 2000);
        });
      }
      setTimeout(finish, 8000);
    }
  };

  const connect = (via, allowRetry) => {
    const headers = mitmHeaders(req);
    delete headers['sec-websocket-key'];
    delete headers['sec-websocket-version'];
    delete headers['sec-websocket-extensions'];
    delete headers['sec-websocket-protocol'];

    const opts = { headers, handshakeTimeout: 15000, rejectUnauthorized: false };
    if (via === 'xray') {
      try { opts.agent = new SocksProxyAgent(`socks5://127.0.0.1:${xrayManager.localPort}`); entry.via = 'xray'; } catch {}
    } else {
      entry.via = 'direct';
    }

    let ws;
    try {
      ws = new WebSocket(wsUrl, opts);
    } catch (err) {
      entry.mirrorError = err.message;
      finish();
      return;
    }
    mirror.ws = ws;
    if (mirror.closed) { try { ws.close(); } catch {} }

    ws.on('open', () => {
      entry.mirrorStatus = 101;
      log('MITM', `↔ WS mirror connected (${entry.via}): ${req.url}`);
      if (mirror.closed) { try { ws.close(); } catch {} return; }
      while (mirror.queue.length) {
        const { data, isBinary } = mirror.queue.shift();
        try { ws.send(data, { binary: isBinary }); } catch {}
      }
    });
    ws.on('message', (data, isBinary) => {
      const preview = isBinary ? `<binary ${data.length} bytes>` : truncateBody(data.toString(), 1500);
      entry.events.push({ dir: 'mirror→local', t: Date.now(), data: preview });
      if (entry.events.length > 100) entry.events.shift();
      log('MITM', `WS ← ${preview}`);
    });
    ws.on('error', (err) => {
      if (via === 'direct' && allowRetry && xrayManager.isRunning && ws.readyState === WebSocket.CONNECTING && !mirror.closed) {
        entry.retry = err.message;
        log('MITM', `⚠️ direct WS mirror failed (${err.message}), retry via xray`);
        mirror.ws = null;
        connect('xray', false);
        return;
      }
      entry.mirrorError = entry.mirrorError || err.message;
      log('MITM', `❌ WS mirror error (${req.url}): ${err.message}`);
      finish();
    });
    ws.on('close', (code) => {
      if (mirror.ws !== ws) return;
      entry.mirrorClose = code;
      finish();
    });
  };

  connect('direct', true);

  return mirror;
}

function attachWsMirror(localWs, mirror) {
  if (!mirror) return;
  localWs.on('message', (data, isBinary) => mirror.send(data, isBinary));
  localWs.on('close', () => mirror.close());
  localWs.on('error', () => mirror.close());
}

// ======================= EXPRESS ===================
const app = express();

// ======================= UPSTREAM PROXIES (arc / arcade / binjpipe / mixpanel) =======================
// Всё, что раньше делали location-пробросы в nginx, теперь обрабатывает сам сервер.
const ARCADE_UPSTREAM = "https://api.jackboxgames.com";
const BINJPIPE_UPSTREAM = "https://binjpipe.jackboxgames.com";
const MIXPANEL_UPSTREAM = "https://api-js.mixpanel.com";
const SITE_ROOT = CONFIG.siteRoot || process.env.SITE_ROOT || "/var/www/jacksiteNEW";

// Хост панели — основной сервер (CONFIG.host, jack.*); остальные хосты (jpp.*) — сайт-оболочка контроллера.
function isPanelHost(req) {
  const h = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
  const mainHost = String(accessibleHost || "").toLowerCase();
  return h === mainHost || h === "localhost" || h.startsWith("127.") || h === "0.0.0.0";
}

function proxyPreflight(req, res, opts = {}) {
  const origin = opts.echoOrigin ? (req.headers.origin || "*") : "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  if (opts.echoOrigin) res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Authorization, Content-Type, X-Arcade-Token, X-JBG-TEMP-AUTH, JBG-Content-Token, X-Requested-With, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function forwardUpstream(req, res, { upstream, stripPrefix, host, logTag, echoOrigin }) {
  try {
    if (req.method === "OPTIONS") { proxyPreflight(req, res, { echoOrigin }); return res.status(204).end(); }

    const body = await readRawBody(req);
    let rest = req.originalUrl.slice(stripPrefix.length);
    if (!rest.startsWith("/")) rest = "/" + rest;
    const url = upstream + rest;

    const headers = { ...req.headers };
    delete headers.host; delete headers["content-length"]; delete headers["connection"];
    delete headers["transfer-encoding"]; delete headers["accept-encoding"];
    if (host) headers.host = host;

    log(logTag, `[REQ] ${req.method} ${req.originalUrl} -> ${url}`);
    for (const [k, v] of Object.entries(req.headers)) log(logTag, `  > ${k}: ${v}`);
    if (body.length) log(logTag, `  > BODY(${body.length}): ${body.toString("utf8").slice(0, 20000)}`);

    const upstreamRes = await fetch(url, { method: req.method, headers, body: body.length ? body : undefined, redirect: "manual" });
    const respBody = Buffer.from(await upstreamRes.arrayBuffer());

    log(logTag, `[RESP] ${upstreamRes.status} ${req.method} ${req.originalUrl}`);
    for (const [k, v] of upstreamRes.headers.entries()) log(logTag, `  < ${k}: ${v}`);
    log(logTag, `  < BODY(${respBody.length}): ${respBody.toString("utf8").slice(0, 200000)}`);

    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (["transfer-encoding", "content-length", "content-encoding", "connection", "set-cookie"].includes(lk)) return;
      res.setHeader(k, v);
    });

    const setCookie = typeof upstreamRes.headers.getSetCookie === "function" ? upstreamRes.headers.getSetCookie() : [];
    if (setCookie.length) {
      res.setHeader("Set-Cookie", setCookie.map((c) =>
        c.replace(/;\s*domain=[^;]+/i, `; Domain=${req.hostname}`).replace(/;\s*secure\b/i, "; Secure")
      ));
    }

    proxyPreflight(req, res, { echoOrigin });
    res.setHeader("Content-Length", respBody.length);
    res.end(respBody);
  } catch (err) {
    log(logTag, `❌ proxy error: ${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: String(err.message || err) });
  }
}

app.use(async (req, res, next) => {
  if (!req.path.startsWith("/arc/") && !req.path.startsWith("/arcade/")) return next();
  try {
    if (req.method === "OPTIONS") { proxyPreflight(req, res); return res.status(204).end(); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    let upstreamPath = req.originalUrl.split("?")[0];
    if (upstreamPath.startsWith("/arc/")) upstreamPath = "/arcade" + upstreamPath.slice(4);
    const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    const url = ARCADE_UPSTREAM + upstreamPath + query;

    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    delete headers["connection"];
    delete headers["transfer-encoding"];
    delete headers["accept-encoding"];
    headers["origin"] = "";

    log("ARCADE", `[REQ] ${req.method} ${req.originalUrl} -> ${url}`);
    for (const [k, v] of Object.entries(req.headers)) log("ARCADE", `  > ${k}: ${v}`);
    if (body.length) log("ARCADE", `  > BODY(${body.length}): ${body.toString("utf8").slice(0, 20000)}`);

    const upstream = await fetch(url, { method: req.method, headers, body: body.length ? body : undefined });
    const respBody = Buffer.from(await upstream.arrayBuffer());

    log("ARCADE", `[RESP] ${upstream.status} ${req.method} ${req.originalUrl}`);
    for (const [k, v] of upstream.headers.entries()) log("ARCADE", `  < ${k}: ${v}`);
    log("ARCADE", `  < BODY(${respBody.length}): ${respBody.toString("utf8").slice(0, 200000)}`);

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!["transfer-encoding", "content-length", "content-encoding", "connection"].includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Length", respBody.length);
    res.end(respBody);
  } catch (err) {
    log("ARCADE", `❌ proxy error: ${err.message}`);
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.use(async (req, res, next) => {
  if (!req.path.startsWith("/binjpipe/")) return next();
  return forwardUpstream(req, res, { upstream: BINJPIPE_UPSTREAM, stripPrefix: "/binjpipe", host: "binjpipe.jackboxgames.com", logTag: "BINJPIPE", echoOrigin: true });
});

app.use(async (req, res, next) => {
  if (!req.path.startsWith("/mixpanel/")) return next();
  return forwardUpstream(req, res, { upstream: MIXPANEL_UPSTREAM, stripPrefix: "/mixpanel", host: "api-js.mixpanel.com", logTag: "MIXPANEL", echoOrigin: false });
});

app.use(async (req, res, next) => {
  if (!req.path.startsWith("/storage/")) return next();
  return proxyToJackbox(req, res, "STORAGE");
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use((req, res, next) => {
  const ip = getClientIP(req);
  log("HTTP →", `${req.method} ${req.originalUrl} | IP: ${ip}`,
    req.body && Object.keys(req.body).length > 0 ? req.body : null);
  const orig = res.json.bind(res);
  res.json = function(body) { res.__mirrorBody = body; log("HTTP ←", `${res.statusCode} ${req.originalUrl}`, body); return orig(body); };
  const origSend = res.send.bind(res);
  res.send = function(body) { if (res.__mirrorBody === undefined) res.__mirrorBody = body; return origSend(body); };
  if (mitmActive()) {
    res.on('finish', () => {
      try { mirrorHTTP(req, res); } catch (err) { log('MITM', `❌ mirrorHTTP: ${err.message}`); }
    });
  }
  next();
});

app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  const target = pickUpstreamTarget(req);
  if (target && req.originalUrl.startsWith("/api/")) {
    pruneUpstreamTargets();
    return proxyToTarget(req, res, target, "UPSTREAM");
  }
  next();
});

function checkToken(req, res, next) {
  if (req.headers["x-internal-token"] !== INTERNAL_TOKEN) return res.status(403).json({ error: "Forbidden" });
  next();
}

// ======================= ANTIBRUTE & ANTIDDOS ===================
const BRUTE_WINDOW = 15 * 60 * 1000;
const BRUTE_MAX_FAILS = 5;
const DDOS_WINDOW = 10 * 1000;
// Легитимный всплеск (телефон, пересоединение, загрузка ассетов, WS-апгрейды)
// легко превышает 30 запросов/10с — это банило хост на 30 минут и вешало игру
// (лицензия: фиббэйдже зависал на экране без итогов).
const DDOS_MAX_REQUESTS = 300;
const BAN_DURATION = 30 * 60 * 1000;

const failedLogins = new Map();
const requestCounts = new Map();
const bannedUntil = new Map();
const bannedIPs = new Set();
const BANS_FILE = "./data/bans.json";

function loadBans() {
  try {
    if (fs.existsSync(BANS_FILE)) {
      const raw = fs.readFileSync(BANS_FILE, "utf-8").trim();
      if (raw) JSON.parse(raw).forEach(ip => bannedIPs.add(ip));
    }
  } catch {}
  log("BANS", `📋 Loaded ${bannedIPs.size} permanent banned IPs`);
}

function saveBans() {
  try { fs.writeFileSync(BANS_FILE, JSON.stringify([...bannedIPs], null, 2)); } catch {}
}

loadBans();

const BAN_MESSAGE = (remaining) => {
  const mins = Math.ceil(remaining / 60000);
  return `{(ban):(Поздравляю, вы были забанены по айпи на ${mins} минут(заменяется по мере прохождения времени) за ваши проказы! :3 В отличии от клюквы я не баню тебя навсегда (хахаха опять постебали клюкву ыыыыы XDDD)}`;
};

function isBanned(ip) {
  if (bannedIPs.has(ip)) return true;
  const until = bannedUntil.get(ip);
  if (!until) return false;
  if (Date.now() >= until) { bannedUntil.delete(ip); return false; }
  return true;
}

function getBanRemaining(ip) {
  if (bannedIPs.has(ip)) return BAN_DURATION;
  const until = bannedUntil.get(ip);
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

function banIP(ip, reason) {
  bannedUntil.set(ip, Date.now() + BAN_DURATION);
  log("SECURITY", `🚫 BANNED ${ip} for 30min | Reason: ${reason}`);
}

function checkBruteForce(ip) {
  const record = failedLogins.get(ip);
  if (!record) return false;
  if (Date.now() - record.firstAttempt > BRUTE_WINDOW) { failedLogins.delete(ip); return false; }
  return record.count >= BRUTE_MAX_FAILS;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const record = failedLogins.get(ip);
  if (!record || (now - record.firstAttempt > BRUTE_WINDOW)) {
    failedLogins.set(ip, { count: 1, firstAttempt: now });
  } else {
    record.count++;
    failedLogins.set(ip, record);
  }
  const current = failedLogins.get(ip);
  log("SECURITY", `⚠️ Failed login from ${ip} (${current.count}/${BRUTE_MAX_FAILS})`);
  if (current.count >= BRUTE_MAX_FAILS) {
    banIP(ip, `brute force (${current.count} failed logins)`);
    return true;
  }
  return false;
}

function checkDDoS(ip) {
  const now = Date.now();
  const record = requestCounts.get(ip);
  if (!record || (now - record.windowStart > DDOS_WINDOW)) {
    requestCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  record.count++;
  requestCounts.set(ip, record);
  if (record.count > DDOS_MAX_REQUESTS) {
    banIP(ip, `DDoS (${record.count} requests in ${DDOS_WINDOW/1000}s)`);
    return true;
  }
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of failedLogins) {
    if (now - record.firstAttempt > BRUTE_WINDOW) failedLogins.delete(ip);
  }
  for (const [ip, record] of requestCounts) {
    if (now - record.windowStart > DDOS_WINDOW) requestCounts.delete(ip);
  }
  for (const [ip, until] of bannedUntil) {
    if (now >= until) bannedUntil.delete(ip);
  }
}, 5 * 60 * 1000);

app.use((req, res, next) => {
  const ip = getClientIP(req);
  if (isBanned(ip)) {
    const remaining = getBanRemaining(ip);
    log("SECURITY", `🚫 Blocked banned IP: ${ip}`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(403).send(BAN_MESSAGE(remaining));
  }
  if (checkDDoS(ip)) {
    log("SECURITY", `🛑 DDoS detected from ${ip} on ${req.method} ${req.originalUrl}`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(403).send(BAN_MESSAGE(BAN_DURATION));
  }
  next();
});

// ======================= USERS ===================
const USERS_FILE = "./data/users.json";
if (!fs.existsSync("./data")) fs.mkdirSync("./data");

function safeReadJSON(path, fallback) {
  try {
    if (!fs.existsSync(path)) { fs.writeFileSync(path, JSON.stringify(fallback, null, 2)); return fallback; }
    const raw = fs.readFileSync(path, "utf-8").trim();
    if (!raw) { fs.writeFileSync(path, JSON.stringify(fallback, null, 2)); return fallback; }
    return JSON.parse(raw);
  } catch { fs.writeFileSync(path, JSON.stringify(fallback, null, 2)); return fallback; }
}

const users = safeReadJSON(USERS_FILE, []);
function saveUsers() {
  try {
    const tmp = USERS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
    fs.renameSync(tmp, USERS_FILE);
  } catch {}
}
function hashPassword(p) { return crypto.createHash("sha256").update(p).digest("hex"); }

const sessions = new Map();
function generateSessionToken() { return crypto.randomBytes(32).toString("hex"); }

function requireAuth(req, res, next) {
  const token = req.headers["authorization"]?.replace("Bearer ", "");
  if (!token || !sessions.has(token)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const s = sessions.get(token);
  req.user = s.username; req.userIP = s.ip; req.userAdmin = isPanelAdmin(s.username);
  next();
}

// Глобальные админ-действия (баны, статус безопасности) — только adminLogins
function requirePanelAdmin(req, res, next) {
  if (!req.userAdmin) return res.status(403).json({ ok: false, error: "admin only" });
  next();
}

// Управление комнатой: админ — всё; обычный юзер — только если IP сессии == creatorIP
function canControlRoom(req, room) {
  if (!room) return false;
  if (req.userAdmin) return true;
  return !!room.creatorIP && room.creatorIP === req.userIP;
}

// ======================= AUTH ========================
app.post("/auth/register", (req, res) => {
  if (!PANEL.registrationEnabled && !isPanelAdmin(req.body?.username)) {
    log("AUTH", `🚫 Registration disabled (ip=${getClientIP(req)})`);
    return res.status(403).json({ ok: false, error: "registration disabled" });
  }
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, error: "missing credentials" });
  if (username.length < 3 || password.length < 4) return res.status(400).json({ ok: false, error: "username >= 3, password >= 4" });
  if (users.find(u => u.username === username)) return res.status(409).json({ ok: false, error: "exists" });
  users.push({ username, passwordHash: hashPassword(password), createdAt: Date.now() });
  saveUsers();
  const token = generateSessionToken();
  sessions.set(token, { username, ip: getClientIP(req) });
  res.json({ ok: true, body: { token, username, admin: isPanelAdmin(username) } });
});

app.post("/auth/login", (req, res) => {
  const ip = getClientIP(req);
  if (checkBruteForce(ip)) {
    log("SECURITY", `🚫 Brute force blocked: ${ip}`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(403).send(BAN_MESSAGE(getBanRemaining(ip)));
  }
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user || user.passwordHash !== hashPassword(password)) {
    const justBanned = recordFailedLogin(ip);
    if (justBanned) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(403).send(BAN_MESSAGE(BAN_DURATION));
    }
    return res.status(401).json({ ok: false, error: "invalid credentials" });
  }
  failedLogins.delete(ip);
  const token = generateSessionToken();
  sessions.set(token, { username, ip });
  log("AUTH", `✅ User logged in: ${username} from IP ${ip}${isPanelAdmin(username) ? " (admin)" : ""}`);
  res.json({ ok: true, body: { token, username, admin: isPanelAdmin(username) } });
});

app.post("/auth/logout", requireAuth, (req, res) => {
  sessions.delete(req.headers["authorization"].replace("Bearer ", ""));
  res.json({ ok: true });
});

app.get("/auth/me", requireAuth, (req, res) => res.json({ ok: true, body: { username: req.user, admin: !!req.userAdmin, registrationEnabled: PANEL.registrationEnabled } }));

app.post("/auth/change-password", requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ ok: false, error: "missing fields" });
  if (newPassword.length < 4) return res.status(400).json({ ok: false, error: "password >= 4" });
  const user = users.find(u => u.username === req.user);
  if (!user) return res.status(404).json({ ok: false, error: "user not found" });
  if (user.passwordHash !== hashPassword(oldPassword)) return res.status(401).json({ ok: false, error: "wrong old password" });
  user.passwordHash = hashPassword(newPassword);
  saveUsers();
  log("AUTH", `Password changed for ${req.user}`);
  res.json({ ok: true });
});

// ======================= HTTP API (Ecast) ========================
app.post("/api/v2/rooms", (req, res) => {
  const body = req.body || {};
  const appTag = body.appTag || body.apptag || body.tag || "jackboxpartypack3";
  const appId = resolveAppId(body);
  const maxPlayers = parseInt(body.maxPlayers) || parseInt(body.max) || 100;
  const userId = body.userId || body.userid || body.uid || generateUUID();
  const { audienceEnabled, password, moderatorPassword } = body;

  if (!body.appId && !body.appTag) {
    log("ROOM", `⚠️ POST /api/v2/rooms без appId/appTag от ${getClientIP(req)}, использую значения по умолчанию`, body);
  }

  const ip = getClientIP(req);
  const prepared = pickPreparedRoom(ip);
  let code, owner = null;
  if (prepared) { code = prepared.code; owner = prepared.owner; }
  else code = generateRoomCode();

  if (!owner) {
    for (const [token, session] of sessions) {
      if (session.ip === ip) { owner = session.username; break; }
    }
  }

  const room = createRoom(appId, appTag, maxPlayers, code, userId);
  room.gamePassword = password || null;
  room.moderatorPassword = moderatorPassword || null;
  room.audienceEnabled = audienceEnabled === true;
  room.twitchRequired = body.twitchLocked === true || body.twitchRequired === true || body.requireTwitch === true;
  room.owner = owner;
  room.creatorIP = ip;
  rooms.set(code, room);

  log("ROOM", `Created: ${code} (${appTag})`, { owner, creatorIP: ip, twitch: room.twitchRequired });
  const resp = { host: accessibleHost, code, token: room.hostToken };
  res.json({ ok: true, body: { ...resp }, ...resp });
});

app.get("/api/v2/app-configs/:gameName", (req, res) => {
  res.json({ ok: true, body: { settings: { serverUrl: accessibleHost } } });
});

app.get("/api/v2/rooms/:code", (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (room && isUnknownGameTag(room.appTag)) {
    log("ROOM", `🚫 GET /rooms/${room.roomCode}: game "${room.appTag}" not found on this site -> 404`);
    return res.status(404).json({ ok: false, error: "no such room" });
  }
  if (room) {
    const totalPlayers = room.players.size + room.disconnectedPlayers.size;
    const isFull = totalPlayers >= room.maxPlayers;
    const gameStarted = room.locked || room.gameStarted;
    const audienceEnabled = room.audienceEnabled || isFull || gameStarted;

    return res.json({
      ok: true,
      body: {
        appId: room.appId, appTag: room.appTag,
        audienceEnabled, code: room.roomCode,
        host: accessibleHost, audienceHost: accessibleHost,
        locked: room.locked, full: isFull,
        maxPlayers: room.maxPlayers, minPlayers: room.minPlayers,
        moderationEnabled: MODERATION_TAGS.has(room.appTag),
        passwordRequired: !!room.gamePassword,
        twitchLocked: !!(room.twitchRequired && twitchEnabled()), locale: "en", keepalive: false,
        controllerBranch: ""
      }
    });
  }

  const blob = blobcastRooms.get(req.params.code.toUpperCase());
  if (blob && isUnknownGameTag(blob.appTag)) {
    log("ROOM", `🚫 GET /rooms/${blob.code}: game "${blob.appTag}" not found on this site -> 404`);
    return res.status(404).json({ ok: false, error: "no such room" });
  }
  if (blob) {
    return res.json({
      ok: true,
      body: {
        appId: blob.appId || "", appTag: blob.appTag || "",
        audienceEnabled: !!blob.audienceEnabled, code: blob.code,
        host: accessibleHost, audienceHost: accessibleHost,
        locked: !!blob.locked, full: false,
        maxPlayers: blob.maxPlayers || 0, minPlayers: 0,
        moderationEnabled: MODERATION_TAGS.has(blob.appTag),
        passwordRequired: !!blob.password,
        twitchLocked: !!(blob.twitchRequired && twitchEnabled()), locale: "en", keepalive: false,
        controllerBranch: ""
      }
    });
  }

  return res.status(404).json({ ok: false, error: "no such room" });
});

app.get("/api/v2/rooms/:code/preflight", (req, res) => {
  const reg = findRoomAnyRegistry(req.params.code);
  if (!reg || isUnknownGameTag(reg.appTag)) {
    return res.status(404).json({ ok: false, error: "no such room" });
  }
  res.status(204).end();
});

// ======================= BLOBCAST (Socket.IO v1) ===================
const blobcastSessions = new Map();
const blobcastRooms = new Map();

class BlobcastRoom {
  constructor(code) {
    this.code = code;
    this.entities = new Map();
    this.connections = new Map();
    this.locked = false;
    this.created = Date.now();
    this.accessToken = crypto.randomBytes(12).toString('hex');
    this.userId = null;
    this.completed = false;
    this.appId = null;
    this.appTag = null;
    this.audienceEnabled = false;
    this.password = null;
    this.twitchRequired = false;
    this.maxPlayers = 0;
    this.hostSession = null;
    this.pc = 0;
    this.clients = new Map();
    this.audienceSockets = new Set();
    this.audienceNextId = 10000;
    this.voteEntities = new Map();
  }
}

function findRoomAnyRegistry(code) {
  const c = String(code).toUpperCase();
  return rooms.get(c) || blobcastRooms.get(c) || null;
}

function generateBlobcastToken(seed) {
  const hash = crypto.createHash('sha256').update(seed + Date.now() + Math.random()).digest('hex');
  return hash.substring(0, 24);
}

// GET /socket.io/1?t=123456
app.get("/socket.io/1", (req, res) => {
  const seed = req.query.t || Date.now().toString();
  const token = generateBlobcastToken(seed);
  
  log("BLOBcast", `🔌 Socket.IO handshake: token=${token}`, { seed });
  
  blobcastSessions.set(token, {
    token,
    room: null,
    socket: null,
    lastPing: Date.now()
  });
  
  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send(`${token}:60:60:websocket`);
});

// POST /accessToken (legacy blobcast; tjpp 3,4,5,6)
app.post("/accessToken", (req, res) => {
  const body = req.body || {};
  const roomId = body.roomId ? String(body.roomId).toUpperCase() : null;
  if (!roomId) {
    return res.status(400).json({ ok: false, error: "form body missing one or more required parameters: roomId" });
  }
  const room = blobcastRooms.get(roomId);
  if (!room) {
    return res.status(400).json({ ok: false, error: "can't create access token for non-existent room" });
  }
  if (body.userId && room.userId && String(body.userId) !== room.userId) {
    return res.status(401).json({ ok: false, error: "won't serve access token to non room owner" });
  }
  log("BLOBcast", `🔑 accessToken issued for room ${roomId}`);
  res.json({ success: true, accessToken: room.accessToken });
});

// ======================= OTHER HTTP API ===================
app.post("/admin/rooms/:code/audience", checkToken, (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: "Room not found" });
  room.audienceEnabled = req.body.enabled === true;
  res.json({ success: true, audienceEnabled: room.audienceEnabled });
});

app.post("/api/v2/rooms/custom", requireAuth, (req, res) => {
  const { roomCode } = req.body;
  if (!roomCode?.trim()) return res.status(400).json({ ok: false, error: "roomCode required" });
  preparedRooms.set(req.userIP, { code: roomCode.trim().toUpperCase(), owner: req.user, createdAt: Date.now() });
  res.json({ ok: true, body: { code: roomCode.trim().toUpperCase(), ip: req.userIP } });
});

app.patch("/api/v2/rooms/custom", requireAuth, (req, res) => {
  const { oldIp, newIp } = req.body;
  if (!oldIp || !newIp) return res.status(400).json({ ok: false, error: "oldIp and newIp required" });
  const prep = preparedRooms.get(oldIp);
  if (!prep) return res.status(404).json({ ok: false, error: "not found" });
  if (!req.userAdmin && !(oldIp === req.userIP && prep.owner === req.user)) return res.status(403).json({ ok: false, error: "forbidden" });
  preparedRooms.delete(oldIp);
  preparedRooms.set(newIp, { ...prep, ip: newIp });
  log("ROOM", `IP changed: ${oldIp} -> ${newIp} by ${req.user}`);
  res.json({ ok: true });
});

app.get("/api/v2/my-rooms", requireAuth, (req, res) => {
  const active = [...rooms.values()]
    .filter(r => canControlRoom(req, r))
    .map(r => ({
      code: r.roomCode, appTag: r.appTag, appId: r.appId,
      players: r.players.size, maxPlayers: r.maxPlayers,
      host: !!r.host, locked: r.locked,
      audienceEnabled: r.audienceEnabled,
      twitchRequired: !!r.twitchRequired,
      moderators: r.moderators?.size || 0,
      minPlayers: r.minPlayers,
      gameStarted: r.gameStarted || false,
      owner: r.owner,
      isOwned: r.owner === req.user,
      created: r.created, status: "active"
    }));
  const prepared = [...preparedRooms.entries()]
    .filter(([ip, p]) => req.userAdmin || (ip === req.userIP && p.owner === req.user))
    .map(([ip, p]) => ({ code: p.code, ip, created: p.createdAt, status: "prepared", active: rooms.has(p.code) }));
  res.json({ ok: true, body: { active, prepared } });
});

app.delete("/api/v2/rooms/custom/:ip", requireAuth, (req, res) => {
  const key = decodeURIComponent(req.params.ip);
  const prep = preparedRooms.get(key);
  if (!prep) return res.status(404).json({ ok: false, error: "not found" });
  if (!req.userAdmin && !(key === req.userIP && prep.owner === req.user)) return res.status(403).json({ ok: false, error: "forbidden" });
  preparedRooms.delete(key);
  res.json({ ok: true });
});

app.delete("/api/v2/rooms/:code", requireAuth, (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ ok: false, error: "not found" });
  if (!canControlRoom(req, room)) return res.status(403).json({ ok: false, error: "forbidden" });
  if (room.host) try { room.host.terminate(); } catch {}
  for (const [, p] of room.players) if (p.socket) try { p.socket.terminate(); } catch {}
  for (const [, m] of room.moderators) if (m.socket) try { m.socket.terminate(); } catch {}
  for (const [, a] of room.audience) if (a.socket) try { a.socket.terminate(); } catch {}
  room.disconnectedTimers.forEach(t => clearTimeout(t));
  rooms.delete(code);
  res.json({ ok: true });
});

app.get("/api/v2/rooms/:code/info", (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ ok: false, error: "no such room" });
  if (isUnknownGameTag(room.appTag)) {
    log("ROOM", `🚫 GET /rooms/${room.roomCode}/info: game "${room.appTag}" not found on this site -> 404`);
    return res.status(404).json({ ok: false, error: "no such room" });
  }

  const totalPlayers = room.players.size + room.disconnectedPlayers.size;
  const isFull = totalPlayers >= room.maxPlayers;
  const gameStarted = room.locked || room.gameStarted;

  // Игровые клиенты (без Bearer-токена) — QA-формат ответа
  if (!req.headers.authorization) {
    return res.json({
      roomid: room.roomCode,
      server: accessibleHost,
      apptag: room.appTag,
      appid: room.appId,
      numAudience: room.audience.size,
      audienceEnabled: room.audienceEnabled || isFull || gameStarted,
      joinAs: req.query.role === "audience" || req.query.joinAs === "audience" ? "audience" : "player",
      requiresPassword: !!room.gamePassword
    });
  }

  // Дашборд (с Bearer-токеном) — админ-формат
  const token = req.headers.authorization.replace("Bearer ", "");
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ ok: false, error: "unauthorized" });
  req.user = session.username; req.userIP = session.ip; req.userAdmin = isPanelAdmin(session.username);
  if (!canControlRoom(req, room)) return res.status(403).json({ ok: false, error: "forbidden" });

  res.json({
    ok: true,
    body: {
      appId: room.appId, appTag: room.appTag,
      players: room.players.size, maxPlayers: room.maxPlayers, minPlayers: room.minPlayers,
      moderators: room.moderators.size,
      host: !!room.host, locked: room.locked,
      twitchRequired: !!room.twitchRequired,
      audienceEnabled: room.audienceEnabled || isFull || gameStarted,
      gamePassword: room.gamePassword, moderatorPassword: room.moderatorPassword,
      owner: room.owner, created: room.created
    }
  });
});

app.post("/api/v2/rooms/:code/settings", requireAuth, (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ ok: false, error: "not found" });
  if (!canControlRoom(req, room)) return res.status(403).json({ ok: false, error: "forbidden" });
  applyRoomSettings(room, req.body);
  if (room.host) try { room.host.send(JSON.stringify({ pc: room.pcHost++, opcode: "room/settings", result: req.body })); } catch {}
  res.json({ ok: true });
});

app.post("/api/v2/rooms/:code/claim", requireAuth, (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ ok: false, error: "room not found" });
  if (!req.userAdmin && room.creatorIP !== req.userIP) return res.status(403).json({ ok: false, error: "only from creator IP" });
  if (room.owner && room.owner !== req.user && !req.userAdmin) return res.status(403).json({ ok: false, error: "room already owned" });
  room.owner = req.user;
  log("ROOM", `${req.user} claimed room ${room.roomCode}`);
  res.json({ ok: true, body: { code: room.roomCode, owner: req.user } });
});

app.post("/api/v2/rooms/:code/fake-player", requireAuth, (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room || !canControlRoom(req, room)) return res.status(404).json({ ok: false, error: "not found" });
  const { name, count = 1 } = req.body;
  const added = [];
  for (let i = 0; i < count; i++) {
    const playerName = name && count === 1 ? name : `${name || 'FAKE'}_${room.nextPlayerId}`;
    const id = room.nextPlayerId++;
    room.players.set(id, { id, name: playerName, socket: null, secret: generateUUID() });
    room.pcPlayers.set(id, 0);
    added.push({ id, name: playerName });
  }
  res.json({ ok: true, added, totalPlayers: room.players.size });
});

app.get("/uuid/image.png", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  res.json({ jbg_id: crypto.randomUUID() });
});

// ======================= SURVIVE THE INTERNET PHOTOS ===================
// Мод «Выжить в Мемтернете» отдаёт контент с runtime-именами вида
// images/survivetheinternet/photos/CatAYaZnau[-thumb].jpg (базовое имя + случайный суффикс).
// CSS мапит базовые имена на hashed-ассеты; здесь мы обслуживаем любые такие запросы,
// сопоставляя токен с ближайшим известным именем фото и отдавая локальную картинку.
const STE_PHOTO_MAP = (() => {
  try {
    return JSON.parse(fs.readFileSync("/root/jack/data/ste-photo-map.json", "utf-8")).photos || {};
  } catch { return {}; }
})();
const STE_PHOTO_NAMES = Object.keys(STE_PHOTO_MAP).sort((a, b) => b.length - a.length);

app.get(/\/images\/survivetheinternet\/photos\/([A-Za-z0-9_-]+)\.(jpg|jpeg|png|webp)$/i, (req, res, next) => {
  const raw = req.params[0];
  const isThumb = raw.endsWith("-thumb");
  const token = isThumb ? raw.slice(0, -"-thumb".length) : raw;

  let name = null;
  if (STE_PHOTO_MAP[token]) name = token;
  else {
    for (const n of STE_PHOTO_NAMES) {
      if (token.startsWith(n)) { name = n; break; }
    }
  }
  if (!name) return next();

  const entry = STE_PHOTO_MAP[name];
  const rel = isThumb ? (entry.thumb || entry.final) : (entry.final || entry.thumb);
  if (!rel) return next();
  if (rel.includes("..")) return next();

  const abs = SITE_ROOT + "/" + rel.replace(/^\//, "");
  if (!fs.existsSync(abs)) return next();

  log("STE-PHOTOS", `📷 "${token}" -> ${name}${isThumb ? " (thumb)" : ""} => ${rel} (${req.originalUrl})`);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  return res.sendFile(abs);
});

const TWITCH_LOGIN_JS = `
window.__twitchLogin=function(){
  var TTG="https://twitchtokengenerator.com";
  var SCOPES="chat:read+chat:edit+user:read:chat";
  var win=window.open("about:blank","ttg");
  function b64(s){return btoa(unescape(encodeURIComponent(s)));}
  (async function(){
    try{
      var res=await fetch(TTG+"/api/create/"+b64("FRbox")+"/"+SCOPES+"?_="+Date.now(),{cache:"no-store"});
      var flow=await res.json();
      if(!flow||!flow.success)throw new Error((flow&&flow.message)||"create failed");
      var reg=await fetch("/twitch/flow",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:flow.id})}).then(function(r){return r.json();}).catch(function(){return null;});
      var key=(reg&&reg.key)||"";
      try{sessionStorage.setItem("twitch_flow",JSON.stringify({id:flow.id,key:key}));}catch(e){}
      if(win&&!win.closed){win.location=flow.message;}else{window.open(flow.message,"_blank");}
      var deadline=Date.now()+15*60*1000;
      for(;;){
        var q="/twitch/flow/status?id="+encodeURIComponent(flow.id)+(key?"&key="+encodeURIComponent(key):"");
        var fr=await fetch(q,{cache:"no-store"}).then(function(r){return r.json();}).catch(function(){return null;});
        var f=fr&&fr.flow;
        if(f&&f.status==="ok"&&f.token){
          localStorage.setItem("tv:token",f.token);
          if(win&&!win.closed){try{win.close();}catch(e){}}
          window.location.reload();
          return;
        }
        if(f&&(f.status==="error"||f.status==="timeout")){alert("Twitch: "+(f.error||f.status));return;}
        if(Date.now()>deadline){alert("Twitch: время ожидания истекло");return;}
        await new Promise(function(r){setTimeout(r,2500);});
      }
    }catch(e){alert("Twitch login: "+e.message);}
  })();
};
`;

// Динамический конфиг Twitch для контроллера (читает config.json -> twitch).
// Клиентский бандл берёт отсюда client id и тестовый токен; при пустом clientId работает заглушка.
app.get("/twitch-config.js", (req, res) => {
  res.type("application/javascript");
  res.setHeader("Cache-Control", "no-store");
  res.send(
    `window.__TWITCH_CLIENT_ID__=${JSON.stringify(TWITCH.clientId)};` +
    `window.__TWITCH_TEST_TOKEN__=${JSON.stringify(TWITCH.testToken)};` +
    TWITCH_LOGIN_JS
  );
});

const twitchFlowDir = (CONFIG.twitch && CONFIG.twitch.flowDir)
  ? String(CONFIG.twitch.flowDir)
  : fileURLToPath(new URL("./twitch-auth/results/", import.meta.url));
const twitchFlows = new Map();

function twitchPollFlow(id) {
  const existing = twitchFlows.get(id);
  if (existing) return existing;
  const rec = { id, status: "pending", started: Date.now() };
  twitchFlows.set(id, rec);
  const deadline = Date.now() + 15 * 60 * 1000;
  (async () => {
    for (;;) {
      let s = null;
      try {
        const r = await fetch("https://twitchtokengenerator.com/api/status/" + id + "?_=" + Date.now(), { headers: { "Cache-Control": "no-store" } });
        s = await r.json().catch(() => null);
      } catch (e) {}
      if (s && s.success) {
        Object.assign(rec, { status: "ok", at: new Date().toISOString(), token: s.token, refresh: s.refresh, username: s.username, user_id: s.user_id, scopes: s.scopes, client_id: s.client_id });
        try {
          fs.mkdirSync(twitchFlowDir, { recursive: true });
          fs.writeFileSync(twitchFlowDir + id + ".json", JSON.stringify(rec, null, 2));
        } catch (e) {}
        log("TWITCH", "flow " + id + " authorized user=" + s.username);
        return;
      }
      if (s && s.error === 3) {
        if (Date.now() > deadline) { Object.assign(rec, { status: "timeout" }); return; }
      } else {
        Object.assign(rec, { status: "error", error: (s && s.message) || "status error" });
        log("TWITCH", "flow " + id + " error: " + rec.error);
        return;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
  })();
  return rec;
}

function twitchSafeFlow(rec) {
  return { id: rec.id, status: rec.status, started: rec.started, at: rec.at, username: rec.username, user_id: rec.user_id, scopes: rec.scopes, error: rec.error };
}

app.post("/twitch/flow", (req, res) => {
  const id = req.body && String(req.body.id || "");
  if (!/^[a-z0-9]{10,40}$/.test(id)) return res.status(400).json({ success: false, message: "invalid flow id" });
  const rec = twitchPollFlow(id);
  if (!rec.key) rec.key = crypto.randomBytes(16).toString("hex");
  log("TWITCH", "flow registered " + id + " (" + rec.status + ")");
  res.json({ success: true, id, status: rec.status, key: rec.key });
});

app.get("/twitch/flow/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const id = req.query && req.query.id ? String(req.query.id) : "";
  if (id) {
    const rec = twitchFlows.get(id);
    if (!rec) return res.json({ success: true, flow: null });
    const authed = rec.key && req.query.key && String(req.query.key) === rec.key;
    return res.json({ success: true, flow: authed ? rec : twitchSafeFlow(rec) });
  }
  const flows = [...twitchFlows.values()].sort((a, b) => b.started - a.started).map(twitchSafeFlow);
  res.json({ success: true, flows });
});

app.post("/twitch/forget", (req, res) => {
  const id = req.body && String(req.body.id || "");
  if (id) {
    const rec = twitchFlows.get(id);
    if (rec && (!rec.key || String((req.body && req.body.key) || "") === rec.key)) twitchFlows.delete(id);
    try { fs.unlinkSync(twitchFlowDir + id + ".json"); } catch (e) {}
  } else {
    for (const fid of [...twitchFlows.keys()]) twitchFlows.delete(fid);
    try {
      for (const f of fs.readdirSync(twitchFlowDir)) {
        if (f.endsWith(".json")) { try { fs.unlinkSync(twitchFlowDir + f); } catch (e) {} }
      }
    } catch (e) {}
  }
  log("TWITCH", "forget " + (id || "all"));
  res.json({ success: true });
});

app.post("/twitch/validate", async (req, res) => {
  const token = req.body && (req.body.access_token || req.body.token);
  if (!token) return res.status(400).json({ success: false, message: "access_token is required" });
  let ttg = null, twitch = null;
  try {
    const r = await fetch("https://twitchtokengenerator.com/api/v2/tokens/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ access_token: token })
    });
    ttg = { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
  } catch (e) { ttg = { ok: false, status: 0, error: e.message }; }
  try {
    const r = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: "OAuth " + token } });
    twitch = { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
  } catch (e) { twitch = { ok: false, status: 0, error: e.message }; }
  log("TWITCH", "validate " + String(token).slice(0, 6) + "... ttg=" + ttg.ok + " twitch=" + twitch.ok);
  res.json({ success: !!(twitch.ok || ttg.ok), ttg, twitch });
});

// Панель (public/) — на корне основного сервера; на других хостах (jpp.*) — сайт-оболочка контроллера (SITE_ROOT).
app.use((req, res, next) => {
  const panelFirst = isPanelHost(req);
  const first = panelFirst ? express.static("public") : express.static(SITE_ROOT, { index: "index.html" });
  const second = panelFirst ? express.static(SITE_ROOT, { index: "index.html" }) : express.static("public");
  first(req, res, (err) => (err ? next(err) : second(req, res, next)));
});

// ======================= LEGACY /room ENDPOINT ===================
// QA-совместимо: GET /room ВСЕГДА отвечает healthcheck {create, server},
// query code полностью игнорируется (проверено на ecast-qa.jackboxgames.com)
app.get("/room", (req, res) => {
  const roomCode = (req.query.code || req.query.roomCode || req.query.room || '').toUpperCase();
  log("LEGACY", `✅ GET /room${roomCode ? ` code=${roomCode}` : ""} (healthcheck) from ${getClientIP(req)}`);
  res.json({ create: true, server: accessibleHost });
});

app.post("/room", (req, res) => {
  const body = req.body || {};
  const appTag = body.appTag || body.apptag || body.tag || "jackboxpartypack3";
  const appId = resolveAppId(body);
  const maxPlayers = parseInt(body.maxPlayers) || parseInt(body.max) || 100;
  const userId = body.userId || body.userid || body.uid || generateUUID();
  const { audienceEnabled, password } = body;

  if (!body.appId && !body.appTag) {
    log("LEGACY", `⚠️ POST /room без appId/appTag от ${getClientIP(req)}, использую значения по умолчанию`, {
      contentType: req.headers['content-type'], body
    });
  }

  const ip = getClientIP(req);
  const prepared = pickPreparedRoom(ip);
  let code, owner = null;
  if (prepared) { code = prepared.code; owner = prepared.owner; }
  else code = generateRoomCode();

  if (!owner) {
    for (const [token, session] of sessions) {
      if (session.ip === ip) { owner = session.username; break; }
    }
  }

  const room = createRoom(appId, appTag, maxPlayers, code, userId);
  room.gamePassword = password || null;
  room.audienceEnabled = audienceEnabled === true;
  room.owner = owner;
  room.creatorIP = ip;
  rooms.set(code, room);

  log("LEGACY", `✅ POST /room created ${code} (${appTag})`, { owner, creatorIP: ip });
  const resp = { host: accessibleHost, code, token: room.hostToken };
  res.json({ ok: true, body: { ...resp }, ...resp });
});

// ======================= ADMIN API =======================
app.get("/admin/rooms", checkToken, (_, res) => {
  res.json([...rooms.values()].map(r => ({ code: r.roomCode, appTag: r.appTag, players: r.players.size, host: !!r.host })));
});

app.get("/admin/rooms/:code", checkToken, (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: "Not found" });
  res.json({
    code: room.roomCode, appTag: room.appTag,
    players: room.players.size, moderators: room.moderators.size, audience: room.audience.size,
    locked: room.locked, gameStarted: room.gameStarted,
    gamePassword: room.gamePassword, moderatorPassword: room.moderatorPassword,
    playerList: [...room.players.values()].map(p => ({ id: p.id, name: p.name })),
    audienceList: [...room.audience.values()].map(a => ({ id: a.id, name: a.name }))
  });
});

app.delete("/admin/rooms/:code", checkToken, (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (room) {
    if (room.host) try { room.host.terminate(); } catch {}
    for (const [, p] of room.players) if (p.socket) try { p.socket.terminate(); } catch {}
    for (const [, m] of room.moderators) if (m.socket) try { m.socket.terminate(); } catch {}
    for (const [, a] of room.audience) if (a.socket) try { a.socket.terminate(); } catch {}
    room.disconnectedTimers.forEach(t => clearTimeout(t));
  }
  rooms.delete(req.params.code.toUpperCase());
  res.json({ success: true });
});

app.get("/admin/stats", requireAuth, requirePanelAdmin, (req, res) => {
  const memUsage = process.memoryUsage();
  let totalPlayers = 0, totalAudience = 0, roomsWithHost = 0;
  for (const r of rooms.values()) {
    totalPlayers += r.players.size;
    totalAudience += r.audience.size;
    if (r.host) roomsWithHost++;
  }
  res.json({
    ok: true,
    body: {
      rooms: rooms.size, roomsWithHost, players: totalPlayers, audience: totalAudience,
      prepared: preparedRooms.size, banned: bannedIPs.size + bannedUntil.size,
      blobcast: blobcastSessions.size,
      uptime: process.uptime(),
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024)
      }
    }
  });
});

app.post("/admin/ban-ip", requireAuth, requirePanelAdmin, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ ok: false, error: "ip required" });
  bannedIPs.add(ip);
  bannedUntil.set(ip, Date.now() + BAN_DURATION);
  saveBans();
  log("BANS", `🚫 ${req.user} banned IP ${ip}`);
  res.json({ ok: true, banned: ip });
});

app.delete("/admin/ban-ip/:ip", requireAuth, requirePanelAdmin, (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  bannedIPs.delete(ip);
  bannedUntil.delete(ip);
  saveBans();
  log("BANS", `✅ ${req.user} unbanned IP ${ip}`);
  res.json({ ok: true });
});

app.get("/admin/bans", requireAuth, requirePanelAdmin, (req, res) => {
  res.json({ ok: true, body: [...bannedIPs] });
});

app.get("/admin/security/status", requireAuth, requirePanelAdmin, (req, res) => {
  const now = Date.now();
  const activeBans = [];
  for (const [ip, until] of bannedUntil) {
    if (now < until) activeBans.push({ ip, remaining: Math.ceil((until - now) / 60000), expiresAt: new Date(until).toISOString() });
  }
  const bruteAttempts = [];
  for (const [ip, record] of failedLogins) {
    if (now - record.firstAttempt < BRUTE_WINDOW) bruteAttempts.push({ ip, fails: record.count, max: BRUTE_MAX_FAILS });
  }
  const ddosActive = [];
  for (const [ip, record] of requestCounts) {
    if (now - record.windowStart < DDOS_WINDOW && record.count > DDOS_MAX_REQUESTS * 0.5) {
      ddosActive.push({ ip, requests: record.count, max: DDOS_MAX_REQUESTS, window: `${DDOS_WINDOW/1000}s` });
    }
  }
  res.json({
    ok: true,
    body: {
      bans: activeBans, bruteAttempts, ddosWarnings: ddosActive,
      config: {
        bruteWindow: `${BRUTE_WINDOW/60000}min`,
        bruteMaxFails: BRUTE_MAX_FAILS,
        ddosWindow: `${DDOS_WINDOW/1000}s`,
        ddosMaxRequests: DDOS_MAX_REQUESTS,
        banDuration: `${BAN_DURATION/60000}min`
      }
    }
  });
});

app.post("/admin/security/ban", requireAuth, requirePanelAdmin, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ ok: false, error: "ip required" });
  banIP(ip, `manual ban by ${req.user}`);
  res.json({ ok: true });
});

app.post("/admin/security/unban", requireAuth, requirePanelAdmin, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ ok: false, error: "ip required" });
  bannedUntil.delete(ip);
  failedLogins.delete(ip);
  requestCounts.delete(ip);
  log("SECURITY", `✅ ${req.user} manually unbanned ${ip}`);
  res.json({ ok: true });
});

app.get("/admin/xray/status", requireAuth, requirePanelAdmin, (req, res) => {
  res.json({
    ok: true,
    body: {
      isRunning: xrayManager.isRunning,
      currentServer: xrayManager.currentServer ? {
        name: xrayManager.currentServer.name,
        address: xrayManager.currentServer.address,
        port: xrayManager.currentServer.port,
        type: xrayManager.currentServer.type
      } : null,
      totalServers: xrayManager.servers.length,
      servers: xrayManager.servers.map(s => ({ name: s.name, type: s.type, address: s.address, port: s.port }))
    }
  });
});

// ======================= PROXY LOG API ===================
app.get("/admin/proxy-log", checkToken, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const source = req.query.source;
  let entries = proxyLog.slice(-limit).reverse();
  if (source) entries = entries.filter(e => e.source === source);
  res.json({ ok: true, body: { entries, total: proxyLog.length } });
});

app.get("/admin/proxy-log/download", checkToken, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="proxy-log.json"');
  res.send(JSON.stringify(proxyLog, null, 2));
});

app.post("/admin/proxy-log/clear", checkToken, (req, res) => {
  proxyLog.length = 0;
  try { fs.writeFileSync(PROXY_LOG_FILE, '[]'); } catch {}
  log("ADMIN", `Cleared proxy log`);
  res.json({ ok: true });
});

// ======================= MITM API ===================
app.get("/admin/mitm", checkToken, (_, res) => {
  res.json({ ok: true, body: { enabled: MITM.enabled, mirrorUrl: MITM.mirrorUrl, active: mitmActive() } });
});

app.post("/admin/mitm", checkToken, (req, res) => {
  if (typeof req.body.enabled === 'boolean') MITM.enabled = req.body.enabled;
  if (typeof req.body.mirrorUrl === 'string' && req.body.mirrorUrl.trim()) {
    MITM.mirrorUrl = req.body.mirrorUrl.trim().replace(/\/+$/, '');
    try { MITM.parsed = new URL(MITM.mirrorUrl); } catch { MITM.parsed = null; }
  }
  log("MITM", `🔄 Runtime: enabled=${MITM.enabled} mirrorUrl=${MITM.mirrorUrl}`);
  res.json({ ok: true, body: { enabled: MITM.enabled, mirrorUrl: MITM.mirrorUrl, active: mitmActive() } });
});

// ======================= TTS ROUTES ====================
app.get("/tts/status", (req, res) => {
  const engines = {};
  for (const m of TTS_ENGINES) engines[m] = ttsModeReady(m);
  res.json({ ok: true, body: { mode: TTS.mode, upstream: TTS.upstream, cacheDir: TTS.cacheDir, engines } });
});

app.post("/tts/generate", (req, res) => { ttsHandleGenerate(req, res); });

app.get("/tts/files/:file", (req, res) => {
  const file = String(req.params.file || "");
  if (!/^[a-f0-9]{40}\.mp3$/.test(file)) return res.status(400).json({ error: "bad file" });
  const p = `${TTS.cacheDir}/${file}`;
  if (!fs.existsSync(p)) return res.status(404).json({ error: "not found" });
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  fs.createReadStream(p).pipe(res);
});

// runtime-переключение: POST /admin/tts {"mode":"yandex"|...} (x-internal-token)
app.post("/admin/tts", checkToken, (req, res) => {
  const b = req.body || {};
  if (typeof b.mode === "string" && TTS_ENGINES.has(b.mode.toLowerCase())) TTS.mode = b.mode.toLowerCase();
  if (typeof b.upstream === "string" && ["ecast", "mirror"].includes(b.upstream.toLowerCase())) TTS.upstream = b.upstream.toLowerCase();
  if (b.cloud && typeof b.cloud === "object") {
    for (const [k, v] of Object.entries(b.cloud)) {
      if (v && typeof v === "object") TTS.cloud[k] = Object.assign({}, TTS.cloud[k] || {}, v);
    }
  }
  log("TTS", `🔄 Runtime: mode=${TTS.mode} upstream=${TTS.upstream} ready=${ttsModeReady(TTS.mode)}`);
  res.json({ ok: true, body: { mode: TTS.mode, upstream: TTS.upstream, ready: ttsModeReady(TTS.mode) } });
});

// ======================= CATCH-ALL PROXY ===================
app.use(async (req, res) => {
  const path = req.originalUrl;
  
  if (path.startsWith('/auth/') || path.startsWith('/api/') || path.startsWith('/admin/') || 
      path === '/room' || path.startsWith('/room?') ||
      path.startsWith('/socket.io/')) {
    return res.status(404).json({ ok: true, body: {} });
  }

  // SPA-фолбэк: навигационные запросы к сайту отдаём из index.html (аналог nginx try_files)
  if ((req.method === "GET" || req.method === "HEAD") && req.accepts("html")) {
    const panelIndex = fileURLToPath(new URL("./public/index.html", import.meta.url));
    const indexPath = isPanelHost(req) ? panelIndex : SITE_ROOT + "/index.html";
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  }
  
  await proxyToJackbox(req, res, "CATCH-ALL");
});

// ======================= HTTP SERVER =====================
const server = http.createServer(app);

// ======================= BLOBCAST WEBSOCKET ===================
const blobcastWss = new WebSocketServer({ noServer: true });

blobcastWss.on('connection', (ws, req, token) => {
  const session = blobcastSessions.get(token);
  if (!session) {
    ws.terminate();
    return;
  }
  
  session.socket = ws;
  
  log("BLOBcast", `🔌 Socket.IO connected: token=${token}`);
  
  // Отправляем начальный пакет Socket.IO: 1::
  ws.send('1::');
  
  // Ping каждые 5 секунд (формат socket.io 0.9 heartbeat: "2::")
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('2::');
      session.lastPing = Date.now();
    }
  }, 5000);
  
  ws.on('message', (data) => {
    const message = data.toString();
    log("BLOBcast", `📨 Socket.IO message: ${message.substring(0, 200)}`);
    
    // Парсим Socket.IO пакет: 5:::JSON
    if (message.startsWith('5:::')) {
      try {
        const json = JSON.parse(message.substring(4));
        handleBlobcastMessage(session, json);
      } catch (err) {
        log("BLOBcast", `❌ Failed to parse message: ${err.message}`);
      }
    }
  });
  
  ws.on('close', () => {
    log("BLOBcast", `❌ Socket.IO disconnected: token=${token}`);
    clearInterval(pingInterval);
    
    if (session.room) {
      session.room.connections.delete(token);
      
      // Уведомляем ecast-контроллеров, что хост ушёл
      if (session.room.hostSession === session) {
        const blob = session.room;
        for (const client of blob.clients.values()) {
          if (client.role === 'host' || !client.connected || !client.socket) continue;
          if (client.socket.readyState === WebSocket.OPEN) {
            blobEcastSend(blob, client.socket, {
              opcode: 'client/disconnected',
              result: { id: 1, role: 'host' }
            });
          }
        }
        for (const a of blob.audienceSockets) {
          try { a.socket.terminate(); } catch {}
        }
        blob.audienceSockets.clear();
        blob.hostSession = null;
      }
    }
    blobcastSessions.delete(token);
  });
});

function handleBlobcastMessage(session, msg) {
  let action = null;
  if (msg && typeof msg === 'object') {
    if (msg.args && !Array.isArray(msg.args) && msg.args.action) {
      action = msg.args;                       // PP1-6 стиль: {"args":{action:...}}
    } else if (Array.isArray(msg.args) && msg.args[0] && msg.args[0].action) {
      action = msg.args[0];                    // стиль: {"name":"msg","args":[{action:...}]}
    } else if (msg.action) {
      action = msg;                            // плоский формат
    }
  }
  if (!action || !action.action) {
    log("BLOBcast", `⚠️ Unknown message format`, msg);
    return;
  }
  
  log("BLOBcast", `📨 Action: ${action.action}`, action);
  
  switch (action.action) {
    case 'CreateRoom':
      handleCreateRoom(session, action);
      break;
    case 'SetRoomBlob':
      handleSetRoomBlob(session, action);
      break;
    case 'SetCustomerBlob':
      handleSetCustomerBlob(session, action);
      break;
    case 'LockRoom':
      handleLockRoom(session, action);
      break;
    case 'StartSession': {
      const resp = { action: 'StartSession', success: true };
      if (action.module) resp.module = action.module;
      if (action.name) resp.name = action.name;
      const room = session.room;
      if (action.module === 'audience') {
        if (room) room.audienceEnabled = true;
        resp.response = { count: room ? room.audienceSockets.size : 0 };
      } else if (action.module === 'vote' && room && action.options && Array.isArray(action.options.choices)) {
        const choices = {};
        for (const c of action.options.choices) choices[c] = 0;
        const vname = String(action.name || '');
        room.voteEntities.set(vname, choices);
        blobEcastBroadcast(room, {
          opcode: 'audience/count-group',
          result: { key: vname, choices: { ...choices } }
        }, 'audience');
        resp.response = {};
      } else {
        resp.response = { count: 0 };
      }
      sendBlobcastResponse(session, resp);
      break;
    }
    case 'StopSession': {
      const resp = { action: 'StopSession', success: true };
      if (action.module) resp.module = action.module;
      if (action.name) resp.name = action.name;
      const room = session.room;
      if (action.module === 'vote' && room) {
        const vname = String(action.name || '');
        resp.response = room.voteEntities.get(vname) || {};
        room.voteEntities.delete(vname);
      } else {
        resp.response = { count: room ? room.audienceSockets.size : 0 };
      }
      sendBlobcastResponse(session, resp);
      break;
    }
    case 'GetSessionStatus': {
      const resp = { action: 'GetSessionStatus', success: true };
      if (action.module) resp.module = action.module;
      if (action.name) resp.name = action.name;
      const room = session.room;
      if (action.module === 'vote' && room) {
        resp.response = room.voteEntities.get(String(action.name || '')) || {};
      } else {
        resp.response = { count: room ? room.audienceSockets.size : 0 };
      }
      sendBlobcastResponse(session, resp);
      break;
    }
    default:
      log("BLOBcast", `⚠️ Unimplemented action: ${action.action}`);
      sendBlobcastResponse(session, { action: action.action, success: false, error: 'not implemented' });
  }
}

function handleCreateRoom(session, action) {
  const roomCode = generateRoomCode();
  const room = new BlobcastRoom(roomCode);
  if (action.userId) room.userId = String(action.userId);
  const options = (action.options && typeof action.options === 'object') ? action.options : {};
  if (typeof options.password === 'string') room.password = options.password;
  if (typeof options.maxPlayers === 'number') room.maxPlayers = options.maxPlayers;
  if (options.twitchLocked === true || options.twitchRequired === true || action.twitchLocked === true || action.twitchRequired === true) room.twitchRequired = true;
  if (action.appId) {
    room.appId = String(action.appId);
    for (const [tag, id] of Object.entries(APP_TAGS)) {
      if (id === room.appId) { room.appTag = tag; break; }
    }
  }
  if (action.appTag) room.appTag = String(action.appTag);
  
  blobcastRooms.set(roomCode, room);
  session.room = room;
  room.hostSession = session;
  room.connections.set(session.token, session);
  
  // Хост = клиент id 1 (для ecast-моста)
  room.clients.set(1, {
    id: 1, role: 'host', name: 'host',
    userId: room.userId, connected: true, socket: null
  });
  room.completed = true;
  
  log("BLOBcast", `✅ Created room: ${roomCode}`);
  
  sendBlobcastResponse(session, {
    action: 'CreateRoom',
    roomId: roomCode,
    success: true
  });
}

function handleSetRoomBlob(session, action) {
  if (!session.room) {
    log("BLOBcast", `❌ No room for SetRoomBlob`);
    return;
  }
  
  const key = action.key || 'bc:room';
  const value = action.value || action.blob;
  
  session.room.entities.set(key, value);
  log("BLOBcast", `✅ SetRoomBlob: ${key}`, { value: JSON.stringify(value).substring(0, 200) });
  
  broadcastToRoom(session.room, {
    name: 'msg',
    args: [{
      action: 'SetRoomBlob',
      key: key,
      value: value
    }]
  });
  
  // Мост → ecast-контроллеры (opcode object)
  blobEcastBroadcast(session.room, {
    opcode: 'object',
    result: { key: key, val: value, version: 0, from: 1 }
  }, 'all');
  
  sendBlobcastResponse(session, { action: 'SetRoomBlob', success: true });
}

function handleSetCustomerBlob(session, action) {
  if (!session.room) {
    log("BLOBcast", `❌ No room for SetCustomerBlob`);
    return;
  }
  
  const userId = action.customerUserId || action.userId;
  if (!userId) {
    log("BLOBcast", `⚠️ SetCustomerBlob without userId`, action);
    sendBlobcastResponse(session, { action: 'SetCustomerBlob', success: true });
    return;
  }
  const key = `bc:customer:${userId}`;
  const value = action.value || action.blob;
  
  session.room.entities.set(key, value);
  log("BLOBcast", `✅ SetCustomerBlob: ${key}`, { value: JSON.stringify(value).substring(0, 200) });
  
  broadcastToRoom(session.room, {
    name: 'msg',
    args: [{
      action: 'SetCustomerBlob',
      userId: userId,
      key: key,
      value: value
    }]
  });
  
  // Мост → конкретный ecast-игрок
  for (const client of session.room.clients.values()) {
    if (client.role === 'host' || client.userId !== userId) continue;
    if (client.connected && client.socket && client.socket.readyState === WebSocket.OPEN) {
      blobEcastSend(session.room, client.socket, {
        opcode: 'object',
        result: { key: key, val: value, version: 0, from: 1 }
      });
    }
  }
  
  sendBlobcastResponse(session, { action: 'SetCustomerBlob', success: true });
}

function handleLockRoom(session, action) {
  if (!session.room) {
    log("BLOBcast", `❌ No room for LockRoom`);
    return;
  }
  
  session.room.locked = true;
  log("BLOBcast", `🔒 Room locked: ${session.room.code}`);
  
  broadcastToRoom(session.room, {
    name: 'msg',
    args: [{
      action: 'LockRoom',
      locked: true
    }]
  });
  
  sendBlobcastResponse(session, { action: 'LockRoom', success: true });
}

function sendBlobcastResponse(session, data) {
  if (session.socket && session.socket.readyState === WebSocket.OPEN) {
    if (!data.type) data.type = 'Result';
    const packet = `5:::${JSON.stringify({ name: 'msg', args: [data] })}`;
    session.socket.send(packet);
    log("BLOBcast", `📤 Sent: ${packet.substring(0, 200)}`);
  }
}

function broadcastToRoom(room, data) {
  const packet = `5:::${JSON.stringify(data)}`;
  for (const [token, session] of room.connections) {
    if (session.socket && session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(packet);
    }
  }
}

// ======================= BLOBCAST ↔ ECAST BRIDGE =======================
function blobEcastSend(blob, socket, msg) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  msg.pc = blob.pc++;
  try { socket.send(JSON.stringify(msg)); } catch (e) {
    log("BLOBcast↔Ecast", `❌ ecast send failed: ${e.message}`);
  }
}

// where: 'all' | 'players' | 'audience'
function blobEcastBroadcast(blob, msg, where) {
  if (where === 'all' || where === 'players') {
    for (const client of blob.clients.values()) {
      if (client.role === 'host') continue;
      if (!client.connected || !client.socket) continue;
      blobEcastSend(blob, client.socket, { ...msg });
    }
  }
  if (where === 'all' || where === 'audience') {
    for (const a of blob.audienceSockets) {
      blobEcastSend(blob, a.socket, { ...msg });
    }
  }
}

// Событие игровому хосту (socket.io): 5:::{"name":"msg","args":[{type:"Event",...}]}
function blobHostEvent(blob, event, fields) {
  const session = blob.hostSession;
  if (!session || !session.socket || session.socket.readyState !== WebSocket.OPEN) {
    log("BLOBcast↔Ecast", `⚠️ No host socket for event ${event}`);
    return;
  }
  const payload = Object.assign({ type: 'Event', event: event, roomId: blob.code }, fields);
  const packet = `5:::${JSON.stringify({ name: 'msg', args: [payload] })}`;
  try { session.socket.send(packet); } catch (e) {
    log("BLOBcast↔Ecast", `❌ host event send failed: ${e.message}`);
  }
}

function onBlobcastEcastClient(socket, query, blob, opts) {
  const isAudience = !!(opts && opts.isAudience);
  let userId = String(query['user-id'] || query.userId || '');
  const name = String(query.name || (isAudience ? 'Audience' : 'Player')).substring(0, 32);

  if (!isAudience && blob.password && query.password !== blob.password) {
    blobEcastSend(blob, socket, {
      opcode: 'error',
      result: { code: 2018, msg: 'invalid room password' }
    });
    setTimeout(() => { try { socket.close(); } catch {} try { socket.terminate(); } catch {} }, 500);
    return;
  }

  let profileId = null;
  let reconnect = false;

  // Идёт ли игра (не лобби) — чтобы переподключение по имени не создавало второго игрока.
  const gameInProgress = (() => {
    const roomVal = blob.entities.get('bc:room');
    if (!roomVal || typeof roomVal !== 'string') return false;
    try {
      const state = (JSON.parse(roomVal).state || '');
      return /^(Gameplay|Round|Day)_/.test(state) ||
        (state && state !== 'Lobby' && state !== 'Logo' && state !== 'EndGame' && !/PostGame/.test(state));
    } catch { return false; }
  })();

  if (!isAudience && userId) {
    for (const client of blob.clients.values()) {
      if (client.role === 'host' || client.userId !== userId) continue;
      profileId = client.id;
      reconnect = true;
      if (client.connected) {
        log("BLOBcast↔Ecast", `♻️ ${name}: userId ${userId} уже подключён — перехватываем сокет вместо дубля`);
        try { client.socket && client.socket.terminate(); } catch {}
      }
      break;
    }
  }

  // Fallback: переподключение с другого IP часто приносит новый user-id (перезагрузка).
  // Если игра уже идёт — занимаем прежний профиль по имени, а не создаём второго игрока.
  if (!isAudience && !reconnect && gameInProgress) {
    for (const client of blob.clients.values()) {
      if (client.role !== 'player' || client.name !== name) continue;
      profileId = client.id;
      reconnect = true;
      if (client.connected) {
        log("BLOBcast↔Ecast", `♻️ ${name}: прежний сокет жив — перехватываем профиль ${profileId}`);
        try { client.socket && client.socket.terminate(); } catch {}
      }
      break;
    }
  }

  if (isAudience) {
    profileId = blob.audienceNextId++;
  } else if (!reconnect) {
    profileId = blob.clients.size + 1;
    blob.clients.set(profileId, {
      id: profileId, role: 'player', name: name,
      userId: userId, connected: true, socket: socket
    });
  } else {
    const client = blob.clients.get(profileId);
    client.connected = true;
    client.socket = socket;
    client.name = name;
    userId = client.userId;
  }

  // --- entities (для welcome): bc:room + своя customer-сущность + счётчики
  const entities = {};
  for (const [key, val] of blob.entities) {
    if (key === 'bc:room' || (!isAudience && key === `bc:customer:${userId}`)) {
      entities[key] = ['object', { key: key, val: val, from: 1, version: 0 }, { locked: false }];
    }
  }
  if (blob.audienceEnabled) {
    entities['audience'] = ['audience/pn-counter',
      { key: 'audience', count: blob.audienceSockets.size }, { locked: false }];
  }
  if (isAudience) {
    for (const [vname, choices] of blob.voteEntities) {
      entities[vname] = ['audience/count-group',
        { key: vname, choices: { ...choices } }, { locked: false }];
    }
  }

  // --- here: кто уже в комнате
  const here = {};
  for (const client of blob.clients.values()) {
    if (client.id === profileId) continue;
    if (client.role === 'host') {
      here[client.id] = { id: client.id, roles: { host: {} } };
    } else if (client.role === 'player') {
      here[client.id] = { id: client.id, roles: { player: { name: client.name } } };
    } else if (client.role === 'moderator') {
      here[client.id] = { id: client.id, roles: { moderator: { name: client.name } } };
    }
  }

  blobEcastSend(blob, socket, {
    opcode: 'client/welcome',
    result: {
      id: profileId,
      name: name,
      secret: '',
      reconnect: reconnect,
      deviceId: '',
      entities: entities,
      here: here,
      profile: {
        id: profileId,
        roles: isAudience ? { audience: { name: name } } : { player: { name: name } }
      }
    }
  });

  if (isAudience) {
    blob.audienceSockets.add({ socket: socket, id: profileId, name: name });
    if (blob.audienceEnabled) {
      blobEcastBroadcast(blob, {
        opcode: 'audience/pn-counter',
        result: { key: 'audience', count: blob.audienceSockets.size }
      }, 'all');
    }
    log("BLOBcast↔Ecast", `👥 Audience "${name}" joined ${blob.code} (id ${profileId})`);
  } else {
    if (!reconnect) {
      blobHostEvent(blob, 'CustomerJoinedRoom', {
        customerUserId: userId,
        customerName: name,
        options: { roomcode: '', name: name, email: '', phone: '' }
      });
    }
    log("BLOBcast↔Ecast", `🎮 Player "${name}" (${userId}) joined ${blob.code} as profile ${profileId}${reconnect ? " (reconnect)" : ""}`);
  }

  socket.on('message', (raw) => {
    const text = raw.toString();
    let msg;
    try { msg = JSON.parse(text); } catch {
      blobEcastSend(blob, socket, {
        opcode: 'error',
        result: { code: 1000, msg: 'parse error in ecast protocol' }
      });
      return;
    }
    const opcode = msg.opcode || '';

    try {
    if (opcode === 'client/send') {
      const params = msg.params || {};
      const target = blob.clients.get(params.to);
      if (!target) {
        blobEcastSend(blob, socket, {
          re: msg.seq, opcode: 'error',
          result: { code: 2008, msg: `there is no connected client having id ${params.to}` }
        });
        return;
      }
      if (target.role !== 'host') {
        blobEcastSend(blob, socket, {
          re: msg.seq, opcode: 'error',
          result: { code: 2023, msg: 'permission denied' }
        });
        return;
      }
      blobHostEvent(blob, 'CustomerMessage', {
        userId: userId,
        message: params.body
      });
      blobEcastSend(blob, socket, { re: msg.seq, opcode: 'ok', result: {} });
      return;
    }

    if (isAudience && opcode === 'audience/count-group/increment') {
      const params = msg.params || {};
      const vname = String(params.name || '');
      const choices = blob.voteEntities.get(vname);
      if (!choices || !(params.vote in choices)) {
        blobEcastSend(blob, socket, {
          re: msg.seq, opcode: 'error',
          result: { code: 1000, msg: 'invalid arguments' }
        });
        return;
      }
      choices[params.vote] += (typeof params.times === 'number' && params.times > 0) ? params.times : 1;
      blobEcastSend(blob, socket, { re: msg.seq, opcode: 'ok', result: {} });
      blobEcastBroadcast(blob, {
        opcode: 'audience/count-group',
        result: { key: vname, choices: { ...choices } }
      }, 'audience');
      return;
    }

    blobEcastSend(blob, socket, {
      re: msg.seq, opcode: 'error',
      result: { code: 2002, msg: 'invalid opcode' }
    });
    } catch (err) {
      log("BLOBcast↔Ecast", `❌ Ecast client message handler error (${opcode}): ${err.message}`);
      try { blobEcastSend(blob, socket, { re: msg.seq, opcode: 'error', result: { code: 1000, msg: String(err.message || err) } }); } catch {}
    }
  });

  socket.on('close', () => {
    if (isAudience) {
      for (const a of blob.audienceSockets) {
        if (a.socket === socket) { blob.audienceSockets.delete(a); break; }
      }
      if (blob.audienceEnabled) {
        blobEcastBroadcast(blob, {
          opcode: 'audience/pn-counter',
          result: { key: 'audience', count: blob.audienceSockets.size }
        }, 'all');
      }
      log("BLOBcast↔Ecast", `👥 Audience left ${blob.code} (now ${blob.audienceSockets.size})`);
      return;
    }
    const client = blob.clients.get(profileId);
    if (client && client.socket === socket && client.connected) {
      client.connected = false;
      blobHostEvent(blob, 'CustomerLeftRoom', {
        customerUserId: userId
      });
      log("BLOBcast↔Ecast", `🔌 Player profile ${profileId} left ${blob.code}`);
    }
  });
}
// ===================== END BLOBCAST ↔ ECAST BRIDGE =====================

// Очистка старых сессий
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of blobcastSessions) {
    if (now - session.lastPing > 60000) {
      log("BLOBcast", `🗑️ Cleaning up session: ${token}`);
      if (session.socket) session.socket.terminate();
      if (session.room) session.room.connections.delete(token);
      blobcastSessions.delete(token);
    }
  }
}, 5 * 60 * 1000);

// ======================= ECAST WEBSOCKET ===================
const ecastWss = new WebSocketServer({ noServer: true });

const WS_HEARTBEAT_MS = 30 * 1000;

setInterval(() => {
  for (const ws of [...ecastWss.clients, ...blobcastWss.clients]) {
    try { ws.ping(); } catch {}
  }
}, WS_HEARTBEAT_MS);

// Обработка WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  const pathname = urlNode.parse(req.url).pathname;
  const ip = getClientIP(req);
  
  log("WS_DEBUG", `🔌 Upgrade attempt`, {
    pathname,
    ip,
    url: req.url
  });
  
  // Проверяем бан
  if (isBanned(ip)) {
    log("WS", `🚫 BANNED upgrade rejected: ${ip}`);
    socket.destroy();
    return;
  }
  
  // Проверяем DDoS
  if (checkDDoS(ip)) {
    log("WS", `🛑 DDoS upgrade blocked: ${ip}`);
    socket.destroy();
    return;
  }

  // MITM: зеркало WS-upgrade на QA-сервер
  const wsMirror = startWsMirror(req);
  
  // Blobcast WebSocket
  const blobcastMatch = pathname.match(/^\/socket\.io\/1\/websocket\/(.+)$/);
  if (blobcastMatch) {
    const token = blobcastMatch[1];
    const session = blobcastSessions.get(token);
    
    if (!session) {
      log("BLOBcast", `❌ Invalid token: ${token}`);
      if (wsMirror) socket.on('close', () => wsMirror.close());
      socket.destroy();
      return;
    }
    
    log("BLOBcast", `✅ WebSocket upgrade: token=${token}`);
    
    blobcastWss.handleUpgrade(req, socket, head, (ws) => {
      attachWsMirror(ws, wsMirror);
      blobcastWss.emit('connection', ws, req, token);
    });
    return;
  }
  
  // Ecast WebSocket
  const ecastMatch = pathname.match(/^\/api\/v2\/rooms\/([^\/]+)\/play$/i) ||
                     pathname.match(/^\/api\/v2\/audience\/([^\/]+)\/play$/i) ||
                     pathname.match(/^\/room\/([^\/]+)\/play$/i);
  
  if (ecastMatch) {
    log("Ecast", `✅ WebSocket upgrade for room: ${ecastMatch[1]}`);
    ecastWss.handleUpgrade(req, socket, head, (ws) => {
      attachWsMirror(ws, wsMirror);
      ecastWss.emit('connection', ws, req);
    });
    return;
  }
  
  log("WS", `❌ Unknown WebSocket path: ${pathname}`);
  if (wsMirror) socket.on('close', () => wsMirror.close());
  socket.destroy();
});

ecastWss.on("connection", (socket, req) => {
  const parsed = urlNode.parse(req.url, true);
  const ip = getClientIP(req);
  const path = parsed.pathname;
  const query = parsed.query;

  log("WS_DEBUG", `🔌 Ecast WS Connection`, {
    url: req.url,
    path: path,
    query: query,
    ip: ip
  });

  const legacyMatch = path.match(/^\/room\/([^\/]+)\/play$/i);
  const roomsMatch = path.match(/^\/api\/v2\/rooms\/([^\/]+)\/play$/i);
  const audienceMatch = path.match(/^\/api\/v2\/audience\/([^\/]+)\/play$/i);

  let roomCode;
  let isAudiencePath = false;
  let isLegacy = false;

  if (legacyMatch) {
    roomCode = legacyMatch[1].toUpperCase();
    isLegacy = true;
    log("LEGACY", `🔌 Legacy WS path: /room/${roomCode}/play`);
  } else if (audienceMatch) {
    roomCode = audienceMatch[1].toUpperCase();
    isAudiencePath = true;
  } else if (roomsMatch) {
    roomCode = roomsMatch[1].toUpperCase();
  } else {
    log("WS", `❌ Invalid WS path: ${path}`);
    return socket.terminate();
  }

  const role = query.role;
  const isHost = role === "host";
  const isPlayer = role === "player";
  const isAudience = role === "audience" || isAudiencePath;
  const isModerator = role === "moderator";

  log("WS_DEBUG", `🎯 Role detected`, { role, isHost, isPlayer, isAudience, isModerator, isLegacy });

  if (isHost) {
    const prepared = pickPreparedRoom(ip);
    if (prepared) roomCode = prepared.code;
  }

  const upstreamInfo = upstreamTargets.get(roomCode);
  if (upstreamInfo && Date.now() - upstreamInfo.ts < UPSTREAM_TTL && upstreamInfo.host) {
    log("UPSTREAM-WS", `🔀 Tunneling ${roomCode} → ${upstreamInfo.host}`);
    tunnelUpstreamWs(socket, req, upstreamInfo.host);
    return;
  }

  const queryTarget = normalizeUpstreamTarget(query.upstream || query.target);
  if (queryTarget) {
    log("UPSTREAM-WS", `🔀 Query upstream ${roomCode} → ${queryTarget}`);
    tunnelUpstreamWs(socket, req, queryTarget);
    return;
  }

  let room = rooms.get(roomCode);
  if (!room && isHost) {
    const prepared = pickPreparedRoom(ip);
    room = createRoom(query.appId || "unknown", query.appTag || "custom", parseInt(query.maxPlayers) || 100, roomCode, prepared?.owner);
    room.owner = prepared?.owner; room.creatorIP = ip;
    rooms.set(roomCode, room);
    log("ROOM", `Auto-created room ${roomCode} for host`);
  }

  if (!room && !isHost) {
    const blob = blobcastRooms.get(roomCode);
    if (blob) {
      const requireTwitch = blob.twitchRequired && TWITCH.enforce && twitchEnabled() && !isAudience && !isAudiencePath;
      if (requireTwitch) {
        (async () => {
          const token = query["twitch-token"] || query.twitchToken;
          const user = await validateTwitchToken(token);
          if (!user) return twitchRejectJoin(socket, roomCode, ip);
          log("TWITCH", `✅ ${roomCode}: твич-вход ${user.display} (${user.login})`);
          onBlobcastEcastClient(socket, query, blob, { isAudience: isAudience || isAudiencePath });
        })();
        return;
      }
      log("BLOBcast↔Ecast", `🔌 Ecast ${role || 'client'} → bridge to blobcast room ${roomCode}`);
      onBlobcastEcastClient(socket, query, blob, { isAudience: isAudience || isAudiencePath });
      return;
    }
  }

  if (!room) {
    log("WS", `❌ Room ${roomCode} not found, terminating`);
    return socket.terminate();
  }

  if (!isAudiencePath) {
    if (isPlayer && room.gamePassword && query.password !== room.gamePassword) return socket.terminate();
    if (isModerator && room.moderatorPassword && query.password !== room.moderatorPassword) return socket.terminate();
  }

  if (isHost) onHostConnect(room, socket, ip);
  else if (isPlayer) {
    const taken = findPlayerByName(room, (query.name || "").trim());
    if (taken && taken.ip && ip && taken.ip !== ip) {
      // Ник занят с другого IP — сразу в зрители, независимо от твича.
      log("WS", `🚷 "${query.name}" уже играет с IP ${taken.ip}; заход с ${ip} -> в зрители`);
      onAudienceConnect(room, socket, query.name, ip, true);
    } else if (room.twitchRequired && TWITCH.enforce && twitchEnabled() && !isKnownPlayerReconnect(room, query, ip)) {
      (async () => {
        const token = query["twitch-token"] || query.twitchToken;
        const user = await validateTwitchToken(token);
        if (!user) return twitchRejectJoin(socket, roomCode, ip);
        log("TWITCH", `✅ ${roomCode}: твич-вход ${user.display} (${user.login})`);
        onPlayerConnect(room, socket, query.name, query.id ? parseInt(query.id) : null, query.secret, ip, user);
      })();
    } else {
      if (room.twitchRequired && TWITCH.enforce && twitchEnabled()) {
        log("TWITCH", `♻️ ${roomCode}: реконнект игрока "${query.name || query.id}" — твич уже пройден`);
      }
      onPlayerConnect(room, socket, query.name, query.id ? parseInt(query.id) : null, query.secret, ip, null);
    }
  }
  else if (isModerator) onModeratorConnect(room, socket, query.name, ip);
  else if (isAudience) onAudienceConnect(room, socket, query.name, ip);
  else socket.terminate();
});

// Реконнект уже игравшего игрока (есть id или имя в комнате) — повторно твич не требуем:
// контроллер при реконнекте шлёт id+secret, но ещё не успевает подгрузить twitch-token.
// Только если заход с того же IP, иначе это чужой — твич обязателен, дальше пойдёт в зрители.
function isKnownPlayerReconnect(room, query, ip) {
  const name = (query && query.name ? String(query.name) : "").trim();
  if (!name) return false;
  const pl = findPlayerByName(room, name);
  if (!pl) return false;
  if (pl.ip && ip && pl.ip !== ip) return false;
  return true;
}

function onHostConnect(room, socket, ip) {
  log("WS", `🎮 HOST connected to ${room.roomCode} | IP: ${ip}`);
  
  room.host = socket;
  room.players.clear(); room.moderators.clear();
  room.disconnectedPlayers.clear();
  room.disconnectedTimers.forEach(t => clearTimeout(t)); room.disconnectedTimers.clear();
  for (const a of room.audience.values()) try { a.socket.terminate(); } catch {}
  room.audience.clear(); room.nextAudienceId = 1000;
  
  room.objects.clear(); room.versions.clear(); room.fromMap.clear();
  room.restrictions.clear(); room.locks.clear(); room.types.clear(); room.acls.clear();
  room.pcHost = 2; room.pcPlayers.clear();
  room.nextPlayerId = 2; room.nextModeratorId = 500;
  room.locked = false;

  const welcome = {
    pc: room.pcHost++,
    opcode: "client/welcome",
    result: {
      id: 1,
      secret: room.hostToken,
      reconnect: false,
      deviceId: "0000000000.0000000000000000000000",
      entities: {},
      here: {},
      profile: null
    }
  };
  
  log("WS", `📤 -> HOST welcome`, welcome);
  socket.send(JSON.stringify(welcome));

  socket.on("close", () => {
    log("ROOM", `🔌 Host disconnected from ${room.roomCode}; room kept alive (no auto-delete)`);
    room.host = null;
    for (const p of room.players.values()) if (p.socket) try { p.socket.terminate(); } catch {}
    for (const m of room.moderators.values()) if (m.socket) try { m.socket.terminate(); } catch {}
    for (const a of room.audience.values()) if (a.socket) try { a.socket.terminate(); } catch {}
  });

  socket.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const opcode = msg.opcode || "";
    
    log("WS_HOST_MSG", `📨 HOST → opcode: ${opcode}`, msg.params || msg.result || {});

    try {
    const isText = opcode.startsWith("text/");
    const isNumber = opcode.startsWith("number/");
    const isDoodle = opcode.startsWith("doodle/");
    const isObject = opcode.startsWith("object/");
    
    if (isText || isNumber || isDoodle || isObject) {
      handleHostObject(room, socket, msg, { isText, isNumber, isDoodle, isObject });
      return;
    }

    switch (opcode) {
      case "lock":
        log("WS", `🔒 Host locked object: ${msg.params?.key}`);
        room.locks.set(msg.params.key, true);
        socket.send(JSON.stringify({ pc: room.pcHost++, re: msg.seq, opcode: "ok", result: {} }));
        break;
        
      case "drop":
        log("WS", `🗑️ Host dropped object: ${msg.params?.key}`);
        room.objects.delete(msg.params.key);
        room.versions.delete(msg.params.key);
        room.restrictions.delete(msg.params.key);
        room.types.delete(msg.params.key);
        room.locks.delete(msg.params.key);
        room.fromMap.delete(msg.params.key);
        room.acls.delete(msg.params.key);
        socket.send(JSON.stringify({ pc: room.pcHost++, re: msg.seq, opcode: "ok", result: {} }));
        break;
        
      case "room/get-audience":
        log("WS", `👥 Host requested audience list`);
        socket.send(JSON.stringify({
          pc: room.pcHost++,
          re: msg.seq,
          opcode: "room/get-audience",
          result: { connections: room.audience.size }
        }));
        break;
        
      case "room/lock":
        log("WS", `🔒 Host locked room`);
        room.locked = true;
        socket.send(JSON.stringify({ pc: room.pcHost++, re: msg.seq, opcode: "ok", result: {} }));
        break;
        
      case "room/exit":
        log("WS", `🚪 Host exited room`);
        rooms.delete(room.roomCode);
        socket.send(JSON.stringify({ pc: room.pcHost++, re: msg.seq, opcode: "ok", result: {} }));
        socket.terminate();
        break;
        
      case "room/start-audience":
        room.audienceEnabled = true;
        if (!room.objects.has("audience")) {
          room.objects.set("audience", { count: room.audience.size });
          room.types.set("audience", "audience/pn-counter");
          room.versions.set("audience", 0);
          room.fromMap.set("audience", 1);
          room.locks.set("audience", false);
        } else {
          room.objects.get("audience").count = room.audience.size;
        }
        log("WS", `👥 Host started audience (count=${room.audience.size})`);
        socket.send(JSON.stringify({ pc: room.pcHost++, re: msg.seq, opcode: "ok", result: {} }));
        broadcastAudienceCount(room);
        break;

      case "text/filter":
      case "game/start":
        log("WS", `ℹ️ Host ${opcode} (ignored)`);
        socket.send(JSON.stringify({ pc: room.pcHost++, re: msg.seq, opcode: "ok", result: {} }));
        break;
        
      case "room/settings":
        applyRoomSettings(room, msg.params);
        socket.send(JSON.stringify({ pc: room.pcHost++, re: msg.seq, opcode: "ok", result: {} }));
        break;
        
      case "client/send":
        log("WS", `📨 Host client/send`, msg.params);
        socket.send(JSON.stringify({ pc: room.pcHost++, re: msg.seq, opcode: "ok", result: {} }));
        break;
        
      default:
        log("WS", `⚠️ Unimplemented host opcode: ${opcode}`, msg);
        socket.send(JSON.stringify({ pc: room.pcHost++, re: msg.seq, opcode: "ok", result: {} }));
    }
    } catch (err) {
      log("WS", `❌ Host message handler error (${opcode}): ${err.message}`);
      try { socket.send(JSON.stringify({ pc: room.pcHost++, re: msg.seq, opcode: "error", result: { code: 1000, msg: String(err.message || err) } })); } catch {}
    }
  });
}

function entityTuple(room, key) {
  const type = room.types.get(key) || "object";
  const val = room.objects.get(key);
  const locked = room.locks.get(key) || false;
  if (type === "audience/pn-counter") {
    return [type, { key: key, count: (val && val.count) || 0 }, { locked: locked }];
  }
  if (type === "audience/count-group") {
    return [type, { key: key, choices: (val && val.choices) || {} }, { locked: locked }];
  }
  return [type, { key: key, val: val, version: room.versions.get(key) || 0, from: room.fromMap.get(key) || 1 }, { locked: locked }];
}

function broadcastAudienceCount(room) {
  if (!room.objects.has("audience")) return;
  room.objects.get("audience").count = room.audience.size;
  const base = { opcode: "audience/pn-counter", result: { key: "audience", count: room.audience.size } };
  for (const [pid, p] of room.players) {
    if (!p.socket) continue;
    const pc = room.pcPlayers.get(pid) || 0;
    room.pcPlayers.set(pid, pc + 1);
    try { p.socket.send(JSON.stringify({ pc: pc, ...base })); } catch {}
  }
}

function normalizeAcl(acl) {
  try {
    if (acl == null) return null;
    const arr = Array.isArray(acl) ? acl : [acl];
    const flat = [];
    for (const x of arr) {
      if (Array.isArray(x)) flat.push(...x.map(String));
      else if (typeof x === 'string') flat.push(...x.split(' ').filter(Boolean));
      else flat.push(String(x));
    }
    return flat;
  } catch {
    return null;
  }
}

function handleHostObject(room, socket, msg, flags) {
  const { isText, isNumber, isDoodle, isObject } = flags;
  const params = msg.params || {};
  const key = params.key;
  if (params.val === undefined && params.value !== undefined) params.val = params.value;
  const val = params.val !== undefined ? params.val : params.value;
  
  let opcode = "object";
  if (isText) opcode = "text";
  else if (isNumber) opcode = "number";
  else if (isDoodle) opcode = "doodle";
  
  if (isDoodle && !isText && !isNumber) {
    const doodleVal = JSON.parse(JSON.stringify(params));
    delete doodleVal.acl;
    room.objects.set(key, doodleVal);
    room.objects.get(key).lines = [];
  } else {
    room.objects.set(key, val);
  }
  
  room.locks.set(key, false);
  room.versions.set(key, (room.versions.get(key) !== undefined ? room.versions.get(key) + 1 : 0));
  
  if (msg.params.acl) {
    room.acls.set(key, normalizeAcl(msg.params.acl));
    log("WS", `🔑 Host ${opcode} acl(${key})=${safeStr(msg.params.acl)} → ${JSON.stringify(room.acls.get(key))}`);
  }
  room.fromMap.set(key, 1);
  room.types.set(key, opcode);
  
  if (isNumber) {
    const restrictions = {};
    if (msg.params.min) restrictions.min = msg.params.min;
    if (msg.params.max) restrictions.max = msg.params.max;
    if (msg.params.type) restrictions.type = msg.params.type;
    if (msg.params.increment) restrictions.increment = msg.params.increment;
    room.restrictions.set(key, restrictions);
  }
  
  log("WS", `📝 Host ${opcode}: key="${key}"`, { val: safeStr(val) });
  
  socket.send(JSON.stringify({ pc: room.pcHost++, re: msg.seq, opcode: "ok", result: {} }));
  
  for (const [pid, p] of room.players) {
    if (!p.socket) continue;
    
    const acl = room.acls.get(key);
    if (acl && !acl.some((entry) => entry === `id:${pid}` || entry === 'role:player' || entry === '*')) {
      continue;
    }
    
    const oldPc = room.pcPlayers.get(pid) || 0;
    room.pcPlayers.set(pid, oldPc + 1);
    
    let result = { ...msg.params };
    delete result.min; delete result.max; delete result.type;
    delete result.increment; delete result.accept; delete result.reject;
    
    if (isNumber && !isText) {
      result.restrictions = room.restrictions.get(key) || {};
    }
    
    if (!isDoodle || isText || isNumber) {
      result.version = room.versions.get(key);
    } else {
      result.index = room.versions.get(key);
    }
    result.from = 1;
    
    try {
      log("WS", `📤 -> PLAYER ${pid} ${opcode}: key="${key}" (pc=${oldPc})`);
      p.socket.send(JSON.stringify({ pc: oldPc, opcode: opcode, result: result }));
    } catch (err) {
      log("WS", `❌ Failed to send to player ${pid}: ${err.message}`);
    }
  }
}

function applyRoomSettings(room, params) {
  if (!params) return;
  if (typeof params.maxPlayers === "number") room.maxPlayers = Math.min(100, Math.max(1, params.maxPlayers));
  if (typeof params.minPlayers === "number") room.minPlayers = Math.min(room.maxPlayers, Math.max(0, params.minPlayers));
  if (typeof params.locked === "boolean") room.locked = params.locked;
  if (typeof params.audienceEnabled === "boolean") room.audienceEnabled = params.audienceEnabled;
  if (typeof params.twitchRequired === "boolean") room.twitchRequired = params.twitchRequired;
}

function findPlayerByName(room, name) {
  if (!name) return null;
  for (const pl of room.players.values()) if (pl && pl.name === name) return pl;
  return room.disconnectedPlayers.get(name) || null;
}

function onPlayerConnect(room, socket, playerName, playerId, playerSecret, ip, twitchUser) {
  const name = (playerName || `PLAYER${room.nextPlayerId}`).trim();

  // Ник уже занят с другого IP -> отправляем в зрители, а не отдаём профиль игрока.
  const existingByName = findPlayerByName(room, name);
  if (existingByName && existingByName.ip && ip && existingByName.ip !== ip) {
    log("WS", `🚷 "${name}" уже играет с IP ${existingByName.ip}; заход с ${ip} -> в зрители`);
    return onAudienceConnect(room, socket, name, ip, true);
  }

  let id, isReconnect = false;

  if (playerId && playerSecret) {
    const existing = room.players.get(parseInt(playerId));
    if (existing && existing.name === name) {
      id = parseInt(playerId); isReconnect = true; existing.socket = socket;
      if (room.disconnectedTimers.has(name)) { clearTimeout(room.disconnectedTimers.get(name)); room.disconnectedTimers.delete(name); }
      room.disconnectedPlayers.delete(name);
    }
  }

  if (!isReconnect && room.disconnectedPlayers.has(name)) {
    const old = room.disconnectedPlayers.get(name);
    id = old.id; isReconnect = true;
    if (room.disconnectedTimers.has(name)) { clearTimeout(room.disconnectedTimers.get(name)); room.disconnectedTimers.delete(name); }
    room.disconnectedPlayers.delete(name);
    room.players.set(id, { id, name, socket, secret: playerSecret, ip: (old.ip || ip) });
    room.pcPlayers.set(id, room.pcPlayers.get(id) || 0);
  }

  // Переподключение с другого IP: игрок с тем же именем уже подключён (без id/secret).
  // Занимаем его профиль, а не создаём второго игрока.
  if (!isReconnect && room.locked) {
    for (const [pid, pl] of room.players) {
      if (!pl || pl.name !== name || !pl.socket || pl.socket === socket) continue;
      log("WS", `♻️ Reconnect takeover: "${name}" ID=${pid} (new socket from ${ip})`);
      try { pl.socket.terminate(); } catch {}
      id = pid; isReconnect = true;
      pl.socket = socket;
      if (room.disconnectedTimers.has(name)) { clearTimeout(room.disconnectedTimers.get(name)); room.disconnectedTimers.delete(name); }
      room.disconnectedPlayers.delete(name);
      break;
    }
  }

  const totalPlayers = room.players.size + room.disconnectedPlayers.size;
  const isFull = totalPlayers >= room.maxPlayers;

  if (!isReconnect) {
    if (room.locked) return socket.terminate();
    if (totalPlayers >= room.maxPlayers) return socket.terminate();
    id = room.nextPlayerId++;
    room.players.set(id, { id, name, socket, secret: playerSecret, ip });
    room.pcPlayers.set(id, 0);
  }

  const secret = playerSecret || "00000000-0000-0000-0000-000000000000";
  if (!playerSecret) room.players.get(id).secret = secret;
  if (twitchUser && room.players.get(id)) room.players.get(id).twitch = twitchUser;

  log("WS", `👤 Player connected: "${name}" ID=${id} | Room: ${room.roomCode} | IP: ${ip}${twitchUser ? ` | twitch:${twitchUser.login}` : ""}`);

  const playerPc = room.pcPlayers.get(id) || 0;
  room.pcPlayers.set(id, playerPc + 1);
  const welcome = {
    pc: playerPc,
    opcode: "client/welcome",
    result: {
      id: id,
      name: name,
      secret: secret,
      reconnect: isReconnect,
      deviceId: "0000000000.0000000000000000000000",
      entities: {},
      here: {},
      profile: {
        id: id,
        roles: { player: { name: name } }
      }
    }
  };
  
  for (const [pid, pl] of room.players) {
    welcome.result.here[pid] = {
      id: String(pid),
      roles: { player: { name: pl.name } }
    };
  }
  welcome.result.here[1] = { id: "1", roles: { host: {} } };
  
  for (const [key, val] of room.objects) {
    const acl = room.acls.get(key);
    if (acl && !acl.some((entry) => entry === `id:${id}` || entry === 'role:player' || entry === '*')) continue;
    
    welcome.result.entities[key] = entityTuple(room, key);
  }
  
  log("WS", `📤 -> PLAYER welcome`, welcome);
  socket.send(JSON.stringify(welcome));

  const connectedResult = {
    id: id,
    userId: `00000000-0000-0000-0000-00000000000${id}`,
    name: name,
    role: "player",
    reconnect: isReconnect,
    profile: {
      id: id,
      roles: { player: { name: name } }
    }
  };

  if (room.host) {
    const connected = { pc: room.pcHost++, opcode: "client/connected", result: connectedResult };
    log("WS", `📤 -> HOST client/connected`, connected);
    try { room.host.send(JSON.stringify(connected)); } catch {}
  }

  for (const [pid, p] of room.players) {
    if (pid === id) continue;
    if (!p.socket || p.socket.readyState !== WebSocket.OPEN) continue;
    const pc = room.pcPlayers.get(pid) || 0;
    room.pcPlayers.set(pid, pc + 1);
    log("WS", `📤 -> PLAYER ${pid} client/connected`, connectedResult);
    try { p.socket.send(JSON.stringify({ pc, opcode: "client/connected", result: connectedResult })); } catch {}
  }

  for (const mod of room.moderators.values()) {
    if (!mod.socket) continue;
    try { mod.socket.send(JSON.stringify({ pc: 0, opcode: "client/connected", result: connectedResult })); } catch {}
  }

  socket.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const opcode = msg.opcode || "";
    const pc = room.pcPlayers.get(id) || 0;
    
    log("WS_PLAYER_MSG", `📨 PLAYER "${name}" → opcode: ${opcode}`, msg.params || msg.result || {});

    try {
    const isText = opcode.startsWith("text/");
    const isNumber = opcode.startsWith("number/");
    const isDoodle = opcode.startsWith("doodle/");
    const isObject = opcode.startsWith("object/");

    if (isText || isNumber || isDoodle || isObject) {
      handlePlayerObject(room, id, socket, msg, { isText, isNumber, isDoodle, isObject });
      return;
    }

    switch (opcode) {
      case "lock":
        log("WS", `🔒 Player ${id} locked object: ${msg.params?.key}`);
        room.locks.set(msg.params.key, true);
        socket.send(JSON.stringify({ pc: pc + 1, re: msg.seq, opcode: "ok", result: {} }));
        room.pcPlayers.set(id, pc + 1);
        if (room.host) {
          try {
            room.host.send(JSON.stringify({
              pc: room.pcHost++,
              opcode: "lock",
              result: { key: msg.params.key, from: id }
            }));
          } catch {}
        }
        break;
        
      case "client/send":
        log("WS", `📨 Player ${id} client/send`, msg.params);
        if (room.host) {
          try {
            room.host.send(JSON.stringify({
              pc: room.pcHost++, opcode: "client/send",
              result: { ...msg.params, from: id, userID: `00000000-0000-0000-0000-00000000000${id}` }
            }));
          } catch {}
        }
        room.pcPlayers.set(id, pc + 1);
        socket.send(JSON.stringify({ pc: pc, re: msg.seq, opcode: "ok", result: {} }));
        break;
        
      case "room/settings":
        applyRoomSettings(room, msg.params);
        if (room.host) try { room.host.send(JSON.stringify({ pc: room.pcHost++, opcode: "room/settings", result: msg.params })); } catch {}
        room.pcPlayers.set(id, pc + 1);
        socket.send(JSON.stringify({ pc: pc, re: msg.seq, opcode: "ok", result: {} }));
        break;
        
      default:
        log("WS", `⚠️ Unimplemented player opcode: ${opcode}`, msg);
        room.pcPlayers.set(id, pc + 1);
        socket.send(JSON.stringify({ pc: pc, re: msg.seq, opcode: "ok", result: {} }));
    }
    } catch (err) {
      log("WS", `❌ Player ${id} message handler error (${opcode}): ${err.message}`);
      try { socket.send(JSON.stringify({ pc: pc, re: msg.seq, opcode: "error", result: { code: 1000, msg: String(err.message || err) } })); } catch {}
    }
  });

  socket.on("close", () => {
    const active = room.players.get(id);
    if (active && active.socket === socket) {
      room.players.delete(id);
      const disconnected = { id: id, role: "player" };
      if (room.host) {
        try {
          room.host.send(JSON.stringify({ pc: room.pcHost++, opcode: "client/disconnected", result: disconnected }));
        } catch {}
      }
      for (const [pid, p] of room.players) {
        if (!p.socket || p.socket.readyState !== WebSocket.OPEN) continue;
        const pc = room.pcPlayers.get(pid) || 0;
        room.pcPlayers.set(pid, pc + 1);
        try { p.socket.send(JSON.stringify({ pc, opcode: "client/disconnected", result: disconnected })); } catch {}
      }
      for (const mod of room.moderators.values()) {
        if (!mod.socket) continue;
        try { mod.socket.send(JSON.stringify({ pc: 0, opcode: "client/disconnected", result: disconnected })); } catch {}
      }
      const t = setTimeout(() => {
        room.disconnectedPlayers.delete(name);
        room.disconnectedTimers.delete(name);
        room.pcPlayers.delete(id);
      }, 30_000);
      room.disconnectedPlayers.set(name, { id, name, secret: active.secret, ip: active.ip });
      room.disconnectedTimers.set(name, t);
    }
  });
}

function handlePlayerObject(room, id, socket, msg, flags) {
  const { isText, isNumber, isDoodle, isObject } = flags;
  const params = msg.params || {};
  const key = params.key;
  if (params.val === undefined && params.value !== undefined) params.val = params.value;
  const val = params.val !== undefined ? params.val : params.value;
  
  if (room.versions.get(key) === undefined) {
    const pc = room.pcPlayers.get(id) || 0;
    room.pcPlayers.set(id, pc + 1);
    socket.send(JSON.stringify({ pc: pc, re: msg.seq, opcode: "ok", result: {} }));
    return;
  }
  
  if (room.locks.get(key) === true) {
    const pc = room.pcPlayers.get(id) || 0;
    room.pcPlayers.set(id, pc + 1);
    socket.send(JSON.stringify({ pc: pc, re: msg.seq, opcode: "ok", result: {} }));
    return;
  }
  
  room.locks.set(key, false);
  
  let opcode = "object";
  if (isText) opcode = "text";
  else if (isNumber) opcode = "number";
  else if (isDoodle) {
    opcode = "doodle/line";
    const existing = room.objects.get(key);
    if (existing) {
      if (!existing.lines) existing.lines = [];
      existing.lines.push(...(params.points || []));
    }
  } else {
    room.objects.set(key, val);
  }
  
  room.versions.set(key, (room.versions.get(key) || 0) + 1);
  room.fromMap.set(key, id);
  
  log("WS", `📝 Player ${id} ${opcode}: key="${key}"`, { val: safeStr(val) });
  
  const pc = room.pcPlayers.get(id) || 0;
  room.pcPlayers.set(id, pc + 1);
  socket.send(JSON.stringify({ pc: pc, re: msg.seq, opcode: "ok", result: {} }));
  
  if (room.host) {
    let result = { ...msg.params };
    if (!isDoodle || isText || isNumber) {
      result.version = room.versions.get(key);
    } else {
      result.index = room.versions.get(key);
      result.val = JSON.parse(JSON.stringify(result));
      delete result.val.key;
    }
    result.from = id;
    
    try {
      room.host.send(JSON.stringify({ pc: room.pcHost++, opcode: opcode, result: result }));
    } catch (err) {
      log("WS", `❌ Failed to send to host: ${err.message}`);
    }
  }

  if (MODERATION_TAGS.has(room.appTag)) {
    const mtype = isText ? "text" : (isDoodle ? "doodle" : null);
    if (mtype) {
      const mkey = `moderate:${mtype}:${key}`;
      const pname = (room.players.get(id) || {}).name || `Player ${id}`;
      let mvalue;
      if (isText) {
        mvalue = String(val == null ? "" : val);
      } else {
        const dop = room.objects.get(key) || {};
        mvalue = { doodle: { key, lines: dop.lines || [], colors: dop.colors || [], weights: dop.weights || [], size: dop.size || {}, live: false, maxLayer: dop.maxLayer || 0, maxPoints: dop.maxPoints || 0 } };
      }
      const mval = { status: "pending", name: pname, value: mvalue, context: "" };
      room.objects.set(mkey, mval);
      room.types.set(mkey, "object");
      room.versions.set(mkey, (room.versions.get(mkey) || 0) + 1);
      room.fromMap.set(mkey, id);
      room.locks.set(mkey, false);
      room.acls.set(mkey, ["role:moderator"]);
      const mresult = { key: mkey, val: mval, version: room.versions.get(mkey), from: id };
      for (const mod of room.moderators.values()) {
        if (!mod.socket) continue;
        try { mod.socket.send(JSON.stringify({ pc: 0, opcode: "object", result: mresult })); } catch {}
      }
      log("MODERATION", `🧹 ${mtype} "${key}" от ${pname} → очередь модерации`);
    }
  }
}

function onModeratorConnect(room, socket, modName, ip) {
  const name = (modName || `moderator`).trim();
  const id = room.nextModeratorId++;
  room.moderators.set(id, { id, name, socket, secret: generateUUID() });

  log("WS", `👮 Moderator connected: "${name}" ID=${id} | Room: ${room.roomCode} | IP: ${ip}`);

  const welcome = {
    pc: 0, opcode: "client/welcome",
    result: { id, name, secret: generateUUID(), reconnect: false, deviceId: "0000000000.0000000000000000000000", entities: {}, here: {}, profile: { id, roles: { moderator: { name } } } }
  };
  welcome.result.here[1] = { id: "1", roles: { host: {} } };
  for (const [pid, pl] of room.players) welcome.result.here[pid] = { id: String(pid), roles: { player: { name: pl.name } } };
  for (const [mid, mod] of room.moderators) welcome.result.here[mid] = { id: String(mid), roles: { moderator: { name: mod.name } } };

  for (const [key, val] of room.objects) {
    welcome.result.entities[key] = [room.types.get(key) || "object", { key, val, version: room.versions.get(key) || 0, from: 1 }, { locked: false }];
  }

  socket.send(JSON.stringify(welcome));
  if (room.host) try {
    room.host.send(JSON.stringify({
      pc: room.pcHost++, opcode: "client/connected",
      result: { id, name, userId: `00000000-0000-0000-0000-00000000000${id}`, role: "moderator", reconnect: false, profile: { id, roles: { moderator: { name } } } }
    }));
  } catch {}

  socket.on("message", (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    const opcode = msg.opcode || "";
    log("WS_MODERATOR_MSG", `📨 MODERATOR "${name}" → opcode: ${opcode}`, msg.params || {});
    
    try {
    const mop = msg.opcode || "";
    if (mop === "room/settings") {
      applyRoomSettings(room, msg.params);
      if (room.host) try { room.host.send(JSON.stringify({ pc: room.pcHost++, opcode: "room/settings", result: msg.params })); } catch {}
    } else if (mop === "object/update" || mop === "object/set") {
      const key = msg.params && msg.params.key;
      if (key && String(key).startsWith("moderate:") && room.objects.has(key)) {
        room.objects.set(key, msg.params.val);
        room.versions.set(key, (room.versions.get(key) || 0) + 1);
        const upd = { key, val: msg.params.val, version: room.versions.get(key), from: 1 };
        for (const mod of room.moderators.values()) {
          if (mod.socket === socket || !mod.socket) continue;
          try { mod.socket.send(JSON.stringify({ pc: 0, opcode: "object", result: upd })); } catch {}
        }
        log("MODERATION", `✅ ${key} → ${(msg.params.val || {}).status}`);
      }
    } else if (mop === "client/send") {
      if (room.host) try {
        room.host.send(JSON.stringify({ pc: room.pcHost++, opcode: "client/send", result: { ...msg.params, from: id, userID: `00000000-0000-0000-0000-00000000000${id}` } }));
      } catch {}
    } else if (mop === "client/kick") {
      const pid = parseInt(msg.params && msg.params.id);
      const banned = !!(msg.params && msg.params.ban);
      const reason = (msg.params && msg.params.reason) || "";
      const pl = room.players.get(pid);
      const kicked = { id: pid, banned, reason };
      if (pl && pl.socket) {
        try { pl.socket.send(JSON.stringify({ pc: 0, opcode: "client/kicked", result: kicked })); } catch {}
        try { pl.socket.terminate(); } catch {}
      }
      if (room.host) try { room.host.send(JSON.stringify({ pc: room.pcHost++, opcode: "client/kicked", result: kicked })); } catch {}
      for (const [opid, p] of room.players) {
        if (opid === pid || !p.socket) continue;
        try { p.socket.send(JSON.stringify({ pc: room.pcPlayers.get(opid) || 0, opcode: "client/kicked", result: kicked })); } catch {}
      }
      for (const mod of room.moderators.values()) {
        if (mod.socket === socket || !mod.socket) continue;
        try { mod.socket.send(JSON.stringify({ pc: 0, opcode: "client/kicked", result: kicked })); } catch {}
      }
      if (pl) { room.players.delete(pid); room.disconnectedPlayers.delete(pl.name); }
      log("MODERATION", `🥾 Модератор кикнул игрока ${pid}`);
    } else if (/^(doodle|text|object|number)\/get$/.test(mop)) {
      const key = msg.params && msg.params.key;
      const val = room.objects.get(key);
      if (mop.startsWith("doodle/")) {
        socket.send(JSON.stringify({ pc: 0, re: msg.seq, opcode: "ok", result: { key, lines: (val && val.lines) || [] } }));
        return;
      }
      socket.send(JSON.stringify({ pc: 0, re: msg.seq, opcode: "ok", result: { key, val: val } }));
      return;
    }
    socket.send(JSON.stringify({ pc: 0, re: msg.seq, opcode: "ok", result: {} }));
    } catch (err) {
      log("WS", `❌ Moderator message handler error (${opcode}): ${err.message}`);
      try { socket.send(JSON.stringify({ pc: 0, re: msg.seq, opcode: "error", result: { code: 1000, msg: String(err.message || err) } })); } catch {}
    }
  });

  socket.on("close", () => {
    if (room.moderators.get(id)?.socket === socket) room.moderators.delete(id);
  });
}

function onAudienceConnect(room, socket, audienceName, ip, force) {
  const totalPlayers = room.players.size + room.disconnectedPlayers.size;
  const isFull = totalPlayers >= room.maxPlayers;
  const gameStarted = room.locked || room.gameStarted;
  const canJoin = room.audienceEnabled || isFull || gameStarted;

  if (!canJoin && !force) return socket.terminate();

  const name = (audienceName || `AUDIENCE_${room.nextAudienceId}`).trim();
  const id = 4000000000 + room.nextAudienceId++;
  room.audience.set(id, { id, name, socket });
  room.audienceConnected = true;

  log("WS", `🎭 AUDIENCE "${name}" ID=${id} | Room: ${room.roomCode} | Total: ${room.audience.size}`);
  broadcastAudienceCount(room);

  const welcome = {
    pc: 777, opcode: "client/welcome",
    result: { id, name, secret: generateToken(), reconnect: false, entities: {}, here: null, profile: null }
  };

  welcome.result.entities["audience"] = ["audience/pn-counter", { key: "audience", count: room.audience.size }, { locked: false }];
  welcome.result.entities["audiencePlayer"] = ["object", { key: "audiencePlayer", val: { kind: "Logo" }, version: 0, from: 1 }, { locked: false }];
  welcome.result.entities["textDescriptions"] = ["object", { key: "textDescriptions", val: { data: {}, latestDescriptions: [] }, version: 0, from: 1 }, { locked: false }];

  for (const [key, val] of room.objects) {
    if (key.startsWith("info:")) {
      welcome.result.entities[key] = ["object", { key, val, version: room.versions.get(key) || 0, from: 1 }, { locked: false }];
    }
  }

  if (room.objects.has("room")) {
    welcome.result.entities["room"] = ["object", { key: "room", val: room.objects.get("room"), version: room.versions.get("room") || 0, from: 1 }, { locked: false }];
  }

  log("WS", `📤 -> AUDIENCE welcome`, welcome);
  socket.send(JSON.stringify(welcome));

  socket.on("message", (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    const opcode = msg.opcode || "";
    log("WS_AUDIENCE_MSG", `📨 AUDIENCE "${name}" → opcode: ${opcode}`, msg.params || {});
    
    try {
    if (msg.opcode === "client/send" && room.host) {
      try { room.host.send(JSON.stringify({ pc: room.pcHost++, opcode: "client/send", result: { ...msg.params, fromAudience: id, audienceName: name } })); } catch {}
    }
    socket.send(JSON.stringify({ pc: 0, re: msg.seq, opcode: "ok", result: {} }));
    } catch (err) {
      log("WS", `❌ Audience message handler error (${opcode}): ${err.message}`);
      try { socket.send(JSON.stringify({ pc: 0, re: msg.seq, opcode: "error", result: { code: 1000, msg: String(err.message || err) } })); } catch {}
    }
  });

  socket.on("close", () => {
    const active = room.audience.get(id);
    if (active && active.socket === socket) {
      room.audience.delete(id);
      log("WS", `Audience "${name}" disconnected`);
      broadcastAudienceCount(room);
    }
  });
}

// ======================= START ====================
server.listen(PORT, "0.0.0.0", () => {
  console.log(`
===========================================`);
  console.log(`FRbox server v3.0 started`);
  console.log(`  Ecast (WebSocket) + Blobcast (Socket.IO v1)`);
  console.log(`Port: ${PORT} | Host: ${accessibleHost}`);
  console.log(`Xray: ${CONFIG.xrayBin} | Local: socks5://127.0.0.1:${CONFIG.xrayLocalPort}`);
  if (CONFIG.xraySubscription) console.log(`Sub: ${CONFIG.xraySubscription}`);
  else console.log(`Servers: ${(CONFIG.xrayServers || []).length}`);
  console.log(`Storage: ecast.jackboxgames.com (via Xray)`);
  console.log(`Internal token: ${INTERNAL_TOKEN}`);
  console.log(`===========================================`);
});
