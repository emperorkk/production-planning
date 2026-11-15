# LEGACY — embedded (x=external) planner — FROZEN

This is the last version of the planner that runs **inside Soft1** as an `x=external`
page (`window.external` COM: `GetSqlDataSet` / `RUNSQL`).

**Deprecated as of 2026-11-15. No further updates.** All operations now go through the
Cloudflare Worker (`public/` + `worker/` + `soft1/Foxline.planning.js`).

Kept only for reference / as a fallback. To (re)install it in Soft1:
`npm run sync-embedded-legacy` (copies this folder → `C:\SoftOne\Vlachos Bros\`).
