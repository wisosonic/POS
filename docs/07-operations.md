# 07 · Running the shop PC

How the POS is installed, started, backed up and restored on the till PC. Written for the person who looks after the PC, not for a developer. Everything here was run for real in tests except the Windows install itself (see "What has not been run on a real till PC").

## 1. What runs where

One Windows PC at the till runs everything:

- the **server** (one program) owns the database file and also serves the web app,
- the **browser** on the same PC opens `http://localhost:3000`,
- the **USB receipt printer** is installed in Windows as an ordinary local printer.

Nothing is reachable from outside the PC (the server listens on `127.0.0.1` only).

## 2. First install

Needs: Windows 10 or 11, **Node.js 22 or newer installed for all users**, and the project folder (for example `C:\POS-app`).

1. In the project folder, in a normal terminal:
   ```
   npm install
   npm run build
   ```
2. Plug in the **backup drive** (a USB disk, or a folder that syncs to the cloud) and note its letter, for example `E:`.
3. Open PowerShell **as Administrator** (right-click, Run as administrator), go to the project folder, and run:
   ```
   powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1 -BackupDir C:\POS\backups -BackupCopyDir E:\POS-backups
   ```
   It asks for a **backup passphrase**. Choose one of at least 12 characters, **write it on paper and keep it away from the PC**. Without it no backup can be restored and nobody can recover it for you.
   Add `-DryRun` first to see what it will do without changing anything.
4. Create the first admin account:
   ```
   cd apps\api
   set DATABASE_PATH=C:\POS\pos.db
   npm run create-admin -- admin "a-long-password"
   ```
5. Open `http://localhost:3000` and sign in.
6. Make the browser open it by itself at sign-in, full screen: put a shortcut to
   `"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk http://localhost:3000 --edge-kiosk-type=fullscreen`
   in the Startup folder (`Win+R`, `shell:startup`).

The install makes a Windows scheduled task called **Darwish POS**. It starts when Windows starts (before anyone signs in) and a small launcher starts the server again, a few seconds later, whenever it stops. Settings live in `C:\POS\service.env` (readable only by administrators: it holds the login secret and the backup passphrase). To change a setting, edit that file and restart the PC (or `Stop-ScheduledTask` then `Start-ScheduledTask` on `Darwish POS`). Logs are in `C:\POS\logs\`.

To remove it: `install-service.ps1 -Uninstall`. Your data and backups are left alone.

### The printer

The server runs as the SYSTEM account, which can only use printers installed **for all users**. Install the USB printer from Windows' "Printers & scanners" as a local printer, then sign in as the admin and open **Menu → Settings**. Type the printer's exact name, set the receipt width (42 for an 80 mm printer, 32 for 58 mm), press **Save settings**, then **Print a test slip**. The slip shows the shop header, a long item name that wraps, an Arabic name (it must come out as readable English letters), and a ruler as wide as the receipt, so you can see at once whether the printer cuts the line off. Tick "Also open the cash drawer" to test the drawer. If the slip prints when you are signed in at the PC but not from the server, the printer is not installed for all users.

### The exchange rate

Every sale uses the rate in force when it is made, and old sales keep theirs forever. The admin sets it at **Menu → Exchange rate** (or by pressing the `1$ = ... LL` chip at the top of the screen). Do this first thing each day the rate moves. A new rate that differs from the old one by more than 10% asks "Is that right?" first, because an extra zero is the usual mistake. A rate can also be set to start later.

### The first day

Bring the old data over with the importer (`docs/01-data-analysis.md`; the whole procedure, with a rehearsal that must pass first, is `docs/10-cutover.md`), set passwords for the imported users (**Menu → Users**, admin only: add people, give a first password that they must replace on first sign-in, set or remove a cashier's PIN, switch someone off), set the printer and the exchange rate (above), and close the imported open register before the first real day. See the owner-review list in `plan.md`.

### Product pictures

The importer copies the pictures products use from the old `Uploads` folder into `C:\POS\uploads` (a folder beside the database), under new names made from each picture's content. **Keep the old `Uploads` folder as it is** (the importer only reads it): it also holds 418 pictures no product uses, which you may want to give to products later. A manager sets, replaces or removes a picture in the product form (Menu → Products → Edit), up to 5 MB, JPEG, PNG, GIF, WebP or AVIF. Pictures show in the product list and in the till's search.

Run the importer with the database somewhere other than next to the old `Uploads` folder: on Windows `Uploads` and `uploads` are the same folder, and the importer refuses to run if they would be.

### A tablet or second PC

A tablet (or a second PC) can use the till over the shop's network **only with HTTPS**: without it the sign-in and the session would cross the Wi-Fi in the clear (`docs/08-security-review.md`, risk 2).

1. **Make a certificate** for this PC (once; it lasts 825 days, then repeat). Replace `192.168.1.10` with the PC's address on the shop network and `till` with the name you will type on the tablet:

   `openssl req -x509 -newkey rsa:2048 -nodes -keyout C:\POS\key.pem -out C:\POS\cert.pem -days 825 -subj "/CN=till" -addext "subjectAltName=DNS:till,IP:192.168.1.10"`

   (`openssl` comes with Git for Windows. A tool such as `mkcert` does the same and also makes the certificate trusted on the PC.)
2. **Install with it:** `install-service.ps1 ... -TlsCert C:\POS\cert.pem -TlsKey C:\POS\key.pem`, or add `TLS_CERT=` and `TLS_KEY=` (both) to `C:\POS\service.env` and restart the task. The server then speaks HTTPS only, marks the sign-in cookie Secure and sends `Strict-Transport-Security`.
3. **Let the network reach it:** in the same file set `HOST=0.0.0.0` and `ALLOWED_HOSTS=till,192.168.1.10` (the names and addresses the tablet will use; anything else is refused), and allow the port in the Windows firewall for the private network only.
4. **Trust the certificate on the tablet:** open `https://till:3000` once, and install `cert.pem` as a trusted certificate in the tablet's settings (the exact steps depend on the tablet). Until it is trusted the browser warns, and the offline copy of the app (service worker) will not install.

The tablet is a second screen onto **the same till**: one register session, one cart store per browser. The browser tests run the till screens on a 1024 x 768 touch screen (`tablet-1024x768`).

## 3. Backups

**What happens:** every day from `BACKUP_AT` (default 02:00, shop time) the server makes a safe copy of the database while the shop keeps selling, checks it, encrypts it, writes it to `BACKUP_DIR` and copies it to `BACKUP_COPY_DIR`. If the PC was off at that hour, the backup is made as soon as it is back on. The newest `BACKUP_KEEP` (30) are kept in each place.

**Where you see it:** Menu → **Backups** (admin only) shows the latest backup, whether the last attempt worked, and has a **Back up now** button. If the newest backup is more than 36 hours old, every manager sees a red **Backup overdue** chip at the top of the screen. If you see it, look at the Backups page and at `C:\POS\logs\api.err.log`: the usual causes are the USB drive unplugged or a full disk.

**Settings** (in `C:\POS\service.env`):

| Setting | Meaning |
|---|---|
| `BACKUP_DIR` | Main folder. Without it there are no automatic backups |
| `BACKUP_COPY_DIR` | Second place: an external drive, or a folder that syncs offsite. **A backup on the same disk does not survive the disk failing** |
| `BACKUP_PASSPHRASE` | Encrypts every backup (AES-256-GCM). At least 12 characters. Without it backups are plain database files |
| `BACKUP_AT` | Time of day, `HH:MM` |
| `BACKUP_KEEP` | How many to keep in each folder |

If the second copy cannot be written (drive missing), the backup in the main folder still counts and the failure is reported on the Backups page.

**Pictures are backed up too.** Each backup also copies any product pictures the backup folders do not have yet into an `uploads` folder inside them (and inside the second copy). A picture never changes, so only new ones are copied and each backup stays quick. The pictures are **not encrypted** (they are not secret) and are **not removed** when old database backups are, so the `uploads` folder only grows, by the size of the pictures you add.

**Make one by hand** (safe while the shop is open):
```
cd apps\api
npm run backup -- --to E:\POS-backups
```

## 4. Restoring (and the drill)

**Do this drill once, now, and then every quarter.** A backup you have never restored is a hope, not a backup.

On a second PC (or the same one, into a different file) with the project installed:

1. Copy a backup file (`pos-YYYYMMDD-HHMMSS.db.enc`) to that PC.
2. Set the passphrase and restore into a **new** file:
   ```
   cd apps\api
   set BACKUP_PASSPHRASE=the passphrase from the paper
   npm run restore -- --from D:\copy\pos-20261020-020000.db.enc --db D:\drill\pos.db
   ```
3. Start a server on it (`set DATABASE_PATH=D:\drill\pos.db`, `set PORT=3100`, `npm start`), open `http://localhost:3100`, sign in, and look at yesterday's sales.

The restore also puts back the product pictures: it takes the `uploads` folder that sits beside the backup file (keep the two together when you copy a backup) and copies into `D:\drill\uploads` the pictures that are not there yet. It says how many it put back.

**A real disaster** (the till PC died): install on the new PC as in section 2, **stop the Darwish POS task**, then restore into `C:\POS\pos.db` with `--force`, start the task again, and check a recent sale before opening the shop.

What restore guarantees:

- the file is decrypted and checked **before** anything on the PC is touched; a wrong passphrase, a damaged file or a file that is not a POS database changes nothing,
- without `--force` it refuses to replace an existing database,
- with `--force` the old database is kept beside the new one as `pos.db.before-restore-<time>`, never deleted,
- **stop the service first.** The server owns the database file; restoring under a running server is not supported.

Anything sold after the last backup is not in it. With a nightly backup that is at most a day of sales; the paper receipts and the printed Z-report are the way to re-enter them.

## 5. Updating the software

1. Run `npm run backup` (or press **Back up now**).
2. Stop the task, replace the project files, run `npm install` and `npm run build`, start the task.
3. The server brings the database up to date by itself the first time it starts (new numbered migrations are applied once). Check the Backups page and a recent sale.

## 6. When something is wrong

| Sign | Look at |
|---|---|
| The browser shows nothing at `localhost:3000` | `C:\POS\logs\api.err.log` and `launcher.log`. `Get-ScheduledTask 'Darwish POS'` should say Running |
| "The port is held by something that is not ours" in `launcher.log` | Another program uses port 3000. Close it, or change `PORT` in `service.env` |
| Backup overdue | Backups page; is the USB drive plugged in? is the disk full? |
| Receipts do not print from the till but do from the browser | The printer must be installed for all users (section 2, The printer) |
| Power cut | The shop keeps its data: every sale is saved in one step before the receipt prints. Buy a UPS anyway: it lets the PC shut down cleanly |

## What has not been run on a real till PC

The backup, the encryption, the restore drill (run as separate command-line processes), the scheduler's timing rules, the production start with the web app served by the server, and the install script's dry run are all tested. **The install itself (the scheduled task, the SYSTEM account, the printer from that account) has not been run on a real till PC**: do it with `-DryRun` first, and check printing from the server on the day it is installed. The scheduled task is used instead of a Windows service to avoid adding a service wrapper; it behaves the same for the owner (starts at boot, restarts on failure).
