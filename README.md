# PI Production Tracker

A standalone order-tracking app that runs on your own PC with its own database.
No Airtable, no AI service, no per-use cost, no internet required for the app itself.

---

## 1. One-time setup (Windows)

1. **Install Node.js** — download the LTS version from https://nodejs.org and run the installer (accept all defaults).
2. **Copy this folder** somewhere permanent, e.g. `C:\pi-tracker`.
3. **Set your password** — right-click `start.bat` → Edit, and change:
   ```
   set APP_PASSWORD=changeme
   set APP_SECRET=change-this-to-any-random-text
   ```
   Save and close.
4. **Double-click `start.bat`.** The first run installs dependencies (a few minutes, needs internet). After that it starts in seconds.
5. Open **http://localhost:3000** and sign in with your password.

To stop the app, close the black window. To start it again, double-click `start.bat`.

**Start automatically when the PC boots:** press `Win+R`, type `shell:startup`, press Enter, and put a shortcut to `start.bat` in that folder.

---

## 2. Using it

**Vendors first.** Add each vendor with their **lead time in days**. This one number drives every due date in the system: due date = PI date + lead time. Change a lead time and every affected date recalculates instantly.

**Import a PI.** Export the PI from your ERP as Excel or CSV, then Import from ERP → choose the file. The app matches your columns automatically, shows a preview, and only saves when you click Import.

Your export needs at minimum:

| Column | Required | Notes |
|---|---|---|
| Item No | yes | the SKU / style number |
| Quantity | yes | order quantity, numbers only |
| Buyer No | no | buyer's own code, e.g. MCA-1 |
| Description | no | e.g. MEZUZAH |

PI number, PO number, buyer and the three dates can also come from the file (they're auto-detected from the first row) or you can type them in the import screen. Column names don't have to match exactly — "Order Qty", "QTY", "Pieces" are all recognised.

**Repeat SKUs remember themselves.** If an item number has been imported before, its vendors, gift-box and labels settings are copied to the new order automatically.

**Track production.** Open an order to see every SKU in one row: vendors 1–4, each vendor's due date, receiving, three rounds of repair returns, in-hand and still-due quantities, progress bar, and Complete/Packed/Shipped ticks. Edits save as you type. Late rows are highlighted red.

- **In hand** = received + all repair returns back − all pieces sent for repair
- **Still due** = ordered − in hand
- **Late tab** = every SKU past its due date and not complete, most overdue first

---

## 3. Access from anywhere

The app listens on your whole network, so on office WiFi any phone or laptop can reach it at `http://<PC-IP>:3000` (find the IP with `ipconfig`).

For access **outside** the office, don't open router ports — use a secure tunnel:

**Option A — Tailscale (simplest).** Install Tailscale on the office PC and on your phone/laptop, sign in with the same account on each, and reach the app at `http://<tailscale-ip>:3000` from anywhere. Free for personal use.

**Option B — Cloudflare Tunnel (public web address).** Install `cloudflared`, then:
```
cloudflared tunnel --url http://localhost:3000
```
It prints a public HTTPS address. For a permanent address, set up a named tunnel with a domain you own.

Either way, keep a strong `APP_PASSWORD` — that's the only thing standing between the internet and your data.

---

## 4. Backups

All your data is one file: `data\tracker.db`. Copy it somewhere safe regularly (Google Drive, OneDrive, a USB stick). To restore, put the file back and restart the app. Do backups while the app is stopped for a perfectly clean copy.

---

## 5. Notes

- The office PC must be **awake** for others to reach the app. Set Windows sleep to "Never" (screen can still turn off).
- Data lives entirely on your PC. Nothing is sent anywhere.
- To reset everything, stop the app and delete the `data` folder.
