const axios = require("axios");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { brotliDecompress } = require("zlib");
const mysql = require('mysql2-promise')();
require("dotenv").config();

const API_KEY = JSON.parse(process.env.API_KEY || '[]');
const imageCache = [];
const cacheDuration = 10 * 60 * 1000; // 10 minutes
const IMAGE_PATH = path.join(__dirname, "uploads");
const SERVER_PORT = 8000;

const AUTO_DELETE = true;
const AUTO_DELETE_DURATION = 8; // days

let trialKeys = [];

if (process.env.TRIAL === 'true') {

    const db = mysql.configure({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    });
}    

try {
  if (process.env.TRIAL_API_KEY?.trim()) {
    trialKeys = JSON.parse(process.env.TRIAL_API_KEY);
  }
} catch (e) {
  console.error('TRIAL_API_KEY の JSON パースに失敗しました:', e);
  trialKeys = [];
}

if (!fs.existsSync(IMAGE_PATH)) {
    fs.mkdirSync(IMAGE_PATH, { recursive: true });
}

setInterval(async () => {
    const now = Date.now();
    for (let i = imageCache.length - 1; i >= 0; i--) {
        if (now - imageCache[i].timestamp > cacheDuration) {
            imageCache.splice(i, 1);
        }
    }

    await deleteOldImages();
}, cacheDuration);

async function deleteOldImages() {
    if (!AUTO_DELETE) return;

    const deleteDate = new Date();
    deleteDate.setDate(deleteDate.getDate() - AUTO_DELETE_DURATION);

    try {
        const files = fs.readdirSync(IMAGE_PATH);
        for (const file of files) {
            const filePath = path.join(IMAGE_PATH, file);
            try {
                const stats = fs.statSync(filePath);
                if (stats.mtime < deleteDate) {
                    fs.unlinkSync(filePath);
                    Logger(`Deleted old image: ${file}`);
                }
            } catch (err) {
                Logger(`Error checking file ${file}: ${err.message}`);
            }
        }
    } catch (err) {
        console.error("Error reading directory:", err);
    }
}

async function handleImageRequest(res, url) {
    const [, encodedUrl] = url.split("?url=");
    if (!encodedUrl) {
        return sendError(res, 400, "Missing parameters");
    }

    const imageUrl = decodeURIComponent(encodedUrl);

    const cachedImage = imageCache.find(item => item.url === imageUrl);
    if (cachedImage) {
        return sendImage(res, cachedImage.buffer, "HIT");
    }

    try {
        const { status, data: rawImage } = await axios.get(imageUrl, { responseType: "arraybuffer" });
        if (status !== 200) throw new Error("Invalid image");

        const resized = await resizeImage(rawImage);
        if (!resized) throw new Error("Resize failed");

        imageCache.push({ url: imageUrl, buffer: resized, timestamp: Date.now() });
        sendImage(res, resized, "MISS");
    } catch (err) {
        Logger(`Error fetching image from ${imageUrl}: ${err.message}`);
        sendError(res, 400, "Invalid image");
    }
}

function UploadImage(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

async function handleUploadImage(req, res) {
    try {
        const data = await UploadImage(req);
        const resized = await resizeImage(data);

        let fileName = GenerateRandomString(10);
        while (fs.existsSync(path.join(IMAGE_PATH, `${fileName}.jpg`))) {
            fileName = GenerateRandomString(10);
        }

        const filePath = path.join(IMAGE_PATH, `${fileName}.jpg`);

        fs.writeFile(filePath, resized, err => {
            if (err) {
                Logger(`Error saving image: ${err.message}`);
                return sendError(res, 500, "Failed to save image");
            }

            Logger(`Uploaded image: ${fileName}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "Success", fileName }));
        });
    } catch (err) {
        sendError(res, 500, "Failed to process image");
        Logger(`Error during upload: ${err.message}`);
    }
}

function handleGetImage(req, res) {
    const imageId = req.url.split("?id=")[1];
    if (!imageId) return sendError(res, 400, "Missing image ID");

    const filePath = path.join(IMAGE_PATH, `${imageId}.jpg`)
    if (!fs.existsSync(filePath)) {
        return sendError(res, 404, "Image not found");
    }

    const cached = imageCache.find(item => item.url === imageId);
    if (cached) return sendImage(res, cached.buffer, "HIT");

    fs.readFile(filePath, (err, data) => {
        if (err) {
            sendError(res, 404, "Image not found");
        } else {
            sendImage(res, data);
            imageCache.push({ url: imageId, buffer: data, timestamp: Date.now() });
        }
    });
}

require("http").createServer(async (req, res) => {
    try {
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        Logger(`${ip} ${req.method} ${req.url}`);

        const urlParts = req.url.split("?");
        const endpoint = urlParts[0];

        switch (endpoint) {
            case "/resize":
            case "/resize/":
                await handleImageRequest(res, req.url);
                break;

            case "/upload":
            case "/upload/": {
                const apiKey = req.headers.authorization;
                if (!apiKey || !(API_KEY.includes(apiKey) || trialKeys.includes(apiKey))) {
                    Logger(`Unauthorized access attempt from ${ip}`);
                    sendError(res, 403, "Forbidden");
                    return;
                }

                if (req.method === "POST") {
                    if (process.env.TRIAL === 'true') {
                        const today = new Date().toISOString().slice(0, 10);
                        const limit = parseInt(process.env.TRIAL_DAILY_LIMIT || '50', 10);

                        if (trialKeys.includes(apiKey)){

                            try {
                            // 1. 今日の日付があるか確認
                            const [existing] = await mysql.execute(
                                'SELECT usage_count FROM trial_usage WHERE usage_date = ?',
                                [today]
                            );
                        
                            // 2-1. 無ければ日付を追加（初期値0）
                            if (existing.length === 0) {
                                await mysql.execute(
                                'INSERT INTO trial_usage (usage_date, usage_count) VALUES (?, 0)',
                                [today]
                                );
                            }
                        
                            // 3. 現在の使用数を確認する
                            const [usage] = await mysql.execute(
                                'SELECT usage_count FROM trial_usage WHERE usage_date = ?',
                                [today]
                            );
                            const current = usage[0]?.usage_count || 0;
                        
                            // 4. 使用数とリミット数を比較する
                            if (current >= limit) {
                                // 5-1. リミット数に達していればエラー
                                sendError(res, 429, "Trial daily limit exceeded");
                                return ;
                            }
                        
                            // 6. カウント1増やす
                            await mysql.execute(
                                'UPDATE trial_usage SET usage_count = usage_count + 1 WHERE usage_date = ?',
                                [today]
                            );
                        
                            } catch (err) {
                            console.error('トライアル制限処理エラー:', err);
                            sendError(res, 500, "Internal Server Error (trial)");
                            }

                        }
                    }
                    handleUploadImage(req, res);
                } else {
                    sendError(res, 405, "Method not allowed");
                }
                break;
            }

            case "/ping":
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ alive: true }));
                break;
            
            case "/get":
            case "/get/":
                handleGetImage(req, res);
                break;
            
            default:
                sendError(res, 404, "Endpoint not found");
                break;
        }
    } catch (err) {
        Logger(`Error handling request: ${err.message}`);
        sendError(res, 500, "Internal server error");
    }
}).listen(SERVER_PORT, async () => {
    Logger("Server is running");
});

function resizeImage(imageData) {
    return sharp(imageData)
        .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
        .toBuffer();
}

function sendImage(res, buffer, cacheStatus = "") {
    const headers = { "Content-Type": "image/jpeg" };
    if (cacheStatus) headers["X-Cache"] = cacheStatus;
    res.writeHead(200, headers);
    res.end(buffer);
}

function sendError(res, statusCode, message) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
}

function GenerateRandomString(length) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join("");
}

function Logger(message) {
    console.log(`[${new Date().toLocaleString()}] ${message}`);
}
