# v8 Environment Migration

Keep your existing credentials and URLs. Add this setting:

```env
PERFORMANCE_PROFILE=auto
```

`auto` resolves to:

- `strict` in smoke mode;
- `baseline` in load mode.

The normal project lifecycle remains controlled by:

```env
SEND_PROJECT_INVITATIONS=false
```

or:

```env
SEND_PROJECT_INVITATIONS=true
```

Normal `smoke` and `load` commands never override that value.

The specialized Anam/browser E2E npm commands explicitly enable invitations for their isolated E2E project because those commands must start candidate sessions. That command-level override does not edit `.env` and does not affect subsequent smoke/load runs.

`NUM_CANDIDATES=20` remains the recommended managed-project default. `data/candidates.csv` remains the canonical seed file.

## v9

No new required environment variables were introduced. Existing v8 `.env` files remain compatible. `SEND_PROJECT_INVITATIONS` remains authoritative for normal smoke/load runs. Specialized Anam E2E npm commands continue to enable invitations for their isolated browser/session project.
