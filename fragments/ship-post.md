<projects_sync_ship_post>
**GitHub Projects sync (projects-sync capability)**

This project syncs its `.planning/ROADMAP.md` to GitHub Issues/Projects. After shipping, ensure the board reflects the merged state:

- Run `gsd-tools projects-sync sync` (or `/gsd:projects-sync sync`) so completed phases close their corresponding GitHub Issues.
- If a Projects v2 board is configured (`projects-sync.board: true`), confirm the issue's status field advanced to the mapped value.
- Append a short **Projects Sync** note to the PR body summarising the receipt at `.planning/projects-sync/SYNC-RECEIPT.json` (issues created/updated/closed). If the sync was skipped (no token / API outage), say so — this hook is `onError: skip` and never blocks shipping.
</projects_sync_ship_post>
