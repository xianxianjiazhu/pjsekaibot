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

// 等 mode=character_stats 真正回應完成（追蹤 302 轉址鏈，見下方說明）
// 注意：這裡故意不是 async function，只負責「設好監聽器、立刻回傳 promise」，
// 呼叫的人自己決定什麼時候要 await，不然如果這裡用 async+await，
// 呼叫當下就會卡住等待，來不及先做 page.goto()。
function waitForCharacterStats(page) {
  return page
    .waitForResponse((res) => {
      if (res.url().includes("mode=character_stats")) return true; // 沒被轉址的情況（保險用）
      const redirectedFrom = res.request().redirectedFrom();
      return Boolean(redirectedFrom && redirectedFrom.url().includes("mode=character_stats"));
    }, { timeout: 30000 })
    .catch(() => null);
}

// 常見里程碑裡，T5000 以下正常來說活動進行中一定會有人達到，
// 這個範圍內如果出現「無官方資料」，代表 border API 抓取異常，值得重新整理重試；
// T10000 以上（尤其 T50000、T100000）本來就常常沒人打到，是正常現象，不算異常。
const RELIABLE_BORDER_THRESHOLD = 5000;

// 直接讀表格每一列的內容，抓出哪些名次目前顯示「無官方資料」
async function getMissingBorderRanks(page) {
  return page
    .evaluate(() => {
      const rows = Array.from(document.querySelectorAll("#rankTableBody tr"));
      const missing = [];
      for (const tr of rows) {
        const rankCell = tr.querySelector(".rank-tag");
        if (!rankCell) continue;
        const rank = parseInt(rankCell.textContent.replace("T", ""), 10);
        if (Number.isNaN(rank)) continue;
        if ((tr.textContent || "").includes("無官方資料")) missing.push(rank);
      }
      return missing;
    })
    .catch(() => []);
}

// 判斷是不是「不正常的缺漏」：只要 T200~T5000 這個常見範圍內有任何一個顯示無官方資料，
// 就代表 border API 這次抓取異常，值得重新整理重試；高名次（T10000以上）缺漏是正常現象，不算。
async function isBorderDataMissing(page) {
  const missingRanks = await getMissingBorderRanks(page);
  return missingRanks.some((rank) => rank > 100 && rank <= RELIABLE_BORDER_THRESHOLD);
}

async function fetchShareImage() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // 「同角色歷史中位數」是網站另外打一次 mode=character_stats API 才會算出來的，
  // 跟頁面主要即時資料是分開的非同步流程，耗時會隨資料量浮動，
  // 所以不用猜固定秒數，改成直接等這個 API 真的回應完成。
  // 監聽要在 goto 之前就設好，避免請求太快完成而錯過。
  //
  // 注意：Apps Script 的 /exec 網址一定會先回傳 302 轉址到 googleusercontent.com/macros/echo?...
  // 這個 echo 網址本身不含 "mode=character_stats" 字樣，所以不能只比對網址字串，
  // 不然只會抓到「轉址那一瞬間」，抓不到「轉址後真正帶著資料的最終回應」。
  // 改成用 redirectedFrom() 追蹤：這個回應的請求是不是「從一個 character_stats 請求轉址過來的」。
  let charStatsResponsePromise = waitForCharacterStats(page);

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

  // 網站抓 border（T200以上）資料的 tryFetchBorder() 只有一次機會、5秒逾時、沒有重試，
  // 如果剛好那次 API 回應慢，常見名次（T5000以下）就會顯示「無官方資料」。
  // 這裡偵測到「常見名次缺漏」才重新整理頁面重試（高名次沒人達到的正常缺漏不算，不會誤觸發）。
  const MAX_RELOADS = 2;
  for (let attempt = 1; attempt <= MAX_RELOADS; attempt++) {
    const missingRanks = await getMissingBorderRanks(page);
    const abnormalMissing = missingRanks.filter((rank) => rank > 100 && rank <= RELIABLE_BORDER_THRESHOLD);
    if (!abnormalMissing.length) break;

    console.log(
      `⚠️ 偵測到常見名次缺漏（T${abnormalMissing.join("、T")}），研判是 border API 抓取異常，重新整理頁面重試（第 ${attempt}/${MAX_RELOADS} 次）...`
    );
    charStatsResponsePromise = waitForCharacterStats(page);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(SHARE_BUTTON_SELECTOR, { timeout: 30000 });
    await charStatsResponsePromise;
    await page.waitForTimeout(2000);

    if (attempt === MAX_RELOADS) {
      const stillMissing = await isBorderDataMissing(page);
      if (stillMissing) {
        console.warn("⚠️ 重新整理後 border 資料仍整批抓取失敗，這次先照現況送出，不再繼續重試");
      } else {
        console.log("✅ 重新整理後 border 資料已補齊");
      }
    }
  }

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

async function fetchEventStatusOnce() {
  const url = `${APPS_SCRIPT_BASE_URL}?mode=proxy&target=top100`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`⚠️ 查詢活動狀態失敗（HTTP ${res.status}）`);
    return null;
  }
  const top = await res.json();
  if (!top || !top.name) {
    console.warn(
      `⚠️ 查詢活動狀態沒有拿到活動名稱。回傳內容：${JSON.stringify(top).slice(0, 200)}`
    );
    return null;
  }

  let hoursRemaining = null;
  if (top.aggregate_at) {
    hoursRemaining = (new Date(top.aggregate_at) - new Date()) / 3600000;
  }

  return { id: top.id, name: top.name, hoursRemaining };
}

async function fetchEventStatus() {
  if (!APPS_SCRIPT_BASE_URL) return null;

  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fetchEventStatusOnce();
      if (result) return result;
    } catch (err) {
      console.warn(`⚠️ 抓取活動狀態失敗（第 ${attempt} 次）：${err.message}`);
    }

    if (attempt < MAX_ATTEMPTS) {
      console.log(`3 秒後重試查詢活動狀態（第 ${attempt + 1}/${MAX_ATTEMPTS} 次）...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  console.warn("⚠️ 重試後仍抓不到活動狀態，改用預設發噗文字");
  return null;
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

