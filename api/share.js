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
const DEFAULT_IMAGE = "https://apepinpotha.lk/assets/og-banner.jpg";
const ARTISAN_DEFAULT_IMAGE = "https://apepinpotha.lk/assets/artisan-banner-buddha.webp";
const SITE_NAME = "අපේ පිං පොත - Ape Pin Potha";

// Regex detecting major social media link preview bots and crawlers
const BOT_UA_REGEX = /facebookexternalhit|Facebot|WhatsApp|Twitterbot|TelegramBot|LinkedInBot|Slackbot|Discordbot|Pinterest|Googlebot|bingbot|Applebot|viber/i;

const GENERIC_TITLES = [
  "පින්කම", "පින්කමක්", "උතුම් පින්කම", "උතුම් පින්කමක්", "උතුම පින්කම", "උතුම පින්කමක්",
  "සටහන", "සටහනක්", "පුණ්‍ය සටහන", "පුණ්‍ය සටහනක්", "කුසල් සටහන", "දෛනික කුසල්", "දෛනික කුසල් සටහන",
  "merit", "post", "untitled", "pin potha", "ape pin potha", "share"
];

/**
 * Checks whether a title is a meaningful user-written title or a generic placeholder
 * @param {string} title
 * @returns {boolean}
 */
function isMeaningfulTitle(title) {
  if (!title || typeof title !== "string") return false;
  const clean = title
    .replace(/<[^>]*>?/gm, "")
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDE4F]|\uD83E[\uDD00-\uDDFF]/g, "")
    .replace(/[\s\-_.,;!?]+/g, " ")
    .trim()
    .toLowerCase();
  if (clean.length < 3) return false;
  return !GENERIC_TITLES.includes(clean);
}

/**
 * Normalizes Unicode string (NFC) and removes stray/unpaired surrogates to prevent '?' replacement boxes
 * @param {string} str
 * @returns {string}
 */
function cleanUnicodeString(str) {
  if (!str) return "";
  let s = String(str).normalize("NFC");
  // Strip unpaired surrogates so emojis never corrupt into '?'
  s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return s;
}

/**
 * Slices string by full Unicode code points (graphemes), never splitting emoji surrogate pairs
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function safeUnicodeSlice(str, maxLen = 120) {
  if (!str) return "";
  const cleaned = cleanUnicodeString(str);
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= maxLen) {
    return cleaned;
  }
  const sliced = codePoints.slice(0, maxLen).join("");
  const lastSpace = sliced.lastIndexOf(" ");
  if (lastSpace > Math.floor(maxLen * 0.55)) {
    return sliced.substring(0, lastSpace).trim() + "...";
  }
  return sliced.trim() + "...";
}

/**
 * Escapes characters for safe inclusion in HTML attributes and content while keeping UTF-8 emojis intact
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return "";
  return cleanUnicodeString(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Determines MIME type for social preview meta tags
 * @param {string} url
 * @returns {string}
 */
function getMimeType(url) {
  if (!url) return "image/jpeg";
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * Normalizes candidate image source into a valid, absolute HTTPS URL
 * @param {*} candidate
 * @returns {string|null}
 */
function normalizeImageUrl(candidate) {
  if (!candidate) return null;
  let str = "";
  if (typeof candidate === "string") {
    str = candidate.trim();
  } else if (typeof candidate === "object") {
    const u = candidate.url || candidate.imageUrl || candidate.secure_url || candidate.src;
    if (typeof u === "string") str = u.trim();
  }
  if (!str) return null;

  if (str.startsWith("http://")) {
    str = "https://" + str.slice(7);
  } else if (str.startsWith("//")) {
    str = "https:" + str;
  } else if (str.startsWith("/")) {
    str = `${SITE_ORIGIN}${str}`;
  } else if (str.startsWith("assets/")) {
    str = `${SITE_ORIGIN}/${str}`;
  } else if (!str.startsWith("https://")) {
    str = `${SITE_ORIGIN}/${str}`;
  }

  try {
    const parsed = new URL(str);
    if (parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch (e) {}

  return null;
}

/**
 * Recursively inspects candidates and returns the first valid absolute HTTPS image URL
 * @param {Array<*>} candidates
 * @returns {string|null}
 */
function findFirstValidImageUrl(candidates) {
  if (!Array.isArray(candidates)) return null;
  for (const item of candidates) {
    if (!item) continue;
    if (typeof item === "string") {
      const normalized = normalizeImageUrl(item);
      if (normalized) return normalized;
    } else if (Array.isArray(item)) {
      const nested = findFirstValidImageUrl(item);
      if (nested) return nested;
    } else if (typeof item === "object") {
      const normalized = normalizeImageUrl(item);
      if (normalized) return normalized;
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
  const hasTransform = /^(?:[a-z]_[a-zA-Z0-9_:,]+|\w+,\w+)\//.test(afterUpload);
  if (!hasTransform) {
    const transform = "w_1200,h_630,c_fill,q_auto:eco,f_jpg/";
    return trimmed.substring(0, uploadIdx + uploadMarker.length) + transform + afterUpload;
  }

  return trimmed;
}

/**
 * Maps post category and type to clean, contextual Sinhala badge and emoji
 * @param {Object} docData
 * @returns {string}
 */
function getPostCategoryBadge(docData) {
  if (!docData || typeof docData !== "object") return "🌸 පුණ්‍ය සටහනක්";

  const type = String(docData.type || "").trim().toLowerCase();
  const isNeed = Boolean(
    type === "need" ||
    type === "sathkara" ||
    type === "care" ||
    docData.category === "සමාජ සත්කාර" ||
    docData.isNeed === true ||
    docData.isVerifiedNeed === true
  );
  if (isNeed) return "🤝 සත්කාර ඉල්ලීමක්";

  if (type === "reel" || Boolean(docData.isShorts || docData.videoId)) {
    return "🎬 සදහම් වීඩියෝවක්";
  }

  if (docData.isRepost || type === "repost" || Boolean(docData.originalPost)) {
    return "🔁 යළි බෙදාගත් සටහනක්";
  }

  const cat = String(docData.category || "").trim();
  switch (cat) {
    case "දානමය":
      return "🍲 දානමය පින්කමක්";
    case "ශීලමය":
      return "🪷 ශීලමය පින්කමක්";
    case "භාවනාමය":
      return "🧘 භාවනාමය පින්කමක්";
    case "ධර්ම දානමය":
      return "📖 ධර්ම දානයක්";
    case "වන්දනා":
    case "වන්දනාමය":
      return "🛕 වන්දනාමය පින්කමක්";
    case "බෝධි පූජා":
      return "🍃 බෝධි පූජා පින්කමක්";
    case "කඨින":
      return "🪷 කඨින මහා පින්කමක්";
    case "ප්‍රතිසංස්කරණ":
    case "විහාර නිර්මාණ":
      return "🏛️ විහාර නිර්මාණයක්";
    case "සමාජ සත්කාර":
    case "සත්කාර":
      return "🤝 සමාජ සත්කාරයක්";
    case "සිතුවිලි":
      return "💭 සදහම් සිතුවිල්ලක්";
    case "සුබපැතුම්":
      return "✨ සදහම් සුබපැතුමක්";
    case "සාමාන්‍ය":
    case "සාමාන්ය":
    default:
      return "🌸 පුණ්‍ය සටහනක්";
  }
}

/**
 * Extracts a concise, meaningful topic hook (35-50 characters) from post title or opening content
 * @param {Object} docData
 * @param {number} maxLen
 * @returns {string}
 */
function extractTopicSnippet(docData, maxLen = 45) {
  if (!docData || typeof docData !== "object") return "උතුම් පුණ්‍ය සටහන";

  let raw = "";
  if (isMeaningfulTitle(docData.title)) {
    raw = String(docData.title).trim();
  } else if (docData.description && typeof docData.description === "string") {
    raw = docData.description.trim();
  } else if (docData.content && typeof docData.content === "string") {
    raw = docData.content.trim();
  } else if (docData.text && typeof docData.text === "string") {
    raw = docData.text.trim();
  }

  // Fallback to category-specific natural label if content is completely empty
  if (!raw) {
    const type = String(docData.type || "").toLowerCase();
    if (type === "need" || docData.category === "සමාජ සත්කාර") return "කාරුණික සත්කාරක ඉල්ලීම";
    if (type === "reel") return "සදහම් වීඩියෝව";
    if (docData.category === "දානමය") return "උතුම් දානමය පින්කම";
    if (docData.category === "ශීලමය") return "උතුම් ශීලමය පින්කම";
    if (docData.category === "භාවනාමය") return "භාවනාමය සිතුවිල්ල";
    return "උතුම් පුණ්‍ය සටහන";
  }

  let clean = raw
    .replace(/<[^>]*>?/gm, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\r\n\t]+/g, " ")
    .trim();

  // Strip repetitive checklist headers, decorative emojis, or boilerplate greetings
  clean = clean.replace(/^(?:🌸\s*)?අද\s+දින\s*(?:\([^)]+\))?\s*(?:මම|අප)?\s*සම්පූර්ණ\s*කළ\s*දෛනික\s*කුසල්\s*[:\-\s]*/i, "");
  clean = clean.replace(/^(?:🌸|✨|🙏|✅|👉|•|-|\*)\s*/, "");
  clean = clean.replace(/^(?:සාදරයෙන්\s+පිළිගනිමු!?|සාදු\s+සාදු\s+සාදු!?)\s*/i, "");
  clean = clean.replace(/\s+/g, " ").trim();

  if (!clean) {
    return "උතුම් පුණ්‍ය සටහන";
  }

  let sliced = safeUnicodeSlice(clean, maxLen);
  return sliced.replace(/\.{2,}$/, "").replace(/[\s.,;:!\-]+$/, "").trim();
}

/**
 * Builds a natural, informative Sinhala summary for Open Graph description
 * @param {Object} docData
 * @param {number} maxLen
 * @returns {string}
 */
function extractPostDescription(docData, maxLen = 160) {
  if (!docData) {
    return "අපේ පිං පොත (apepinpotha.lk) ඩිජිටල් පුණ්‍ය ජාලය ඔස්සේ උතුම් පින්කම් දැකබලා සාදුකාර දී අනුමෝදන් වන්න.";
  }

  const rawDesc = String(docData.description || docData.content || docData.text || "")
    .replace(/<[^>]*>?/gm, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const rawTitle = String(docData.title || "").replace(/<[^>]*>?/gm, "").trim();
  let clean = rawDesc;

  // Strip duplicate leading title
  if (rawTitle && clean.toLowerCase().startsWith(rawTitle.toLowerCase())) {
    clean = clean.substring(rawTitle.length).replace(/^[\s:;.-]+/, "").trim();
  }

  const isNeed = Boolean(
    docData.type === "need" ||
    docData.type === "sathkara" ||
    docData.type === "care" ||
    docData.category === "සමාජ සත්කාර" ||
    docData.isNeed === true ||
    docData.isVerifiedNeed === true
  );

  if (!clean || clean.length < 15) {
    const author = docData.isOfficial ? "අපේ පිං පොත" : (docData.author || docData.authorName || "කල්‍යාණ මිත්‍රයෙක්");
    if (isNeed) {
      const contact = (docData.contact || docData.contactNumber || docData.phone || "").trim();
      const contactStr = contact ? ` විමසීම්: ${contact}.` : "";
      return `විහාරස්ථාන සහ සමාජ සත්කාර සඳහා සිදු කරන කාරුණික ඇරයුමකි.${contactStr} වැඩිදුර විස්තර සඳහා පිවිසෙන්න.`;
    }
    return `${author} විසින් අපේ පිං පොත (apepinpotha.lk) වෙත එක් කළ උතුම් සටහනකි. සාදු සිතින් අනුමෝදන් වන්න.`;
  }

  if (isNeed) {
    const contact = (docData.contact || docData.contactNumber || docData.phone || "").trim();
    if (contact && !clean.includes(contact)) {
      const suffix = ` (විමසීම්: ${contact})`;
      const targetLen = maxLen - suffix.length;
      return safeUnicodeSlice(clean, targetLen) + suffix;
    }
  }

  return safeUnicodeSlice(clean, maxLen);
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

  let cleanId = rawId;
  try {
    cleanId = decodeURIComponent(rawId);
  } catch (e) {}

  // Determine target human redirect destination on the main website
  let redirectUrl = SITE_ORIGIN;
  let canonicalUrl = SHARE_ORIGIN;
  if (type === "a" && cleanId) {
    redirectUrl = `${SITE_ORIGIN}/?a=${encodeURIComponent(cleanId)}`;
    canonicalUrl = `${SHARE_ORIGIN}/a/${encodeURIComponent(cleanId)}`;
  } else if (type === "p" && cleanId) {
    redirectUrl = `${SITE_ORIGIN}/?p=${encodeURIComponent(cleanId)}`;
    canonicalUrl = `${SHARE_ORIGIN}/p/${encodeURIComponent(cleanId)}`;
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

  if (type === "a" && cleanId) {
    // Temple Artisans & Perahera Services Directory
    const docData = await fetchFirestoreDoc("temple_artisans", cleanId);
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
        pageDescription = safeUnicodeSlice(descParts.join(" | "), 200);
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
      imageUrl = imgCandidate || ARTISAN_DEFAULT_IMAGE;
    } else {
      pageTitle = "සත්‍යාපිත විහාර කලා හා පෙරහැර ශිල්පී පැතිකඩ | අපේ පිං පොත";
      pageDescription = "අපේ පිං පොත විහාර කලා හා පෙරහැර ශිල්පී නාමාවලිය ඔස්සේ සම්පූර්ණ පැතිකඩ සහ නිර්මාණ එකතුව (Portfolio) දැකබලා ගන්න.";
      imageUrl = ARTISAN_DEFAULT_IMAGE;
    }
  } else if (type === "p" && cleanId) {
    // Merit Posts & Sathkara Community Feed
    const docData = await fetchFirestoreDoc("merit_posts", cleanId);
    if (docData) {
      const categoryBadge = getPostCategoryBadge(docData);
      const topicSnippet = extractTopicSnippet(docData, 45);
      const author = docData.isOfficial
        ? "අපේ පිං පොත"
        : (docData.author || docData.authorName || "කල්‍යාණ මිත්‍රයෙක්");

      // Context-aware og:title (clean emoji/category + topic hook + author + site name)
      const isGeneralCategory = (categoryBadge === "🌸 පුණ්‍ය සටහනක්");
      if (docData.isOfficial || author === "අපේ පිං පොත" || author === "අපේ පින් පොත") {
        pageTitle = isGeneralCategory 
          ? `🌸 ${topicSnippet} | අපේ පිං පොත` 
          : `${categoryBadge}: ${topicSnippet} | අපේ පිං පොත`;
      } else {
        pageTitle = isGeneralCategory 
          ? `🌸 ${topicSnippet} — ${author} | අපේ පිං පොත` 
          : `${categoryBadge}: ${topicSnippet} — ${author} | අපේ පිං පොත`;
      }

      pageDescription = extractPostDescription(docData, 160);

      const imgCandidate = findFirstValidImageUrl([
        docData.image,
        docData.imageUrl,
        docData.images,
        docData.mediaUrl,
        docData.thumbnail,
        docData.videoThumbnail,
        docData.videoThumb,
        docData.bannerUrl,
        docData.authorPhoto
      ]);

      if (imgCandidate) {
        imageUrl = imgCandidate;
      } else if (docData.category === "විහාර නිර්මාණ" || docData.category === "ප්‍රතිසංස්කරණ") {
        imageUrl = ARTISAN_DEFAULT_IMAGE;
      } else {
        imageUrl = DEFAULT_IMAGE;
      }
    } else {
      pageTitle = "පුණ්‍ය සටහන දැකබලා අනුමෝදන් වන්න | අපේ පිං පොත";
      pageDescription = "අපේ පිං පොත කල්‍යාණ මිත්‍ර පුණ්‍ය ජාලය ඔස්සේ පුණ්‍ය සටහන් දැකබලා සාදුකාර දී අනුමෝදන් වන්න.";
      imageUrl = DEFAULT_IMAGE;
    }
  }

  // Ensure description length does not exceed social card limit
  if (pageDescription.length > 250) {
    pageDescription = safeUnicodeSlice(pageDescription, 240);
  }

  const optimizedImage = optimizeOgImage(imageUrl);
  const imageMimeType = getMimeType(optimizedImage);

  const safeTitle = escapeHtml(pageTitle);
  const safeDesc = escapeHtml(pageDescription);
  const safeImage = escapeHtml(optimizedImage);
  const safeUrl = escapeHtml(canonicalUrl);
  const safeRedirectUrl = escapeHtml(redirectUrl);

  const html = `<!DOCTYPE html>
<html lang="si">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
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
  <meta property="og:image:secure_url" content="${safeImage}">
  <meta property="og:image:type" content="${imageMimeType}">
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

  const responseBuffer = Buffer.from(html, "utf-8");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", responseBuffer.length);
  res.setHeader("Cache-Control", "public, max-age=120, s-maxage=300, stale-while-revalidate=600");
  return res.status(200).end(responseBuffer);
};
