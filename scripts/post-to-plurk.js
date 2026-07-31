/**
 * 開啟 score_predict.html，點擊「📷 生成分享圖片」按鈕，
 * 攔截網站本身產生的下載檔案（generateShareImage() → downloadCanvas()），
 * 先用 /APP/Timeline/uploadPicture 把圖片上傳到噗浪拿到圖片網址，
 * 再把網址接在文字後面一起發噗（噗浪會自動把純網址渲染成圖片；
 * 這個帳號/App 權限不支援在 plurkAdd 裡直接夾帶圖片檔案，所以不能一步到位）。
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

  // 「同角色歷史中位數」是網站另外打一次 mode=character_stats API 才會算出來的，
  // 跟頁面主要即時資料是分開的非同步流程，耗時會隨資料量浮動，
  // 所以不用猜固定秒數，改成直接等這個 API 真的回應完成。
  // 監聽要在 goto 之前就設好，避免請求太快完成而錯過。
  const charStatsResponsePromise = page
    .waitForResponse((res) => res.url().includes("mode=character_stats"), { timeout: 30000 })
    .catch(() => null); // 30秒內沒等到（例如活動類型本來就不會打這隻API、或API異常）就放棄等待，改用備援緩衝時間

  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(SHARE_BUTTON_SELECTOR, { timeout: 30000 });

  const charStatsResponse = await charStatsResponsePromise;
  if (charStatsResponse) {
    console.log("已確認歷史中位數資料載入完成（收到 mode=character_stats 回應）");
  } else {
    console.log("沒有等到 mode=character_stats 回應（可能不是一般活動、或逾時），改用備援緩衝時間");
  }

  // 不管有沒有等到，都再留一點緩衝時間讓表格重新渲染完成（buildRankTable 重繪本身很快，這是保險）
  await page.waitForTimeout(2000);

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

    return { id: top.id, name: top.name, hoursRemaining };
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

  const periodText = eventStatus.id ? `第${eventStatus.id}期　` : "";
  const remainText = eventStatus.hoursRemaining !== null && eventStatus.hoursRemaining > 0
    ? `，距結算約 ${Math.round(eventStatus.hoursRemaining * 10) / 10} 小時`
    : "";

  return `${hashtags}\n${periodText}【${eventStatus.name}】排行預測${remainText}`;
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

async function uploadPicture(imageBuffer) {
  const oauth = getOAuthClient();
  const token = { key: PLURK_ACCESS_TOKEN, secret: PLURK_ACCESS_SECRET };
  const url = "https://www.plurk.com/APP/Timeline/uploadPicture";

  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "POST" }, token));

  const form = new FormData();
  form.append("image", new Blob([imageBuffer], { type: "image/png" }), "prediction.png");

  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeader },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`上傳圖片失敗（HTTP ${res.status}）：${text}`);
  }

  const parsed = JSON.parse(text);
  const imageUrl = parsed.full || parsed.thumbnail;
  if (!imageUrl) {
    throw new Error(`上傳圖片成功但回應裡沒有圖片網址：${text}`);
  }
  return imageUrl;
}

async function postToPlurk(imageBuffer, content) {
  const oauth = getOAuthClient();
  const token = { key: PLURK_ACCESS_TOKEN, secret: PLURK_ACCESS_SECRET };

  console.log("正在上傳圖片...");
  const imageUrl = await uploadPicture(imageBuffer);
  console.log("圖片網址：", imageUrl);

  const url = "https://www.plurk.com/APP/Timeline/plurkAdd";
  // 把圖片網址接在文字後面，噗浪會自動把純網址渲染成圖片
  const contentWithImage = `${content}\n${imageUrl}`;
  const bodyParams = { qualifier: PLURK_QUALIFIER, content: contentWithImage };

  // application/x-www-form-urlencoded 格式的請求，body 欄位必須一起參與簽名計算
  // （跟之前 multipart/form-data 夾帶圖片檔案時不同，那種格式不需要簽 body 欄位）
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "POST", data: bodyParams }, token));

  const form = new URLSearchParams(bodyParams);

  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`發噗失敗（HTTP ${res.status}）：${text}`);
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

