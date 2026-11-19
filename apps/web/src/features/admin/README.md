# admin — 管理員頁

## 職責
- 只有一個 route-level 元件 `admin-page.tsx`（default export，由 `router.tsx` lazy 載入，掛在 `/admin`）。
- 本身不含任何業務邏輯，只是把 `features/access` 的 `AccessPanel` 包上 `PageHeader` + `ErrorBoundary`。
- 白名單、使用者角色、共同帳本成員權限的實際邏輯與文件都在 `features/access/README.md`。

## 資料模型
- 本 feature 不擁有 collection。實際讀寫的是 `config/allowedEmails`、`config/guestEmails`、`users/*`（經由 `features/access`）。

## 與其他 feature 的依賴
- `features/access`：`AccessPanel`（同一個面板也出現在 設定 → 權限 分頁，僅 admin 看得到）。

## 存取控制
- 側欄 / TabBar：`components/layout` 的 nav 設定 `adminOnly: true`，非 admin 看不到入口。
- `/admin` route 本身沒有 guard；`AccessPanel` 內部用 `useAuth().isAdmin` 判斷，非 admin 只會看到提示，不會渲染管理介面。
- 真正的寫入權限由 `firestore.rules`（`isAdmin()`）把關；前端判斷只是體驗層（CLAUDE.md §5.8）。

## Apps Script 端
- 無。邀請 / 加入共同帳本相關的 action（例如 `joinHousehold`）屬於 `features/access` / `features/household`。

## 注意事項
- 不符合 CLAUDE.md §6 的完整資料夾結構（沒有 `index.ts` / `api.ts` / `hooks.ts`），因為它只是頁面殼。新增管理功能時，邏輯請放進 `features/access` 或新的 feature，不要直接寫在這裡。
