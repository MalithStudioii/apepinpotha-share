/**
 * ============================================================================
 * Ape Pin Potha - Dynamic Open Graph (OG) Preview Router
 * Cloud Function (Vercel Serverless Function)
 *
 * Intercepts incoming share links (https://share.apepinpotha.lk/a/:id and /p/:id):
 * - If crawler/bot: fetches Firestore document metadata via REST API and returns HTML with rich Open Graph tags.
 * - If human visitor: immediately redirects (302) to the main web app (https://apepinpotha.lk/?a=:id or ?p=:id).
 * ============================================================================
 */

const FIREBASE_PROJECT_ID = "pin-ketha-app";
const SITE_ORIGIN = "https://apepinpotha.lk";
const SHARE_ORIGIN = "https://share.apepinpotha.lk";
const DEFAULT_IMAGE = "https://apepinpotha.lk/assets/banner.jpg";
const SITE_NAME = "අපේ පිං පොත - Ape Pin Potha";

// Regex detecting major social media link preview bots and crawlers
const BOT_UA_REGEX = /facebookexternalhit|Facebot|WhatsApp|Twitterbot|TelegramBot|LinkedInBot|Slackbot|Discordbot|Pinterest|Googlebot|bingbot|Applebot|viber/i;

/**
 * Escapes characters for safe inclusion in HTML attributes and content
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Recursively parses Firestore REST API typed values into standard JavaScript values
 * @param {Object} val
 * @returns {*}
 */
function parseFirestoreValue(val) {
  if (!val || typeof val !== "object") return null;
  if ("stringValue" in val) return val.stringValue;
  if ("integerValue" in val) return parseInt(val.integerValue, 10);
  if ("doubleValue" in val) return parseFloat(val.doubleValue);
  if ("booleanValue" in val) return val.booleanValue;
  if ("timestampValue" in val) return val.timestampValue;
  if ("nullValue" in val) return null;
  if ("arrayValue" in val) {
    const list = (val.arrayValue && val.arrayValue.values) || [];
    return list.map(parseFirestoreValue);
  }
  if ("mapValue" in val) {
    const fields = (val.mapValue && val.mapValue.fields) || {};
    const res = {};
    for (const k of Object.keys(fields)) {
      res[k] = parseFirestoreValue(fields[k]);
    }
    return res;
  }
  return null;
}

/**
 * Converts a raw Firestore REST document into a flat JavaScript object
 * @param {Object} doc
 * @returns {Object|null}
 */
function parseFirestoreDoc(doc) {
  if (!doc || !doc.fields) return null;
  const res = { id: doc.name ? doc.name.split("/").pop() : "" };
  for (const k of Object.keys(doc.fields)) {
    res[k] = parseFirestoreValue(doc.fields[k]);
  }
  return res;
}

/**
 * Recursively inspects candidates and returns the first valid HTTP/HTTPS image URL
 * @param {Array<*>} candidates
 * @returns {string|null}
 */
function findFirstValidImageUrl(candidates) {
  if (!Array.isArray(candidates)) return null;
  for (const item of candidates) {
    if (!item) continue;
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
      }
    } else if (typeof item === "object") {
      if (Array.isArray(item)) {
        const nested = findFirstValidImageUrl(item);
        if (nested) return nested;
      } else {
        const u = item.url || item.imageUrl || item.secure_url || item.src;
        if (typeof u === "string" && /^https?:\/\//i.test(u.trim())) {
          return u.trim();
        }
      }
    }
  }
  return null;
}

/**
 * Optimizes image URL for social previews (1200x630, auto eco quality, JPEG)
 * If URL is from Cloudinary and has no transformation params, injects transformation segment.
 * @param {string} url
 * @returns {string}
 */
function optimizeOgImage(url) {
  if (!url || typeof url !== "string") return DEFAULT_IMAGE;
  const trimmed = url.trim();
  if (!trimmed.includes("res.cloudinary.com")) return trimmed;

  const uploadMarker = "/image/upload/";
  const uploadIdx = trimmed.indexOf(uploadMarker);
  if (uploadIdx === -1) return trimmed;

  const afterUpload = trimmed.substring(uploadIdx + uploadMarker.length);
  // Check if transformation segment is already present (e.g. w_, c_, q_, f_, or compound)
  const hasTransform = /^(?:[a-z]_[a-zA-Z0-9_:,]+|\w+,\w+)\//.test(afterUpload);
  if (!hasTransform) {
    const transform = "w_1200,h_630,c_fill,q_auto:eco,f_jpg/";
    return trimmed.substring(0, uploadIdx + uploadMarker.length) + transform + afterUpload;
  }

  return trimmed;
}

/**
 * Fetches a Firestore document via public REST API with timeout
 * @param {string} collection
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
async function fetchFirestoreDoc(collection, id) {
  if (!collection || !id) return null;
  const endpoint = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
  try {
    const res = await fetch(endpoint, {
      headers: { "Accept": "application/json" },
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(4500) : undefined
    });
    if (!res.ok) return null;
    const json = await res.json();
    return parseFirestoreDoc(json);
  } catch (err) {
    return null;
  }
}

/**
 * Main serverless request handler
 */
module.exports = async (req, res) => {
  const query = req.query || {};
  const type = String(query.type || "").trim().toLowerCase();
  const rawId = String(query.id || "").trim();
  const userAgent = String(req.headers["user-agent"] || "");

  // Determine target human redirect destination on the main website
  let redirectUrl = SITE_ORIGIN;
  let canonicalUrl = SHARE_ORIGIN;
  if (type === "a" && rawId) {
    redirectUrl = `${SITE_ORIGIN}/?a=${encodeURIComponent(rawId)}`;
    canonicalUrl = `${SHARE_ORIGIN}/a/${encodeURIComponent(rawId)}`;
  } else if (type === "p" && rawId) {
    redirectUrl = `${SITE_ORIGIN}/?p=${encodeURIComponent(rawId)}`;
    canonicalUrl = `${SHARE_ORIGIN}/p/${encodeURIComponent(rawId)}`;
  }

  // 1. Human visitor detection: immediately redirect to main website
  const isBot = BOT_UA_REGEX.test(userAgent);
  if (!isBot) {
    res.setHeader("Location", redirectUrl);
    return res.status(302).end();
  }

  // 2. Crawler / Bot detection: construct rich Open Graph preview tags
  let pageTitle = SITE_NAME;
  let pageDescription = "අපේ පිං පොත - කල්‍යාණ මිත්‍ර පුණ්‍ය ජාලය සහ ශ්‍රී ලංකා විහාර කලා හා පෙරහැර ශිල්පී නාමාවලිය.";
  let imageUrl = DEFAULT_IMAGE;

  if (type === "a" && rawId) {
    // Temple Artisans & Perahera Services Directory
    const docData = await fetchFirestoreDoc("temple_artisans", rawId);
    if (docData) {
      const name = docData.name || docData.artisanName || "සත්‍යාපිත ශිල්පී";
      const isPerahera = docData.section === "perahera_culture";
      const role = isPerahera ? "සත්‍යාපිත පෙරහැර කලා ශිල්පී" : "සත්‍යාපිත විහාර කලා ශිල්පී";
      const district = docData.district ? `(${docData.district})` : "(ශ්‍රී ලංකා)";
      pageTitle = `🏛️ ${name} — ${role} ${district} | අපේ පිං පොත`;

      const specialties = Array.isArray(docData.specialties) && docData.specialties.length > 0
        ? `ක්ෂේත්‍ර: ${docData.specialties.slice(0, 3).join(", ")}`
        : "";
      const bio = (docData.bio || docData.description || "").replace(/<[^>]*>?/gm, "").trim();
      const temples = (docData.notableTemples || docData.temples || "").replace(/<[^>]*>?/gm, "").trim();

      const descParts = [];
      if (specialties) descParts.push(specialties);
      if (bio) descParts.push(bio);
      if (temples) descParts.push(`දායක වූ විහාර: ${temples}`);

      if (descParts.length > 0) {
        pageDescription = descParts.join(" | ");
      } else {
        pageDescription = "අපේ පිං පොත විහාර කලා හා පෙරහැර ශිල්පී නාමාවලිය ඔස්සේ සම්පූර්ණ පැතිකඩ සහ නිර්මාණ එකතුව (Portfolio) දැකබලා ගන්න.";
      }

      const imgCandidate = findFirstValidImageUrl([
        docData.bannerUrl,
        docData.coverImage,
        docData.photo,
        docData.avatar,
        docData.profileImage,
        docData.portfolioImages,
        docData.portfolio,
        docData.images
      ]);
      if (imgCandidate) {
        imageUrl = imgCandidate;
      }
    } else {
      pageTitle = "සත්‍යාපිත විහාර කලා හා පෙරහැර ශිල්පී පැතිකඩ | අපේ පිං පොත";
      pageDescription = "අපේ පිං පොත විහාර කලා හා පෙරහැර ශිල්පී නාමාවලිය ඔස්සේ සම්පූර්ණ පැතිකඩ සහ නිර්මාණ එකතුව (Portfolio) දැකබලා ගන්න.";
    }
  } else if (type === "p" && rawId) {
    // Merit Posts & Sathkara Community Feed
    const docData = await fetchFirestoreDoc("merit_posts", rawId);
    if (docData) {
      const isNeed = docData.type === "need";
      const realTitle = (docData.title || "").replace(/<[^>]*>?/gm, "").trim();
      const author = docData.isOfficial
        ? "අපේ පිං පොත"
        : (docData.author || docData.authorName || "කල්‍යාණ මිත්‍ර");

      if (realTitle) {
        pageTitle = `${isNeed ? "🤝 " : "🌸 "}${realTitle} — ${author} | අපේ පිං පොත`;
      } else {
        pageTitle = `${isNeed ? "🤝 විශේෂ සත්කාර ඇරයුමකි" : "🌸 උතුම් පින්කමක්"} — ${author} | අපේ පිං පොත`;
      }

      const cleanDesc = (docData.description || docData.content || docData.text || "")
        .replace(/<[^>]*>?/gm, "")
        .trim();
      if (cleanDesc) {
        pageDescription = cleanDesc.length > 220 ? `${cleanDesc.substring(0, 217)}...` : cleanDesc;
      } else {
        pageDescription = isNeed
          ? "අපේ පිං පොත සත්කාර හවුල ඔස්සේ මෙම සත්කාර ඇරයුම පිළිබඳ සම්පූර්ණ විස්තර දැකබලා දායක වන්න."
          : "අපේ පිං පොත ඔස්සේ මෙම උතුම් පින්කම දැකබලා ඔබත් සාදුකාර දී පින් අනුමෝදන් වන්න.";
      }

      const imgCandidate = findFirstValidImageUrl([
        docData.image,
        docData.imageUrl,
        docData.images,
        docData.mediaUrl,
        docData.thumbnail,
        docData.videoThumbnail,
        docData.authorPhoto
      ]);
      if (imgCandidate) {
        imageUrl = imgCandidate;
      }
    } else {
      pageTitle = "උතුම් පින්කමක් දැකබලා අනුමෝදන් වන්න | අපේ පිං පොත";
      pageDescription = "අපේ පිං පොත කල්‍යාණ මිත්‍ර පුණ්‍ය ජාලය ඔස්සේ උතුම් පින්කම් දැකබලා සාදුකාර දී අනුමෝදන් වන්න.";
    }
  }

  // Ensure description length does not exceed social card limit
  if (pageDescription.length > 300) {
    pageDescription = `${pageDescription.substring(0, 297)}...`;
  }

  const optimizedImage = optimizeOgImage(imageUrl);

  const safeTitle = escapeHtml(pageTitle);
  const safeDesc = escapeHtml(pageDescription);
  const safeImage = escapeHtml(optimizedImage);
  const safeUrl = escapeHtml(canonicalUrl);
  const safeRedirectUrl = escapeHtml(redirectUrl);

  const html = `<!DOCTYPE html>
<html lang="si">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}">
  <link rel="canonical" href="${safeUrl}">

  <!-- Open Graph Meta Tags (Facebook, WhatsApp, LinkedIn, Slack) -->
  <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:image" content="${safeImage}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${safeTitle}">
  <meta property="og:url" content="${safeUrl}">

  <!-- Twitter Card Meta Tags -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image" content="${safeImage}">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 40px 20px; background: #fffdf8; color: #78350f;">
  <p>ප්‍රධාන වෙබ් අඩවිය වෙත පිවිසෙමින් පවතී...</p>
  <p><a href="${safeRedirectUrl}" style="color: #d97706; font-weight: 700; text-decoration: none;">මෙහි ක්ලික් කර පිවිසෙන්න (Click here to continue)</a></p>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=UTF-8");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  return res.status(200).send(html);
};
