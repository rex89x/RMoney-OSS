# CICD_SETUP

> 這份文件列出 `.github/workflows/` 需要的所有 GitHub Secrets。
> 把每個 secret 貼到 **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**。

---

## Secrets 清單

| Secret | 取得方式 | 用途 |
|---|---|---|
| `FIREBASE_PROJECT_ID` | `personal-hub-prod` | 所有 firebase CLI 命令 |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Console → Project Settings → Service Accounts → Generate new private key (整份 JSON) | Hosting deploy |
| `FIREBASE_TOKEN` | 本機 `firebase login:ci` 產生 | Rules / Indexes deploy |
| `VITE_FIREBASE_API_KEY` | Firebase Web App config | Build-time inject |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase Web App config | Build-time inject |
| `VITE_FIREBASE_PROJECT_ID` | 同上 | Build-time inject |
| `VITE_FIREBASE_STORAGE_BUCKET` | 同上 | Build-time inject |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | 同上 | Build-time inject |
| `VITE_FIREBASE_APP_ID` | 同上 | Build-time inject |
| `VITE_GOOGLE_MAPS_API_KEY` | GCP Credentials (HTTP referrer-restricted key) | Build-time inject |
| `VITE_APPS_SCRIPT_URL` | Apps Script → Deploy → Web App URL | Build-time inject |
| `CLASPRC_JSON` | 本機 `~/.clasprc.json` 全部內容 | Apps Script auth |
| `CLASP_JSON` | 本機 `apps-script/.clasp.json` 全部內容 | Apps Script 專案 id |
| `CLASP_DEPLOYMENT_ID` | `cd apps-script && clasp deployments` 列出的 id | Apps Script 版本管理 |

## Variables（Settings → Secrets and variables → Actions → Variables）

| Variable | 值 | 用途 |
|---|---|---|
| `ENABLE_DEPLOY` | `true` | 沒設時所有 deploy workflow 與需要 service account 的 rules dry-run 都會跳過；secrets 補齊後再開 |
| `VITE_ADMIN_EMAILS` | （選填）逗號分隔的 email | 額外視為 admin 的帳號；一般以 `users/{uid}.role` 為準 |
| `DEPLOY_STORAGE` | （選填）`true` | 啟用 Storage rules 部署 |

---

## 取得指令範例

```bash
# FIREBASE_TOKEN
firebase login:ci

# CLASPRC_JSON (raw)
cat ~/.clasprc.json | pbcopy

# CLASP_JSON (raw)
cat apps-script/.clasp.json | pbcopy

# CLASP_DEPLOYMENT_ID
cd apps-script && clasp deployments
# 輸出類似：
# - AKfycbwxxxxx @1 - v1
# 取 AKfycbwxxxxx 作為 DEPLOYMENT_ID (若首次沒有，先 clasp deploy 一次)

# FIREBASE_SERVICE_ACCOUNT (整份 JSON file content)
cat path/to/firebase-adminsdk-xxx.json | pbcopy
```

---

## 驗收 end-to-end

1. 改 `apps/web/src/features/dashboard/home-dashboard.tsx` 某段文字
2. `git checkout -b test/cicd && git commit -am "test: cicd" && git push -u origin test/cicd`
3. 開 PR
4. GitHub Actions 應自動跑 `CI` workflow → 全綠
5. `Deploy Hosting & Rules` 跑完會留 Firebase Hosting preview URL 在 PR 留言
6. Merge PR → `main` 上的 `Deploy Hosting & Rules` 開跑
7. 2-3 分鐘內到 `https://<project>.web.app` 看到改動

---

## 常見問題

### Deploy 403 forbidden
- Service account 權限不足 → 加上 Firebase Hosting Admin

### Rules deploy failed
- Token 過期 → 本機重跑 `firebase login:ci` 更新 `FIREBASE_TOKEN`

### Apps Script `clasp push` fails
- `CLASPRC_JSON` 過期（約 30 天）→ 本機重跑 `clasp login` 更新

### Build error "firebase:xxx undefined"
- VITE_* secret 沒設 → 檢查 secrets list
