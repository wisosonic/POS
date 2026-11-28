# 17 · Rolling the chain out: HQ, branches, backups, monitoring (P7)

Written for the owner and whoever installs. The idea: **HQ first, then one branch at a time, and each step proved before the next.** This is a fresh customer (nothing is migrated from the legacy Darwish system, which stays separate), so there is no cut-over night: a branch simply starts selling when it is connected and its first day checks out.

**Status:** the pieces below are built and tested on one machine (`cloud-hq/tests`, `npm run test:sandbox`). **Nothing here has run on real machines yet.** The install scripts have been dry-run and parsed on Windows but not used to install a service; the first real install is the real test, and §8 lists what to watch.

## 1. What goes where

| Machine | Runs | Data | Reached by |
|---|---|---|---|
| **HQ** (a PC or a rented server) | `cloud-hq`, on port 4000 | `hq.db` + `uploads/` (the product pictures) | Branches (HTTPS, outward only) and HQ staff |
| **Each branch's PC** | `branch-server` (port 3000), the tills' browsers | `pos.db` | The tills on the shop's network |
| **Each till PC with a printer elsewhere** | the print agent | none | The branch server |

Branches always call HQ, never the other way, so a branch behind a home router needs no open port. HQ is the one machine reachable from the internet: **put a TLS reverse proxy in front of it** (HQ itself speaks plain HTTP) and give it a real name; set that name in `ALLOWED_HOSTS` (the install script's `-PublicName`), or HQ refuses it.

## 2. Installing HQ

On the HQ machine, in `cloud-hq`: `npm install`, then `npm run build` (this builds **the HQ screen**, `docs/18`; without it HQ answers the API only), then in an administrator PowerShell:

```
powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1 -BackupDir D:\HQ-backups -BackupCopyDir E:\HQ-backups -PublicName hq.example.com -BindAll
```

`-DryRun` shows every step and changes nothing. It makes `C:\POS-HQ\service.env` (only administrators can read it), asks for the **backup passphrase** (write it down and keep it away from this machine: without it no backup can be restored), registers the scheduled task **Chain HQ** (starts at boot, restarts after 5 seconds if it stops) and waits for `GET /api/v1/healthz`. Logs: `C:\POS-HQ\logs\hq.log`, `hq.err.log`, `launcher.log`.

HQ then serves its screen at its own address (`https://<its name>/`). Make the first admin: `npm run create-admin --prefix cloud-hq -- <name> <a long password>`. Leave `HQ_ADMIN_TOKEN` unset. Sign in with `POST /auth/login`, set the exchange rate (`POST /exchange-rates`) and make the staff accounts: an admin, the **payroll** and **hr** people if there are any, and viewers (`POST /users`; each must choose their own password at first sign-in).

## 3. Adding a branch

1. **At HQ:** `POST /branches` with a short `code` and the `kind` (`sale` has tills; `stock` is a warehouse). The answer holds a **one-time enrol code**, shown once.
2. **At the branch PC:** install the branch server as in `docs/07-operations.md` §2 (a **fresh** install: a branch with a catalog of its own is refused, `CATALOG_NOT_EMPTY`). Open Settings → Branch server (or `POST /sync/connect`) and give HQ's address and the enrol code. The catalog, prices, rate and employees for this branch come down by themselves.
3. **Check it:** `GET /monitoring/branches` shows the branch with no problems after a minute; `GET /sync/verify` at the branch says `inSync`. Open a register and sell one item on the till; it appears at HQ.
4. **Tills:** enrol each till with its one-time code (Settings → Tills), as in `docs/07` §2.

A stock branch has no tills: it receives HQ's orders and ships to shops (`docs/15`).

## 4. Backups: both kinds

| | Branch server | HQ |
|---|---|---|
| Settings | `BACKUP_DIR`, `BACKUP_COPY_DIR`, `BACKUP_PASSPHRASE`, `BACKUP_AT`, `BACKUP_KEEP` in `C:\POS\service.env` | the same names in `C:\POS-HQ\service.env` |
| Schedule | daily from `BACKUP_AT`, catching up after the PC was off | the same |
| Names | `pos-YYYYMMDD-HHMMSS.db(.enc)` | `hq-YYYYMMDD-HHMMSS.db(.enc)` |
| Now | Menu → Backups, or `npm run backup --prefix branch-server` | `POST /backups` (admin), or `npm run backup --prefix cloud-hq` |
| Status | the Backups page, and a red chip when overdue | `GET /backups` (admin) and `GET /monitoring/branches` (`backup.problem`) |
| Restore | Backups screen (applied at the next start) or `npm run restore` with the service stopped | `npm run restore --prefix cloud-hq -- --from <file> --db C:\POS-HQ\hq.db --force`, with HQ **stopped** |

A backup is a consistent copy made while the server works (SQLite's online backup, never a plain file copy), checked before it counts, optionally AES-256-GCM encrypted. **A file for the wrong server is refused:** an HQ restore accepts only a database holding HQ's change log. HQ's backup also copies the product pictures it holds. **HQ holds the whole chain, payroll included, so back it up to a place that is not the same disk, and rehearse the restore** (§6).

## 5. Monitoring

`GET /monitoring/branches` (any HQ staff) is the one answer to "is the chain healthy?": `status` is `ok` or `attention`, with, for every branch, whether it ever connected, when HQ last heard from it, how many of HQ's changes it has not yet applied, the latest daily comparison and the number of days in the last 14 where the branch and HQ disagreed, and a list of **problems**:

| Problem | Meaning | What to do |
|---|---|---|
| `NEVER_CONNECTED` | added at HQ, never enrolled | finish step 2 of §3 |
| `SILENT` | not heard from for longer than `staleMinutes` (default 10) | is the branch PC on, and its internet up? Tills there keep selling to the branch server; nothing is lost |
| `NOT_PULLING` | HQ has changes for it and it has not asked for a while | restart the branch server; look at its log |
| `MISMATCH` | a day where the branch and HQ hold different amounts | the branch re-sends: `POST /sync/resync`; the branch page "HQ link" shows it |

and `backup.problem` (`BACKUP_NOT_CONFIGURED`, `BACKUP_STALE` after 36 hours, `BACKUP_FAILED`). It is the **Overview** page of the HQ screen (`docs/18`); there is no outbound alert (e-mail, SMS): look at it each morning, or point a monitor at the API. Whether to add messages is an owner decision (`docs/QUESTIONS.md` #33).

## 6. The restore drill (HQ)

Do this before the first branch goes live, and after any change to backups:

1. Take a backup (`POST /backups`). Copy the file and the passphrase to a different machine.
2. There, `npm install --prefix cloud-hq`, then `npm run restore --prefix cloud-hq -- --from <file> --db <somewhere>\hq.db` with `BACKUP_PASSPHRASE` set (the file is decrypted and checked before anything is written).
3. Start HQ against it (`DATABASE_PATH=<somewhere>\hq.db`) and sign in. The staff, branches, employees and runs are there. (`cloud-hq/tests/backup.test.ts` does exactly this on every test run.)
4. A restored HQ is older than the live one. Every branch compares itself with HQ each day (`MISMATCH`), and `POST /sync/resync` at a branch sends everything again, so a branch repairs HQ's copy of its own history; HQ-owned data made after the backup (an order, a price) must be made again. The restore is for a lost machine, not for undoing a mistake.

## 7. Updating

HQ first, then the branches, one at a time, in a quiet hour: stop the service (`Stop-ScheduledTask 'Chain HQ'`), update the folder, `npm install`, start it (migrations run at start). A branch that is a version behind keeps selling and syncing as long as the formats agree; a version mismatch is refused loudly (`FACTS_INVALID`), never silently dropped. After an update, look at `GET /monitoring/branches`.

## 8. What has not been run on real machines, and what to watch

- The install scripts on a real Windows machine (dry-run and parse only so far).
- HQ behind a real TLS proxy, and a real branch connecting through the internet (tested on one machine over localhost, and by `npm run test:sandbox` with each project in its own folder).
- Real hardware load: `cloud-hq/tests/system/chain-load.test.ts` proves correctness for 120 sales from three branches selling at once with retries (every sale once, HQ equals the branches, the daily control agrees), not speed on a real disk and network. Measure on the first real branch.
- The first payroll run: compare with the accountant's figures (`docs/16`).
- Backups to a real second drive, and a restore on another machine (§6).

## 9. Not built

a push alert (the screen exists: `docs/18`); backups of HQ to a cloud store (copy the folder with the tool the customer already uses); rebuilding a lost branch PC from HQ's copy of its history (HQ holds a mirror of everything a branch recorded, but a tool that puts it back is not built); a script that provisions a branch end to end (today the steps in §3 are done by hand); PostgreSQL (P8).
