# Ape Pin Potha - Dynamic OG Preview Router (`share.apepinpotha.lk`)

A lightweight, zero-dependency Vercel Serverless router providing dynamic Open Graph (OG) social media link previews for [apepinpotha.lk](https://apepinpotha.lk).

---

## 🌟 How It Works

1. **Short Share URLs:**
   - **Artisans & Perahera:** `https://share.apepinpotha.lk/a/:id`
   - **Merit Posts & Charity Needs:** `https://share.apepinpotha.lk/p/:id`

2. **Smart Routing:**
   - **Social Crawlers / Bots** (`Facebook`, `WhatsApp`, `Twitter/X`, `Telegram`, `LinkedIn`, `Slack`, `Discord`, `Googlebot`, etc.):
     - Fetches live document metadata from Firestore via public REST API.
     - Returns clean HTML with dynamic `og:title`, `og:description`, `og:image`, `og:url`, and `twitter:card="summary_large_image"` tags.
     - Cached at the edge via `Cache-Control: s-maxage=120, stale-while-revalidate=600`.
   - **Human Visitors:**
     - Immediately redirected (`302`) to the main web app:
       - `/a/:id` ➔ `https://apepinpotha.lk/?a=:id`
       - `/p/:id` ➔ `https://apepinpotha.lk/?p=:id`
       - `/` ➔ `https://apepinpotha.lk`

---

## 🚀 Deployment Instructions

### 1. Deploy to Vercel
1. Push this repository to GitHub as `apepinpotha-share`.
2. Open your [Vercel Dashboard](https://vercel.com/dashboard) and click **"Add New... > Project"**.
3. Import the `apepinpotha-share` repository.
4. Keep all default build settings (Framework: **Other**, Build Command: empty, Output Directory: empty).
5. Click **Deploy**.

### 2. Connect Custom Domain
1. In Vercel Project Settings ➔ **Domains**, add:
   ```
   share.apepinpotha.lk
   ```
2. In your DNS provider (Cloudflare / Namecheap / CPanel), add a CNAME record:
   - **Type:** `CNAME`
   - **Name:** `share`
   - **Value:** `cname.vercel-dns.com` (or the CNAME alias provided by Vercel)
   - **TTL:** Auto

---

## 🧪 Local Testing
```bash
node --check api/share.js
```
