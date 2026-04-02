import puppeteer from "puppeteer-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import adblockerPlugin from "puppeteer-extra-plugin-adblocker";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import readline from "readline";
import { fileURLToPath } from "url";
import { createServer } from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FFMPEG_PATH = "C:\\Users\\xxgol\\Downloads\\ffmpeg-8.1-essentials_build\\ffmpeg-8.1-essentials_build\\bin\\ffmpeg.exe";

const refererUrl = "https://rapid-cloud.co/";
const MAX_RETRIES = 3;

let downloadDir = path.join(__dirname, "downloads");

function ensureWritableDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const testFile = path.join(dir, "_write_test.tmp");
    try { fs.writeFileSync(testFile, "test"); fs.unlinkSync(testFile); return true; }
    catch { return false; }
}

if (!ensureWritableDir(downloadDir)) {
    downloadDir = path.join(process.env.TEMP || "/tmp", "anime_downloads");
    if (!ensureWritableDir(downloadDir)) throw new Error(`Cannot create writable dir: ${downloadDir}`);
}

// ===== PROMPT HELPER =====
function ask(rl, question) {
    return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

// ===== INTERACTIVE SETUP =====
async function promptConfig() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log("\n╔══════════════════════════════════════╗");
    console.log("║        🎌 Anime Downloader 🎌         ║");
    console.log("╚══════════════════════════════════════╝\n");

    // Get first episode URL
    let firstEpisodeUrl = "";
    while (!firstEpisodeUrl.startsWith("http")) {
        firstEpisodeUrl = await ask(rl, "📺 Paste the URL of the FIRST episode to download:\n> ");
        if (!firstEpisodeUrl.startsWith("http")) console.log("⚠ Please enter a valid URL starting with http");
    }

    // Extract base URL from the episode URL
    const parsedUrl = new URL(firstEpisodeUrl);
    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}`;

    // Get starting episode number
    let startEpisode = 1;
    const startInput = await ask(rl, `\n🔢 What episode NUMBER is this? (e.g. 1): `);
    if (startInput && !isNaN(parseInt(startInput))) {
        startEpisode = parseInt(startInput);
    }

    // Get last episode number
    let lastEpisode = startEpisode;
    while (lastEpisode < startEpisode) {
        const lastInput = await ask(rl, `\n🔢 Download up to which episode NUMBER? (e.g. 23): `);
        if (lastInput && !isNaN(parseInt(lastInput))) {
            lastEpisode = parseInt(lastInput);
            if (lastEpisode < startEpisode) {
                console.log(`⚠ Must be >= ${startEpisode}`);
            }
        }
    }

    // Get optional custom download folder
    const folderInput = await ask(rl, `\n📁 Download folder (press Enter for default: ${downloadDir}):\n> `);
    if (folderInput) {
        if (ensureWritableDir(folderInput)) {
            downloadDir = folderInput;
        } else {
            console.log(`⚠ Cannot use that folder, sticking with: ${downloadDir}`);
        }
    }

    rl.close();

    console.log("\n┌─────────────────────────────────────┐");
    console.log(`│ First episode : ${firstEpisodeUrl.slice(0, 35)}...`);
    console.log(`│ Episodes      : ${startEpisode} → ${lastEpisode}`);
    console.log(`│ Save to       : ${downloadDir.slice(0, 35)}`);
    console.log("└─────────────────────────────────────┘\n");

    return { firstEpisodeUrl, baseUrl, startEpisode, lastEpisode };
}

// ===== PUPPETEER SETUP =====
let browser;
puppeteer.use(stealthPlugin());
puppeteer.use(adblockerPlugin());

async function blockResources(page) {
    await page.setRequestInterception(true);
    page.on("request", req => {
        if (["font", "stylesheet", "image"].includes(req.resourceType())) req.abort();
        else req.continue();
    });
}

function waitForStream(page, timeout = 25000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Stream timeout — no m3u8 found")), timeout);
        const handler = req => {
            const url = req.url();
            if (url.includes(".m3u8") && !url.includes("ping") && url.startsWith("http")) {
                clearTimeout(timer);
                page.off("request", handler);
                resolve(url);
            }
        };
        page.on("request", handler);
    });
}

function sanitizeFilename(name) {
    let clean = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    clean = clean.replace(/[<>:"/\\|?*]/g, "").replace(/[\x00-\x1f\x80-\x9f]/g, "");
    clean = clean.trim().replace(/[.\s]+$/, "").replace(/\s+/g, "-");
    return clean || "episode";
}

// ===== HTTP FETCH WITH RETRIES =====
function fetchUrl(url, headers = {}, maxRedirects = 10, retries = 3) {
    return new Promise((resolve, reject) => {
        const attempt = (url, redirectsLeft, retriesLeft) => {
            if (redirectsLeft < 0) return reject(new Error("Too many redirects"));
            const lib = url.startsWith("https") ? https : http;
            const req = lib.get(url, { headers }, res => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    const next = res.headers.location.startsWith("http")
                        ? res.headers.location
                        : new URL(res.headers.location, url).href;
                    res.resume();
                    return attempt(next, redirectsLeft - 1, retriesLeft);
                }
                const chunks = [];
                res.on("data", c => chunks.push(c));
                res.on("end", () => resolve({ body: Buffer.concat(chunks), finalUrl: url, statusCode: res.statusCode }));
                res.on("error", err => {
                    if (retriesLeft > 0) setTimeout(() => attempt(url, redirectsLeft, retriesLeft - 1), 1000);
                    else reject(err);
                });
            });
            req.on("error", err => {
                if (retriesLeft > 0) setTimeout(() => attempt(url, redirectsLeft, retriesLeft - 1), 1000);
                else reject(err);
            });
            req.setTimeout(20000, () => {
                req.destroy();
                if (retriesLeft > 0) setTimeout(() => attempt(url, redirectsLeft, retriesLeft - 1), 1000);
                else reject(new Error(`Timeout: ${url}`));
            });
        };
        attempt(url, maxRedirects, retries);
    });
}

// ===== RESOLVE MASTER → BEST STREAM =====
async function resolveBestStream(masterUrl, headers) {
    console.log(`🔍 Fetching master playlist...`);
    const { body, finalUrl } = await fetchUrl(masterUrl, headers);
    const text = body.toString();

    if (text.includes("#EXTINF")) {
        console.log("✅ Already a media playlist.");
        return { url: masterUrl, finalUrl: masterUrl };
    }

    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
            const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
            const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
            const uri = lines[i + 1];
            if (uri && !uri.startsWith("#")) {
                const fullUri = uri.startsWith("http") ? uri : new URL(uri, finalUrl).href;
                variants.push({ bandwidth, url: fullUri });
            }
        }
    }

    if (!variants.length) {
        console.warn("⚠ No variants found, using master directly.");
        return { url: masterUrl, finalUrl: masterUrl };
    }

    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    console.log(`📊 ${variants.length} variants — best: ${(variants[0].bandwidth / 1000).toFixed(0)}kbps`);
    return { url: variants[0].url, finalUrl: variants[0].url };
}

// ===== LOCAL PROXY SERVER =====
function startProxyServer(segmentMap, fetchHeaders) {
    return new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            const key = req.url.slice(1).split("?")[0];
            const realUrl = segmentMap.get(key);
            if (!realUrl) {
                res.writeHead(404); res.end("Not found"); return;
            }
            try {
                const { body } = await fetchUrl(realUrl, fetchHeaders);
                res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": body.length });
                res.end(body);
            } catch (err) {
                console.error(`\n⚠ Proxy error for ${key}: ${err.message}`);
                res.writeHead(502); res.end("Bad gateway");
            }
        });
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
}

// ===== DOWNLOAD EPISODE =====
async function downloadEpisode(page, episodeName, masterUrl) {
    const safeName = sanitizeFilename(episodeName);
    const outputPath = path.join(downloadDir, `${safeName}.mp4`);

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024 * 1024) {
        console.log(`⏭ Skipping (already exists): ${episodeName}`);
        return;
    }

    console.log(`⬇ Downloading: ${episodeName} → ${path.basename(outputPath)}`);

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const fetchHeaders = {
        "Referer": refererUrl,
        "Origin": new URL(refererUrl).origin,
        "User-Agent": userAgent,
        "Cookie": cookieStr
    };

    const { url: mediaUrl } = await resolveBestStream(masterUrl, fetchHeaders);

    console.log(`📥 Fetching media playlist...`);
    const { body: mediaBody, finalUrl: mediaFinalUrl } = await fetchUrl(mediaUrl, fetchHeaders);
    const mediaText = mediaBody.toString();

    if (!mediaText.includes("#EXTM3U")) {
        throw new Error("Response doesn't look like M3U8 — may be blocked");
    }

    const lines = mediaText.split("\n").map(l => l.trim());
    const segmentMap = new Map();
    const rewrittenLines = [];
    let segIndex = 0;

    for (const line of lines) {
        if (!line) { rewrittenLines.push(""); continue; }
        if (!line.startsWith("#")) {
            const realUrl = line.startsWith("http") ? line : new URL(line, mediaFinalUrl).href;
            const key = `seg_${segIndex++}.ts`;
            segmentMap.set(key, realUrl);
            rewrittenLines.push(`__PLACEHOLDER__/${key}`);
        } else {
            rewrittenLines.push(line);
        }
    }

    console.log(`📦 ${segIndex} segments. Starting proxy...`);
    const { server, port } = await startProxyServer(segmentMap, fetchHeaders);
    console.log(`🔌 Proxy on port ${port}`);

    const localPlaylist = rewrittenLines
        .map(l => l.replace(/__PLACEHOLDER__/g, `http://127.0.0.1:${port}`))
        .join("\n");

    const playlistPath = path.join(downloadDir, `${safeName}_playlist.m3u8`);
    fs.writeFileSync(playlistPath, localPlaylist, "utf8");

    const args = [
        "-protocol_whitelist", "file,http,tcp",
        "-allowed_extensions", "ALL",
        "-i", playlistPath,
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        "-movflags", "+faststart",
        "-y",
        outputPath
    ];

    return new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", chunk => {
            const text = chunk.toString();
            stderr += text;
            text.split("\n").forEach(line => {
                if (line.includes("time=") || line.includes("speed="))
                    process.stdout.write(`\r⏳ ${line.trim().padEnd(80)}`);
            });
        });
        proc.on("close", code => {
            server.close();
            try { fs.unlinkSync(playlistPath); } catch {}
            if (code === 0) {
                const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
                console.log(`\n✅ Done: ${episodeName} (${sizeMB} MB)`);
                resolve();
            } else {
                try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
                console.error(`\n❌ FFmpeg failed (code ${code})`);
                stderr.split("\n").filter(Boolean).slice(-20).forEach(l => console.error(l));
                reject(new Error(`FFmpeg failed with code ${code} for ${episodeName}`));
            }
        });
        proc.on("error", err => { server.close(); try { fs.unlinkSync(playlistPath); } catch {} reject(err); });
    });
}

// ===== PROCESS EPISODE PAGE =====
async function processEpisode(page, episodeUrl, episodeNumber, attempt = 1) {
    console.log(`\n🌐 Episode ${episodeNumber} (attempt ${attempt}): ${episodeUrl}`);
    try {
        await page.goto(episodeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForSelector("#servers-content", { timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));

        const streamPromise = waitForStream(page);
        await page.evaluate(() => {
            const btn = document.querySelector("#servers-content a");
            if (btn) btn.click();
        });
        await new Promise(r => setTimeout(r, 2000));
        const streamUrl = await streamPromise;
        console.log("🎥 Stream found");

        let episodeName = `Episode-${episodeNumber}`;
        try {
            const el = await page.$("#servers-content b");
            if (el) {
                const text = await page.evaluate(e => e.textContent.trim(), el);
                if (text) episodeName = text;
            }
        } catch {}

        await downloadEpisode(page, episodeName, streamUrl);
    } catch (err) {
        if (attempt < MAX_RETRIES) {
            console.warn(`⚠ Failed: ${err.message}. Retrying in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
            return processEpisode(page, episodeUrl, episodeNumber, attempt + 1);
        }
        throw err;
    }
}

// ===== GET NEXT EPISODE URL =====
async function getNextEpisodeUrl(page, currentEpisode, baseUrl) {
    const nextEp = currentEpisode + 1;
    await page.waitForSelector("a[data-number]", { timeout: 5000 }).catch(() => null);
    const nextUrl = await page.evaluate(ep => {
        const links = [...document.querySelectorAll("a[data-number]")];
        const link = links.find(a => Number(a.dataset.number) === ep);
        return link ? link.getAttribute("href") : null;
    }, nextEp);
    return nextUrl ? baseUrl + nextUrl : null;
}

// ===== MAIN =====
async function main() {
    // Interactive config first, before launching browser
    const { firstEpisodeUrl, baseUrl, startEpisode, lastEpisode } = await promptConfig();

    console.log("📁 Download folder:", downloadDir);
    console.log("🚀 Starting downloader...\n");
    const startTime = Date.now();
    const failed = [];

    browser = await puppeteer.launch({
        headless: false,
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await blockResources(page);

    await page.goto("https://www.bing.com");
    await new Promise(r => setTimeout(r, 3000));

    let currentUrl = firstEpisodeUrl;
    let episode = startEpisode;

    try {
        while (episode <= lastEpisode) {
            try {
                await processEpisode(page, currentUrl, episode);
            } catch (err) {
                console.error(`\n❌ Episode ${episode} permanently failed: ${err.message}`);
                failed.push(episode);
            }

            if (episode >= lastEpisode) break;

            const nextUrl = await getNextEpisodeUrl(page, episode, baseUrl);
            if (!nextUrl) {
                console.log(`⚠ No next episode link found after episode ${episode}. Stopping.`);
                break;
            }
            currentUrl = nextUrl;
            episode++;
            await new Promise(r => setTimeout(r, 2000));
        }
    } finally {
        await browser.close();
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successCount = (episode - startEpisode + 1) - failed.length;
    console.log(`\n🎉 Finished! ${successCount}/${episode - startEpisode + 1} episodes downloaded in ${elapsed}s`);
    if (failed.length) console.warn(`⚠ Failed episodes: ${failed.join(", ")}`);
}

main().catch(console.error);