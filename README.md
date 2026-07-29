# PJSK 排行預測噗浪機器人

定期截圖 `score_predict.html` 的排行預測畫面，自動發到噗浪。

## 架構

```
GitHub Actions（定時觸發）
   → Playwright 開啟 score_predict.html，截圖指定區塊
   → 用 OAuth 1.0a 簽名，呼叫 Plurk API 發噗（含圖片）
```

沒有用 Google Apps Script，是因為 Apps Script 沒辦法跑無頭瀏覽器截圖網頁畫面；GitHub Actions 的 runner 本身就是一台完整的 Linux 機器，可以跑 Playwright。

---

## Step 1：申請 Plurk App（App Key / App Secret）

1. 建議先準備一個要當機器人的噗浪帳號（也可以用自己的帳號，但機器人帳號比較乾淨）。
2. 登入該帳號後，開啟 <https://www.plurk.com/PlurkApp/>，點「註冊新的應用程式」。
3. 填寫表單：
   - **應用程式名稱 / 說明**：隨意，例如「PJSK 排行預測機器人」
   - **應用程式網站**：可以填你的 GitHub Pages 網址
   - **Callback URL**：填 `oob`（out-of-band，因為我們用手動流程，不需要真的架一個 callback 網站）
   - **權限等級**：務必選「可讀取、寫入及存取隱私資料」這一級，否則沒辦法發噗
4. 送出後，會拿到一組 **App Key（Consumer Key）** 和 **App Secret（Consumer Secret）**，先記下來。

## Step 2：取得 Access Token（只需要做一次）

這一步是要讓你的 App「被授權」可以用某個帳號的身分發噗。在你自己的電腦上（需要先安裝 Node.js 18 以上版本）：

```bash
cd pjsekai-plurk-bot
npm install
PLURK_APP_KEY=你的AppKey PLURK_APP_SECRET=你的AppSecret npm run get-token
```

執行後終端機會印出一個授權網址，用「要當機器人的帳號」登入並授權，授權完成的頁面會顯示一組驗證碼，貼回終端機，就會印出四組金鑰：

```
PLURK_APP_KEY=...
PLURK_APP_SECRET=...
PLURK_ACCESS_TOKEN=...
PLURK_ACCESS_SECRET=...
```

這四組之後不會變，存好即可，這個腳本只需要跑一次。

## Step 3：把金鑰放進 GitHub Secrets

在你的 GitHub repo（例如另外新開一個 `pjsekai-plurk-bot`，或放進現有的 `pjsekai` repo）：

`Settings → Secrets and variables → Actions → New repository secret`

依序新增：
- `PLURK_APP_KEY`
- `PLURK_APP_SECRET`
- `PLURK_ACCESS_TOKEN`
- `PLURK_ACCESS_SECRET`

## Step 4：調整截圖目標

打開 `.github/workflows/post-prediction.yml`，把 `TARGET_SELECTOR` 改成你網頁裡實際要截圖的區塊，例如某個包住排行表格的 `<div id="predictionSection">`，這樣截圖才不會連導覽列、其他分頁的東西都一起截進去。

如果排行資料是非同步從 API 抓回來才渲染，`scripts/post-to-plurk.js` 裡的 `page.waitForTimeout(4000)` 可以視情況調長，避免截到「載入中」的畫面。

## Step 4.5：活動期間判斷（全自動，不用手動維護日期）

排程本身是固定每天台灣時間 08:00 ~ 隔天 00:00 每小時觸發，但實際會不會真的發文，是由 workflow 裡的 `check-date` 這個 job 自動判斷的：它會打你 Apps Script 的 `mode=proxy&target=top100`，抓出目前活動的 `start_at`（開始時間）跟 `aggregate_at`（也就是你資料庫裡的 `last_aggregate_at`，代表分數結算、預測失去意義的時間點），現在時間如果落在這個區間內才會繼續截圖發文，否則自動跳過。

也就是說：
- 活動還沒開始 → 自動跳過
- 過了 `aggregate_at`（已經結算，不再是「預測」）→ 自動跳過
- 中間這段才會真的發文

不用每次活動開始/結束都手動去改任何設定，workflow 每次觸發時都會重新查詢一次最新狀態。如果哪次 Apps Script 或 HiSekai API 剛好打不通，會保守地跳過那一次（不發文），而不是硬發一張可能是空的截圖。

## Step 5：先手動測試一次

把檔案 commit、push 上去後，到 GitHub repo 的 `Actions` 分頁，選 `發送排行預測到噗浪` 這個 workflow，按右上角 `Run workflow` 手動觸發一次，確認：

1. 有沒有成功發噗到你的噗浪帳號
2. 截圖的畫面對不對（可以在該次執行的 `Artifacts` 下載 `prediction-preview.png` 檢查）

確認沒問題後，`cron` 排程就會照設定的時間自動執行。目前預設是台灣時間每天 09:00 / 13:00 / 21:00，可以自己調整 `cron` 那行（記得 cron 是 UTC 時間，要 −8 小時換算）。

---

## 已知眉角

- **`plurkAdd` 直接夾帶圖片**：目前腳本是直接在 `plurkAdd` 這個 API 呼叫裡用 multipart 夾帶 `image` 欄位一起送出。如果你測試時噗浪回傳跟圖片參數有關的錯誤，代表這個帳號/App 權限不支援這樣直接夾圖，需要改成：先呼叫 `/APP/Timeline/uploadPicture` 上傳圖片拿到網址，再把網址寫進 `content` 文字裡面（噗浪內文支援貼圖片網址）。這部分我在程式的錯誤訊息裡也留了提示。
- **API 呼叫頻率限制**：Plurk API 對每個 App 有每日呼叫次數上限，一般個人用途的排程（一天幾次）通常沒問題，但不建議設定太密集（例如每幾分鐘一次）。
- **金鑰安全性**：四組金鑰只能放在 GitHub Secrets，不要寫進程式碼或 commit 進版控。
