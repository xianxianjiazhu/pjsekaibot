/**
 * 開啟 score_predict.html，點擊「📷 生成分享圖片」按鈕，
 * 攔截網站本身產生的下載檔案（generateShareImage() → downloadCanvas()），
 * 直接拿這張圖發送到噗浪，不用另外截圖裁切。
 *
 * 需要的環境變數（放進 GitHub Secrets）：
 *   PLURK_APP_KEY / PLURK_APP_SECRET / PLURK_ACCESS_TOKEN / PLURK_ACCESS_SECRET
 *
 * 可選的環境變數：
 *   TARGET_URL       - score_predict.html 的網址
 *   SHARE_BUTTON_SELECTOR - 「生成分享圖片」按鈕的選擇器，預設 "#shareImageBtn"
 *   PLURK_QUALIFIER  - 發噗的語氣詞，預設 "分享"
 *   APPS_SCRIPT_BASE_URL - 你的 Apps Script /exec 網址，用來動態查活動名稱+距結算時間
 *   PLURK_CONTENT    - 手動指定發噗文字（留空的話會自動組出動態文字，
 *                       格式：#世界計畫 #台服 #預測分數線 + 活動名稱 + 距結算時間）
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import OAuth from "oauth-1.0a";
import { chromium } from "playwright";

const {
  PLURK_APP_KEY,
  PLURK_APP_SECRET,
  PLURK_ACCESS_TOKEN,
  PLURK_ACCESS_SECRET,
  TARGET_URL = "https://xianxianjiazhu.github.io/pjsekai/score_predict.html",
  SHARE_BUTTON_SELECTOR = "#shareImageBtn",
  PLURK_QUALIFIER = "shares",
  PLURK_CONTENT = "",
  APPS_SCRIPT_BASE_URL = "",
} = process.env;

function assertEnv() {
  const required = ["PLURK_APP_KEY", "PLURK_APP_SECRET", "PLURK_ACCESS_TOKEN", "PLURK_ACCESS_SECRET"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`缺少環境變數：${missing.join(", ")}`);
  }
}

async function fetchShareImage() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(SHARE_BUTTON_SELECTOR, { timeout: 30000 });

  // 排行資料是打 API 後才渲染的，且不再靠 networkidle 間接等待資料抓完，
  // 保守多等幾秒，避免按下去時資料還沒到位、生成出一張空白或不完整的分享圖。
  // 如果 Artifacts 裡下載到的圖常常是空的或資料不完整，把這個數字調更大。
  await page.waitForTimeout(8000);

  // 同時等「下載事件」跟「點擊按鈕」，順序才不會漏接下載
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.click(SHARE_BUTTON_SELECTOR),
  ]);

  const downloadPath = path.join("/tmp", `share-${Date.now()}.png`);
  await download.saveAs(downloadPath);
  await browser.close();

  return fs.readFileSync(downloadPath);
}

async function fetchEventStatus() {
  if (!APPS_SCRIPT_BASE_URL) return null;
  try {
    const url = `${APPS_SCRIPT_BASE_URL}?mode=proxy&target=top100`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const top = await res.json();
    if (!top || !top.name) return null;

    let hoursRemaining = null;
    if (top.aggregate_at) {
      hoursRemaining = (new Date(top.aggregate_at) - new Date()) / 3600000;
    }

    return { name: top.name, hoursRemaining };
  } catch (err) {
    console.warn("⚠️ 抓取活動狀態失敗，改用預設發噗文字：", err.message);
    return null;
  }
}

function buildPlurkContent(eventStatus) {
  // 如果有手動指定 PLURK_CONTENT，優先用手動指定的（保留手動覆寫的彈性）
  if (PLURK_CONTENT) return PLURK_CONTENT;

  const hashtags = "#世界計畫 #台服 #預測分數線";

  if (!eventStatus) {
    return `${hashtags}\n本場活動排行預測（自動發送）`;
  }

  const remainText = eventStatus.hoursRemaining !== null && eventStatus.hoursRemaining > 0
    ? `，距結算約 ${Math.round(eventStatus.hoursRemaining * 10) / 10} 小時`
    : "";

  return `${hashtags}\n【${eventStatus.name}】排行預測${remainText}`;
}

function getOAuthClient() {
  return OAuth({
    consumer: { key: PLURK_APP_KEY, secret: PLURK_APP_SECRET },
    signature_method: "HMAC-SHA1",
    hash_function(base_string, key) {
      return crypto.createHmac("sha1", key).update(base_string).digest("base64");
    },
  });
}

async function postToPlurk(imageBuffer, content) {
  const oauth = getOAuthClient();
  const token = { key: PLURK_ACCESS_TOKEN, secret: PLURK_ACCESS_SECRET };
  const url = "https://www.plurk.com/APP/Timeline/plurkAdd";

  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "POST" }, token));

  const form = new FormData();
  form.append("qualifier", PLURK_QUALIFIER);
  form.append("content", content);
  form.append("image", new Blob([imageBuffer], { type: "image/png" }), "prediction.png");

  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeader },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `發噗失敗（HTTP ${res.status}）：${text}\n` +
      `如果錯誤跟 image 參數有關，代表這個帳號/App 權限不支援在 plurkAdd 直接夾帶圖片，\n` +
      `需要改成先呼叫 /APP/Timeline/uploadPicture 取得圖片網址，再把網址放進 content 文字裡。`
    );
  }
  console.log("✅ 發噗成功：", text);

  let plurkId = null;
  try {
    const parsed = JSON.parse(text);
    plurkId = parsed.plurk_id ?? (parsed.plurk && parsed.plurk.plurk_id) ?? null;
  } catch {
    console.warn("⚠️ 無法解析發噗回應內容，跳過 plurk_id 追蹤登記");
  }
  return plurkId;
}

async function trackPlurk(plurkId) {
  if (!APPS_SCRIPT_BASE_URL || !plurkId) return;
  try {
    const url = `${APPS_SCRIPT_BASE_URL}?mode=trackPlurk&plurkId=${encodeURIComponent(plurkId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`⚠️ 登記 plurk_id 追蹤失敗（HTTP ${res.status}），互動回覆功能這次不會盯到這則噗`);
      return;
    }
    console.log(`📌 已登記追蹤 plurk_id=${plurkId}，之後留言會被輪詢腳本檢查`);
  } catch (err) {
    console.warn("⚠️ 登記 plurk_id 追蹤時發生錯誤：", err.message);
  }
}

async function main() {
  assertEnv();

  console.log(`正在開啟：${TARGET_URL}，準備點擊「生成分享圖片」按鈕`);
  const imageBuffer = await fetchShareImage();

  // 存一份在 Actions 的 log 裡，方便除錯（例如確認抓到的是不是空白圖）
  fs.writeFileSync("prediction-preview.png", imageBuffer);

  console.log("正在查詢活動狀態，組發噗文字...");
  const eventStatus = await fetchEventStatus();
  const content = buildPlurkContent(eventStatus);
  console.log("發噗內容：\n" + content);

  console.log("正在發送到噗浪...");
  const plurkId = await postToPlurk(imageBuffer, content);
  await trackPlurk(plurkId);
}

main().catch((err) => {
  console.error("❌ 執行失敗：", err.message);
  process.exit(1);
});

