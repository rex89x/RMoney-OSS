# Feature: auth

職責：Google SSO 登入流程、白名單檢查、建立使用者文件、登出清除 cache。

關鍵檔：
- `login-page.tsx` — `/login` UI
- `@/hooks/use-auth` — `useInitAuth` (root), `useAuth` (consumers), `signInWithGoogle`, `signOutAndClear`
- `@/stores/auth-store` — 3-state auth (`checking | unauthed | authed`)

**禁止**：`signInWithPopup`、跳過 whitelist。
