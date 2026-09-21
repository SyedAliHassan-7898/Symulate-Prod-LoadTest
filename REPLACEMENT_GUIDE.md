# v9 replacement notes

Use the full v9 ZIP as the preferred replacement. If applying only changed files, replace the files from the changed-files ZIP without formatting unrelated code.

v9 specifically fixes the Anam Phase 1 false failure where a project was already `ACTIVE`, invitations had succeeded, all 20 candidates were assigned, and candidate portal-token login worked, but the project payload still reported `candidateAccess=false`.

Do not add `candidateAccess=true` as a hard activation requirement again. Treat it as diagnostic until the backend contract guarantees it.

# v8 Replacement Guide

Recommended: use the complete v8 ZIP as a clean project folder.

1. Extract v8 to a new directory.
2. Run `npm install`.
3. Run `npm run playwright:install` and allow it to finish.
4. Copy your existing `.env` values into the new `.env.example` structure.
5. Add `PERFORMANCE_PROFILE=auto`.
6. Run `npm run validate`.
7. Run `npm run smoke`.
8. Run `npm run load:10`.
9. Run `npm run validate:e2e-runner`.
10. Run `npm run e2e:anam:outage503` when Anam resilience validation is required.

If you replace files in an existing v7 folder, replace:

- `config/thresholds.js`
- `scripts/run.js`
- `scripts/e2e-no-anum-full.js`
- `package.json`
- `package-lock.json`
- `.env.example`
- `README.md`
- `FIXES_APPLIED.md`
- `ENV_MIGRATION.md`

Do not copy an old `node_modules` directory into v8.
