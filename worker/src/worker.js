/**
 * Cloudflare Workers 版本：輪詢機器人時間軸上看得到的最新噗（含好友發的噗），
 * 比對內容裡有沒有 "pjsk" 查詢指令，符合的話直接回覆在那則噗底下。
 *
 * 使用方式：直接在自己的噗裡打「pjsk T100」，不需要 @提及機器人。
 * 也支援區間查詢「pjsk T100-T1000」，會回傳範圍內所有有追蹤的里程碑；
 * 超過噗浪 360 字上限時會自動拆成多則留言依序回覆，一次最多查 5 個里程碑。
 *
 * 限定機器人好友才能使用：每次回覆前會即時向 Plurk API 查詢發噗者是不是好友，
 * 不是好友直接忽略、不回覆。查詢完就丟棄，不會把發噗者的帳號 ID 存進任何地方。
 *
 * 需要設定的環境變數（用 `wrangler secret put` 設定，不寫進程式碼或 wrangler.toml）：
 *   PLURK_APP_KEY / PLURK_APP_SECRET / PLURK_ACCESS_TOKEN / PLURK_ACCESS_SECRET
 *   APPS_SCRIPT_BASE_URL - 你的 Apps Script /exec 網址
 */
import crypto from "node:crypto";
import OAuth from "oauth-1.0a";

function getOAuthClient(appKey, appSecret) {
  return OAuth({
    consumer: { key: appKey, secret: appSecret },
    signature_method: "HMAC-SHA1",
    hash_function(base_string, key) {
      return crypto.createHmac("sha1", key).update(base_string).digest("base64");
    },
  });
}

// 跟 Apps Script 的 PROGRESS_CURVE_RANKS 保持一致，之後如果那邊的里程碑清單有調整，
// 這裡也要跟著手動同步一次，才能正確判斷區間查詢該涵蓋哪些名次
const PROGRESS_CURVE_RANKS = [
  10, 20, 30, 40, 50, 100,
  200, 300, 400, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 10000, 20000, 30000, 50000, 100000,
];

const MAX_RANGE_MILESTONES = 5; // 區間查詢一次最多查幾個里程碑，避免請求次數爆掉、也避免留言拆太多則
const PLURK_CONTENT_LIMIT = 350; // 留一點餘裕，噗浪單則上限是 360 字

function fmtNum(n) {
  return Number(n).toLocaleString("zh-TW");
}

// 解析文字裡有沒有 "pjsk T100" / "pjsk 123456789" 這種指令（不限定在開頭，
// 這樣就算前面還接了其他話，例如「隨手發一下 pjsk T100」也抓得到）
function parseCommand(rawContent) {
  const match = String(rawContent || "").match(/pjsk\s+(\S+)/i);
  if (!match) return null;
  const arg = match[1].trim();

  const rangeMatch = arg.match(/^t?(\d+)\s*-\s*t?(\d+)$/i);
  if (rangeMatch) {
    const from = Number(rangeMatch[1]);
    const to = Number(rangeMatch[2]);
    return { type: "range", from: Math.min(from, to), to: Math.max(from, to) };
  }

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

async function runOnce(env) {
  const {
    PLURK_APP_KEY,
    PLURK_APP_SECRET,
    PLURK_ACCESS_TOKEN,
    PLURK_ACCESS_SECRET,
    APPS_SCRIPT_BASE_URL,
  } = env;

  const missing = ["PLURK_APP_KEY", "PLURK_APP_SECRET", "PLURK_ACCESS_TOKEN", "PLURK_ACCESS_SECRET", "APPS_SCRIPT_BASE_URL"]
    .filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`缺少環境變數：${missing.join(", ")}`);
  }

  const oauth = getOAuthClient(PLURK_APP_KEY, PLURK_APP_SECRET);
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
    // application/x-www-form-urlencoded 格式的請求，body 欄位必須一起參與簽名計算
    const authHeader = oauth.toHeader(oauth.authorize({ url, method: "POST", data: params }, token));
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

  // ---- 好友檢查：只在單次執行期間查詢並暫存於記憶體，執行結束就丟棄，不落地存檔 ----
  let cachedBotUserId = null;
  let cachedFriendIdSet = null;

  async function getBotUserId() {
    if (cachedBotUserId) return cachedBotUserId;
    const me = await plurkGet("/APP/Users/me");
    cachedBotUserId = me.id;
    return cachedBotUserId;
  }

  async function loadFriendIdSet() {
    if (cachedFriendIdSet) return cachedFriendIdSet;
    const botUserId = await getBotUserId();
    const idSet = new Set();
    let offset = null;

    for (let page = 0; page < 20; page++) {
      const params = { user_id: botUserId };
      if (offset) params.offset = offset;
      const friends = await plurkGet("/APP/FriendsFans/getFriendsByOffset", params);
      if (!Array.isArray(friends) || !friends.length) break;
      friends.forEach((f) => idSet.add(String(f.id)));
      if (friends.length < 30) break;
      offset = friends[friends.length - 1].id;
    }

    cachedFriendIdSet = idSet;
    return idSet;
  }

  async function isFriend(userId) {
    const friendIdSet = await loadFriendIdSet();
    return friendIdSet.has(String(userId));
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
      const periodText = data.eventId ? `第${data.eventId}期　` : "";
      const remainText = data.hoursRemaining !== null
        ? `，距結算約 ${data.hoursRemaining} 小時`
        : "";
      return `${periodText}【${data.eventName}】T${data.rank}\n目前分數：${fmtNum(data.currentScore)}\n預測結算：${fmtNum(data.predictedScore)}${remainText}`;
    }

    if (command.type === "player") {
      const data = await appsScript({ mode: "queryPlayer", id: command.value });
      if (data.error === "not_in_top100") {
        return `這個 ID 目前不在前 100 名內，查不到即時資料，可以改用 "pjsk T名次" 查里程碑分數線。`;
      }
      if (data.error === "no_live_data") {
        return "目前抓不到即時資料，晚點再查一次看看。";
      }
      const periodText = data.eventId ? `第${data.eventId}期　` : "";
      return `${periodText}【${data.eventName}】\n${data.name || "玩家"} 目前 T${data.rank}\n分數：${fmtNum(data.score)}`;
    }

    return `指令看不懂喔，目前支援：\npjsk T100（查里程碑名次）\npjsk 123456789（查玩家ID，限前100名內）\npjsk T100-T1000（查區間內所有里程碑）`;
  }

  // 把一串文字行，依照噗浪單則字數上限，貪心地打包成多則訊息
  function chunkLines(lines, limit) {
    const chunks = [];
    let current = "";
    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length > limit && current) {
        chunks.push(current);
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  async function buildRangeReplies(command) {
    const milestones = PROGRESS_CURVE_RANKS.filter((r) => r >= command.from && r <= command.to);

    if (!milestones.length) {
      return [`T${command.from}-T${command.to} 這個範圍內沒有支援查詢的里程碑喔。`];
    }
    if (milestones.length > MAX_RANGE_MILESTONES) {
      return [`這個範圍內有 ${milestones.length} 個里程碑，一次查太多了，麻煩縮小範圍（一次最多查 ${MAX_RANGE_MILESTONES} 個）。`];
    }

    let eventId = null;
    let eventName = null;
    const lines = [];
    for (const rank of milestones) {
      const data = await appsScript({ mode: "queryRank", rank });
      if (data.error) {
        lines.push(`T${rank}：目前查不到資料`);
        continue;
      }
      eventId = eventId || data.eventId;
      eventName = eventName || data.eventName;
      lines.push(`T${rank} 目前:${fmtNum(data.currentScore)} 預測:${fmtNum(data.predictedScore)}`);
    }

    const periodText = eventId ? `第${eventId}期　` : "";
    const header = eventName
      ? `${periodText}【${eventName}】T${command.from}-T${command.to} 區間查詢`
      : `T${command.from}-T${command.to} 區間查詢`;

    const chunks = chunkLines(lines, PLURK_CONTENT_LIMIT - header.length - 10);
    return chunks.map((chunk, i) => {
      const pageLabel = chunks.length > 1 ? `（${i + 1}/${chunks.length}）` : "";
      return `${header}${pageLabel}\n${chunk}`;
    });
  }

  // 統一入口：不管單一名次、玩家ID還是區間查詢，都回傳「一組要依序發送的訊息陣列」
  async function buildReplies(command) {
    if (command.type === "range") {
      return buildRangeReplies(command);
    }
    const text = await buildReply(command);
    return [text];
  }

  const botUserId = await getBotUserId();

  const plurksData = await plurkGet("/APP/Timeline/getPlurks", { limit: 20 });
  const plurks = plurksData.plurks || [];
  if (!plurks.length) {
    console.log("時間軸上沒有抓到任何噗，結束");
    return;
  }

  const { repliedIds } = await appsScript({ mode: "repliedResponses" });
  const repliedSet = new Set(repliedIds || []);

  for (const p of plurks) {
    const plurkId = String(p.plurk_id ?? p.id);
    if (repliedSet.has(plurkId)) continue;

    const posterUserId = p.owner_id ?? p.user_id;
    if (posterUserId !== undefined && String(posterUserId) === String(botUserId)) continue; // 跳過機器人自己發的噗

    const content = p.content_raw || p.content || "";
    const command = parseCommand(content);
    if (!command) continue; // 沒有 pjsk 指令，不理會

    console.log(`收到指令：plurk_id=${plurkId} content="${content}"`);

    let friend = false;
    try {
      friend = posterUserId !== undefined ? await isFriend(posterUserId) : false;
    } catch (err) {
      console.warn(`⚠️ 查詢好友狀態失敗，保守當作非好友：${err.message}`);
    }

    if (!friend) {
      console.log(`發噗者非好友，不予理會：plurk_id=${plurkId}`);
      await appsScript({ mode: "markReplied", plurkId, responseId: plurkId });
      repliedSet.add(plurkId);
      continue;
    }

    let replyTexts;
    try {
      replyTexts = await buildReplies(command);
    } catch (err) {
      console.warn(`⚠️ 產生回覆內容失敗：${err.message}`);
      replyTexts = ["查詢時發生錯誤，晚點再試一次看看。"];
    }

    let anySucceeded = false;
    for (const replyText of replyTexts) {
      try {
        await plurkPost("/APP/Responses/responseAdd", {
          plurk_id: plurkId,
          qualifier: "says",
          content: replyText,
        });
        anySucceeded = true;
      } catch (err) {
        console.warn(`⚠️ 其中一則回覆失敗：${err.message}`);
      }
    }

    if (anySucceeded) {
      console.log(`✅ 已回覆 plurk_id=${plurkId}（共 ${replyTexts.length} 則）`);
    } else {
      console.warn(`⚠️ 全部回覆都失敗，這則下次還會再嘗試：plurk_id=${plurkId}`);
      continue; // 全部都失敗才不標記已處理，讓下次還會重試
    }

    await appsScript({ mode: "markReplied", plurkId, responseId: plurkId });
    repliedSet.add(plurkId);
  }
}

async function triggerGitHubWorkflow(env, forceRun = false) {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_WORKFLOW_FILE } = env;

  const missing = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO", "GITHUB_WORKFLOW_FILE"]
    .filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`缺少環境變數：${missing.join(", ")}`);
  }

  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_FILE}/dispatches`;

  const body = { ref: "main" };
  if (forceRun) {
    body.inputs = { force_run: "true" };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pjsekai-plurk-bot-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status !== 204) {
    const text = await res.text();
    throw new Error(`觸發 GitHub workflow 失敗（HTTP ${res.status}）：${text}`);
  }
  console.log(`✅ 已觸發 GitHub workflow：post-prediction.yml${forceRun ? "（強制執行）" : ""}`);
}

export default {
  // Cron Trigger 觸發的入口：wrangler.toml 裡設定了兩組排程，依觸發的 cron 表達式分流
  async scheduled(event, env, ctx) {
    if (event.cron === env.GITHUB_TRIGGER_CRON) {
      // 整點觸發：去按 GitHub 那個 workflow_dispatch，取代不可靠的 GitHub schedule
      ctx.waitUntil(
        triggerGitHubWorkflow(env).catch((err) => console.error("❌ 觸發 GitHub workflow 失敗：", err.message))
      );
    } else {
      // 其他（每分鐘）：照常跑留言查詢邏輯
      ctx.waitUntil(
        runOnce(env).catch((err) => console.error("❌ 執行失敗：", err.message))
      );
    }
  },

  // 手動測試用：部署後可以用瀏覽器開下面兩個路徑手動觸發
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      try {
        await runOnce(env);
        return new Response("執行完成，看 Cloudflare dashboard 的 Logs 確認結果");
      } catch (err) {
        return new Response(`執行失敗：${err.message}`, { status: 500 });
      }
    }
    if (url.pathname === "/trigger-github") {
      const forceRun = url.searchParams.get("force") === "true";
      try {
        await triggerGitHubWorkflow(env, forceRun);
        return new Response(
          forceRun
            ? "已觸發 GitHub workflow（強制執行，會略過活動期間檢查直接截圖發文），去 GitHub 的 Actions 分頁確認"
            : "已觸發 GitHub workflow，去 GitHub 的 Actions 分頁確認"
        );
      } catch (err) {
        return new Response(`觸發失敗：${err.message}`, { status: 500 });
      }
    }
    return new Response("pjsk 噗浪機器人 worker 正常運作中");
  },
};
