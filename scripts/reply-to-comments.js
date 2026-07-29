/**
 * 輪詢「最近發出去的排行預測噗」底下有沒有新留言，
 * 比對是否以 "pjsk" 開頭的查詢指令，符合的話自動回覆。
 *
 * 支援的指令格式（"pjsk" 後面接空白）：
 *   pjsk T100      → 查里程碑名次（限固定里程碑，例如 T10/20/.../100/200/500/1000...）
 *   pjsk 123456789 → 查玩家 ID 目前名次（僅限目前在前100名內的玩家）
 *
 * 需要的環境變數（放進 GitHub Secrets）：
 *   PLURK_APP_KEY / PLURK_APP_SECRET / PLURK_ACCESS_TOKEN / PLURK_ACCESS_SECRET
 *   APPS_SCRIPT_BASE_URL - 你的 Apps Script /exec 網址
 *
 * 可選的環境變數：
 *   TRACK_WINDOW_HOURS - 要往前追蹤幾小時內發的噗，預設 48
 */
import crypto from "crypto";
import OAuth from "oauth-1.0a";

const {
  PLURK_APP_KEY,
  PLURK_APP_SECRET,
  PLURK_ACCESS_TOKEN,
  PLURK_ACCESS_SECRET,
  APPS_SCRIPT_BASE_URL,
  TRACK_WINDOW_HOURS = "48",
} = process.env;

function assertEnv() {
  const required = [
    "PLURK_APP_KEY", "PLURK_APP_SECRET", "PLURK_ACCESS_TOKEN", "PLURK_ACCESS_SECRET",
    "APPS_SCRIPT_BASE_URL",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`缺少環境變數：${missing.join(", ")}`);
  }
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

const oauth = getOAuthClient();
const token = { key: PLURK_ACCESS_TOKEN, secret: PLURK_ACCESS_SECRET };

async function plurkGet(path, params = {}) {
  const url = `https://www.plurk.com${path}`;
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "GET", data: params }, token));
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${url}?${qs}`, { headers: { ...authHeader } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Plurk GET ${path} 失敗（HTTP ${res.status}）：${text}`);
  return JSON.parse(text);
}

async function plurkPost(path, params = {}) {
  const url = `https://www.plurk.com${path}`;
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: "POST" }, token));
  const form = new URLSearchParams(params);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Plurk POST ${path} 失敗（HTTP ${res.status}）：${text}`);
  return JSON.parse(text);
}

async function appsScript(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${APPS_SCRIPT_BASE_URL}?${qs}`);
  if (!res.ok) throw new Error(`Apps Script 呼叫失敗（HTTP ${res.status}）：${await res.text()}`);
  return res.json();
}

function fmtNum(n) {
  return Number(n).toLocaleString("zh-TW");
}

// 解析 "pjsk T100" / "pjsk 123456789"，非 pjsk 開頭的留言回傳 null（不理會）
function parseCommand(rawContent) {
  const match = String(rawContent || "").trim().match(/^pjsk\s+(.+)$/i);
  if (!match) return null;
  const arg = match[1].trim();

  const rankMatch = arg.match(/^t?(\d+)$/i);
  if (rankMatch) {
    return { type: "rank", value: Number(rankMatch[1]) };
  }
  const idMatch = arg.match(/^\d+$/);
  if (idMatch) {
    return { type: "player", value: arg };
  }
  return { type: "unknown", value: arg };
}

async function buildReply(command) {
  if (command.type === "rank") {
    const data = await appsScript({ mode: "queryRank", rank: command.value });
    if (data.error === "unsupported_rank") {
      return `T${command.value} 不是支援查詢的里程碑名次喔，支援的名次有：${data.supportedRanks.join(", ")}`;
    }
    if (data.error === "rank_not_found" || data.error === "no_live_data") {
      return `目前抓不到 T${command.value} 的即時資料，可能活動還沒開始或資料源暫時異常，晚點再查一次看看。`;
    }
    const remainText = data.hoursRemaining !== null
      ? `，距結算約 ${data.hoursRemaining} 小時`
      : "";
    return `【${data.eventName}】T${data.rank}\n目前分數：${fmtNum(data.currentScore)}\n預測結算：${fmtNum(data.predictedScore)}${remainText}`;
  }

  if (command.type === "player") {
    const data = await appsScript({ mode: "queryPlayer", id: command.value });
    if (data.error === "not_in_top100") {
      return `這個 ID 目前不在前 100 名內，查不到即時資料，可以改用 "pjsk T名次" 查里程碑分數線。`;
    }
    if (data.error === "no_live_data") {
      return "目前抓不到即時資料，晚點再查一次看看。";
    }
    return `【${data.eventName}】\n${data.name || "玩家"} 目前 T${data.rank}\n分數：${fmtNum(data.score)}`;
  }

  return `指令看不懂喔，目前支援：\npjsk T100（查里程碑名次）\npjsk 123456789（查玩家ID，限前100名內）`;
}

async function main() {
  assertEnv();

  const { plurkIds } = await appsScript({ mode: "trackedPlurks", hours: TRACK_WINDOW_HOURS });
  if (!plurkIds || !plurkIds.length) {
    console.log("目前沒有在追蹤範圍內的噗，結束");
    return;
  }
  console.log(`追蹤中的噗共 ${plurkIds.length} 則：${plurkIds.join(", ")}`);

  const { repliedIds } = await appsScript({ mode: "repliedResponses" });
  const repliedSet = new Set(repliedIds || []);

  for (const plurkId of plurkIds) {
    let responsesData;
    try {
      responsesData = await plurkGet("/APP/Responses/get", { plurk_id: plurkId });
    } catch (err) {
      console.warn(`⚠️ 讀取 plurk_id=${plurkId} 的留言失敗：${err.message}`);
      continue;
    }

    const responses = responsesData.responses || [];
    for (const response of responses) {
      const responseId = String(response.id);
      if (repliedSet.has(responseId)) continue;

      const command = parseCommand(response.content_raw);
      if (!command) continue; // 不是 pjsk 開頭，不理會

      console.log(`收到指令：plurk_id=${plurkId} response_id=${responseId} content="${response.content_raw}"`);

      let replyText;
      try {
        replyText = await buildReply(command);
      } catch (err) {
        console.warn(`⚠️ 產生回覆內容失敗：${err.message}`);
        replyText = "查詢時發生錯誤，晚點再試一次看看。";
      }

      try {
        await plurkPost("/APP/Responses/responseAdd", {
          plurk_id: plurkId,
          qualifier: "says",
          content: replyText,
        });
        console.log(`✅ 已回覆 response_id=${responseId}`);
      } catch (err) {
        console.warn(`⚠️ 回覆失敗，這則留言下次還會再嘗試：${err.message}`);
        continue; // 回覆失敗就不標記已回覆，留給下次重試
      }

      await appsScript({ mode: "markReplied", plurkId, responseId });
      repliedSet.add(responseId);
    }
  }
}

main().catch((err) => {
  console.error("❌ 執行失敗：", err.message);
  process.exit(1);
});
