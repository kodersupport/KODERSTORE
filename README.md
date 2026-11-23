# Shop Admin Light V1

Telegram shop bot + Admin HTML dashboard + JSONBin persistence + VietQR.

## Features
- Admin login protected by a server-side password and signed JWT.
- Create/edit/delete products and variants (price + stock count).
- Telegram `/start` product/variant selection and `/id` command.
- VietQR generated for the selected variant amount.
- “Tôi đã thanh toán” creates an awaiting-review order; it does **not** verify payment.
- Admin can approve only after checking the bank account, then manually enter and send the key.
- Multiple Telegram admin notification IDs.
- Order history and JSONBin persistence.

## Local setup
1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and fill in all values.
3. Create a private JSONBin bin containing `{}` and copy the Bin ID + Master Key.
4. Create a Telegram bot using `@BotFather`, copy its token into `BOT_TOKEN`.
5. Run:
   ```bash
   npm install
   npm start
   ```
6. Open `http://localhost:3000` and sign in using `ADMIN_PASSWORD`.
7. In Telegram, open your bot and send `/start`.

## Railway + GitHub deployment
1. Create a GitHub repository and upload all files in this folder (do not upload `.env`).
2. In Railway, create a project → Deploy from GitHub Repo → select this repository.
3. In Railway → service → Variables, add every variable from `.env.example`.
4. Set `PUBLIC_BASE_URL` to your Railway public domain (optional for polling mode).
5. Deploy. Railway runs `npm start` automatically.
6. Open the Railway public domain to use the Admin dashboard.

## JSONBin format
The app creates the initial document automatically when the bin is empty. It stores products, orders, admin Telegram IDs and settings in one JSON document.

## Important security and payment notes
- Never put `BOT_TOKEN`, `JSONBIN_MASTER_KEY`, `ADMIN_PASSWORD`, or `JWT_SECRET` in HTML, GitHub, screenshots, or messages. Keep them only in `.env` locally and Railway Variables in production.
- Use a **private** JSONBin bin. Anyone with the Master Key can read/write its contents.
- Admin dashboard access is protected by login. Use HTTPS on Railway and a strong password.
- VietQR only creates a payment QR. A customer pressing “I have paid” is not proof of payment. Verify the actual incoming transfer in your bank app before approving and sending a key.
- This V1 stores data in one JSONBin record. It is suitable for a small shop, not high-volume concurrent sales. Keep periodic backups from JSONBin.
- The stock count is informational/controlled by admin in manual-key mode. Reduce stock when approving an order; the backend prevents approval if stock is zero.
