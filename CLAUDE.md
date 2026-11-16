# CLAUDE.md

Read `handover.md` first — it has the full project context.

## Rules
- **Do NOT use the `noma` Soft1 MCP connector for Vlachos Bros** — it points at a different Soft1 installation. Schema/field questions → ask the user.
- **Bump `package.json` "version" on EVERY merge to `main`** (patch = fix, minor = feature). The live site shows it (login page + planner toolbar via `/api/version`). State the new version when reporting a merge.
- Dates shown/typed in the UI are always `dd/mm/yyyy` (24h times) — use `DateFmt` (`public/src/date-fmt.js`).
- Embedded mode (`legacy/embedded/`) is frozen — no changes there.
- All SQL lives in `soft1/Foxline.planning.js`; after changing it, remind the user to paste it into Soft1.
