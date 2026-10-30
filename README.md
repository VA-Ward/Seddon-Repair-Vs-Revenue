# Seddon Workroom

A live dashboard for Master Dry Cleaners – Seddon:

- **Roster planner** – hours of sewing to roster next week, from the repairs taken in the week before (plus any backlog).
- **Repairs & wages** – what Serin and Lily bring in against their hours and what those hours cost.
- **Other stores** – the weekly total of repairs sent to Seddon from the other stores.
- **Store takings** – Seddon's weekly takings against store wages, by fortnight and by day.
- **Monthly reports** – the same tables as the weekly email, with a "Copy tables for email" button.
- **Photos** – Marissa's photos, filed by week.
- **Data checks** – every correction the dashboard made to the source figures, and anything worth checking.

The figures and photos are **encrypted**. GitHub Pages sites are public, so without the passphrase the files are unreadable.

---

## Put it live (once, about 15 minutes)

1. On GitHub, create a new repository called `seddon-workroom`. Public is fine because everything sensitive is encrypted (Pages on a private repository needs a paid GitHub plan).
2. In the new repository: **Add file → Upload files**, drag in everything inside the unzipped folder, then **Commit changes**.
3. Check the Code tab shows `.github/workflows/eh-sync.yml`. Some computers hide folders starting with a dot and skip it. If it's missing: **Add file → Create new file**, type the name `.github/workflows/eh-sync.yml`, paste in the contents of `setup/eh-sync.yml`, and commit.
4. **Settings → Pages**: Source "Deploy from a branch", branch `main`, folder `/ (root)`, **Save**. A minute later the site is at `https://YOUR-ACCOUNT.github.io/seddon-workroom/`.
5. Open it and enter the passphrase. Tick "Remember on this device" on computers you trust.

## Each week (about 2 minutes)

1. Update `Seddon Repairs vs Revenue.xlsx` as you do now.
2. Open `https://YOUR-ACCOUNT.github.io/seddon-workroom/admin.html`.
3. **A. Update from the repairs workbook** – choose the workbook. It shows what's new or changed.
4. **B. Update store takings and wages** – choose `Average Weekly Sales - All Stores.xlsx` (only the SEDDON sheet is read).
5. **E. Photos** – add Marissa's photos with the date they're from. Or use **D. Add a day** for one day's figure with its photo.
6. Press **Publish**. The dashboard updates within a minute or two.

**First time on the Admin page** you need a GitHub token (it stays in that browser only):
GitHub → your profile picture → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
Repository access: *Only select repositories* → `seddon-workroom`. Permissions: **Contents: Read and write** (add **Actions: Read and write** if you want the "Sync now" button). Paste it into Admin → Connect.

## Employment Hero (live wages)

1. In Employment Hero Payroll: your name (top right) → **My Account** → copy the **API key** at the bottom.
2. Note the **business ID** – the number in the web address when the business is open (…/Business/`123456`/…).
3. GitHub repository → **Settings → Secrets and variables → Actions → New repository secret**. Add three secrets:
   - `EH_API_KEY` – the API key
   - `EH_BUSINESS_ID` – the business ID
   - `DASHBOARD_PASSPHRASE` – the dashboard passphrase
4. Optional, on the **Variables** tab: `EH_LOCATION` if Seddon isn't called "Seddon" in Employment Hero.
5. **Actions → Employment Hero sync → Run workflow**, mode **check**. A green tick means it can see Seddon's timesheets. Then run it again with mode **sync**.

From then on it runs every morning. It brings in each day's hours and wage cost at Seddon, each person's weekly wage cost (so Serin's and Lily's wages show against what they bring in), and store wages for the fortnights after the last one in the sales sheet. The sales sheet stays the official record wherever it has a figure.

The Actions log on a public repository is public, so the sync only ever prints counts and location names – never names, hours or dollars.

## The passphrase

- Change it in **Admin → H. Change the passphrase**, then update the `DASHBOARD_PASSPHRASE` secret to match.
- A forgotten passphrase can't be recovered. Keep it in a password manager.

## How the roster forecast works

1. Repairs sent in from the other stores in a week get sewn the following week. Across January–August 2026 the work done each month matched the work sent in to within about 10%.
2. Any shortfall over the last 8 weeks is spread over the next 4 weeks so it gets cleared.
3. Each seamstress's own revenue per hour over her last 8 worked weeks turns dollars of work into hours. Usual days are filled first, then extra days, then cover.

All of these settings (weeks, on-costs, hours per day, pay rates) can be changed in **Admin → F. Settings**.

## What's in this folder

| File | What it is |
|---|---|
| `index.html` | The dashboard |
| `admin.html` | Updating figures, photos, settings and the passphrase |
| `data/vault.json` | All figures, encrypted |
| `photos/` | Marissa's photos, encrypted |
| `assets/` | The dashboard's code, styles and charting library |
| `scripts/eh-sync.mjs` | The Employment Hero sync |
| `.github/workflows/eh-sync.yml` | Runs the sync each morning (copy in `setup/`) |
