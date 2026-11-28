# 18 · The HQ screen

Until now HQ was an API: every HQ job (adding a branch, reading the chain's day, taking a backup, making a staff account) meant a hand-made request. The HQ screen is a small web app that does those jobs in a browser. It answers question #33 in `docs/QUESTIONS.md` (option A: a screen the owner looks at each morning). It sends nothing; it only shows.

**Built (2026-11-28), version 1:** sign in, **Overview**, **Branches**, **Backups**, **Staff**. **Not built yet:** employees, attendance, rosters and leave; payroll and payslips; purchase orders and stock suggestions; the catalog; customers' balances; reports beyond today's totals; Arabic. Each of those is an API today (`docs/06`) and gets a page when it is needed.

## 1. Where it lives and how it is served

- Source: `cloud-hq/web` (Vite, React, TypeScript; its own folder inside the HQ project, like `till/web`). Build: `npm run build --prefix cloud-hq` writes `cloud-hq/web/dist`.
- **HQ serves it itself**, from `cloud-hq/web/dist` when that folder exists (or from `WEB_DIST`). Without a build HQ answers the API only. There is nothing else to install: the same address, `https://<HQ's name>/`, is the screen, and the screen talks to `/api/v1` on that same address.
- Development: `npm run dev --prefix cloud-hq/web` serves the screen on port 5174 and forwards `/api` to HQ on 4000.
- **Headers** (`cloud-hq/src/app.ts`): the screen's own files may load scripts and styles from HQ and nowhere else (`script-src 'self'`, no inline script, no eval, no foreign origin: the same policy as the till). The API keeps `default-src 'none'`, `no-store` and no framing. A route that sets its own headers (the payslip page needs an inline style) is no longer overridden: this was a real bug found while building the screen, since the page would have lost its style in a browser. A page address such as `/branches` belongs to the app's router, so a browser asking for it gets the app; the API keeps its JSON 404s. HQ's `Host` and `Origin` checks apply to the screen too.

## 2. The pages

| Page | Who | What |
|---|---|---|
| **Sign in** | everyone | Name and password (`POST /auth/login`). A wrong answer says "the name or the password is wrong". A new account is stopped at **Choose your own password** until it has one (at least 12 characters). An `employee` account sees a short note: their payslips are not on this screen yet. |
| **Overview** | any staff | "Everything is fine" or "Something needs a look" with each problem in plain words (from `GET /monitoring/branches`, docs/17 §5); today's sales, net sales, returns and profit for the chain; a row for every branch with its state, when it was last heard, today's sales and open tills; the backup in one line. Refreshes each minute. Figures are what the branches have sent so far today (Beirut time). |
| **Branches** | any staff read; admin changes | The branches and their state; **add a branch** (code, name, shop or stock) and the **one-time code** is shown once, in a box, to type at the branch; **New code** for a branch that has not connected; **Close** and **Reopen**. |
| **Backups** | admin | When the last backup was made, whether it worked, encrypted or not, whether there is a second copy, the files on disk, and **Back up now**. |
| **Staff** | admin | HQ's accounts: add a person with a temporary password and a role (viewer, catalog, HR, payroll, admin), change a role, set a new temporary password, close or reopen an account. You cannot change your own role or close yourself. |

The server decides who may do what (docs/16 §7); the screen only hides the buttons a person cannot use.

## 3. How it handles the sign-in

The session token (`POST /auth/login`) is kept in `sessionStorage` (gone when the tab is closed, never written to disk by the page) and sent only to HQ, in a header. HQ no longer accepting it (expired after eight hours, signed out elsewhere, role changed) sends the person back to the sign-in page with nothing of the last person left on screen. The one-time branch code lives only in the page's memory and is not stored anywhere.

## 4. Tests

`cloud-hq/tests/web.test.ts` (serving, headers, the router fallback, traversal, the API's strict headers, the payslip page keeping its style), `cloud-hq/tests/unit/screen-format.test.ts` (the figures and sentences the screen shows). **The pages themselves were checked in a real browser by a script** (sign in with a wrong and a right password, add a branch and see its code, Overview, Staff, Backups, reload stays signed in, sign out; no errors in the console but the expected 401), **not by a test that is kept in the repository**: there is no browser-test setup in `cloud-hq` yet. Adding one (Playwright, as in `till`) is the next step for this screen.

## 5. Not decided

Arabic and right-to-left for HQ staff (the layout uses logical properties so it can be mirrored); whether the owner wants a message sent when something goes wrong (#33 option B); a mobile layout beyond "it stacks" (the owner will probably read Overview on a phone).
