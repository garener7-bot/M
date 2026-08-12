import HTML_CONTENT from "./index.html";

// ==========================================
// SCRAPER PROXY CONFIGURATION
// ==========================================
// To bypass moviebox.ph 403 Datacenter IP blocks, route the scrape requests
// through an external web/CORS proxy or Scraper API.
// Examples you can test:
// 1. "https://corsproxy.io/?url="
// 2. "https://api.allorigins.win/raw?url="
// 3. "https://api.scraperapi.com/?api_key=YOUR_KEY&url="
// Change line 11 to use AllOrigins' raw proxy:
// Replace YOUR_API_KEY with your actual free ScraperAPI key:
const SCRAPER_PROXY_PREFIX = "https://api.scraperapi.com/?api_key=bdebaa5b878cd226176e065d0c675b98&url=";



export default {
  async fetch(request, env, ctx) {
    const urlObj = new URL(request.url);
    const pathname = urlObj.pathname;

    // 1. CORS Preflight Handler
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 2. ROUTE: Serve Test UI on root (/)
    if (pathname === "/" && request.method === "GET") {
      return new Response(HTML_CONTENT, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 3. ROUTE: /api/proxy -> Video Stream Proxy (Spoofs Moviebox.ph headers)
    if (pathname === "/api/proxy") {
      const targetUrl = urlObj.searchParams.get("url");
      if (!targetUrl) {
        return jsonResponse({ error: "Missing 'url' parameter" }, 400);
      }

      try {
        const upstreamHeaders = new Headers();
        const rangeHeader = request.headers.get("Range");
        if (rangeHeader) upstreamHeaders.set("Range", rangeHeader);

        // Spoof Moviebox.ph headers so the CDN allows streaming
        upstreamHeaders.set(
          "User-Agent",
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36"
        );
        upstreamHeaders.set("Referer", "https://moviebox.ph/");
        upstreamHeaders.set("Origin", "https://moviebox.ph");

        const upstreamResponse = await fetch(targetUrl, {
          method: request.method,
          headers: upstreamHeaders,
          redirect: "follow",
        });

        const responseHeaders = new Headers(upstreamResponse.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
        responseHeaders.set("Accept-Ranges", "bytes");
        responseHeaders.delete("content-security-policy");
        responseHeaders.delete("x-frame-options");

        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: responseHeaders,
        });
      } catch (error) {
        return jsonResponse({ error: "Proxy stream failed", details: error.message }, 502);
      }
    }

    // 4. ROUTE: /api/get-stream -> Dynamically Scrape via Proxy to bypass 403
       // 4. ROUTE: /api/get-stream -> Dynamically Scrape Moviebox.ph HTML & Extract Nuxt JSON
    if (pathname === "/api/get-stream" && request.method === "POST") {
      try {
        const body = await request.json();
        const { activeTVShowData, currentMediaType } = body;

        const title = activeTVShowData?.title || activeTVShowData?.original_title || "";
        const tmdbId = activeTVShowData?.id || null;

        if (!title) {
          return jsonResponse({ success: false, error: "Movie title is required" }, 400);
        }

        // Standard browser headers to blend in with normal traffic
        const mbHeaders = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://moviebox.ph/",
          "Origin": "https://moviebox.ph",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        };

        let freshSources = [];
        let debugNuxtData = null;

        try {
          // STEP A: Fetch the real Moviebox HTML Search Page via ScraperAPI
          const rawSearchUrl = `https://moviebox.ph/search?q=${encodeURIComponent(title)}`;
          const proxiedSearchUrl = `${SCRAPER_PROXY_PREFIX}${encodeURIComponent(rawSearchUrl)}`;
          
          const searchRes = await fetch(proxiedSearchUrl, { headers: mbHeaders });
          const searchHtml = await searchRes.text();
          
          // STEP B: Extract the embedded Nuxt.js JSON Data from the HTML script tags
          // Moviebox embeds page data in either __NUXT_DATA__ (Nuxt 3) or window.__NUXT__ (Nuxt 2)
          const nuxtDataRegex = /<script id="__NUXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i;
          const legacyNuxtRegex = /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});<\/script>/i;

          let extractedJson = null;
          const matchNuxt3 = searchHtml.match(nuxtDataRegex);
          const matchNuxt2 = searchHtml.match(legacyNuxtRegex);

          if (matchNuxt3 && matchNuxt3[1]) {
            extractedJson = JSON.parse(matchNuxt3[1]);
          } else if (matchNuxt2 && matchNuxt2[1]) {
            extractedJson = JSON.parse(matchNuxt2[1]);
          }

          debugNuxtData = extractedJson; // Save for debugging if needed

          if (!extractedJson) {
            throw new Error("Could not extract embedded Nuxt JSON from Moviebox HTML. (Cloudflare may have served a captcha page).");
          }

          // STEP C: Find streaming URLs (hakunaymatata.com / CDN links) inside the Nuxt state
          // We convert the whole JSON tree to a string to reliably hunt for .mp4 / .m3u8 CDN URLs
          const jsonString = JSON.stringify(extractedJson);
          
          // Regex to capture video stream URLs (hakunaymatata CDN or any standard mp4/m3u8 link)
          const urlRegex = /(https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8)[^\s"'<>\\]*)/gi;
          const foundUrls = jsonString.match(urlRegex) || [];

          // Remove duplicates and filter for clean video stream links
          const uniqueStreamUrls = [...new Set(foundUrls)].filter(url => 
            url.includes("hakunaymatata.com") || url.includes(".mp4") || url.includes("cdn")
          );

          if (uniqueStreamUrls.length > 0) {
            freshSources = uniqueStreamUrls.map((streamUrl, idx) => ({
              // Route through your Worker's proxy (/api/proxy) so the video plays without CORS issues
              src: `${urlObj.origin}/api/proxy?url=${encodeURIComponent(streamUrl)}`,
              type: streamUrl.includes(".m3u8") ? "application/x-mpegURL" : "video/mp4",
              size: idx === 0 ? 1080 : 720 // Default quality labels
            }));
          }

        } catch (e) {
          console.error("Moviebox HTML Scraper Error:", e.message);
          return jsonResponse({ 
            success: false, 
            error: "Failed to scrape Moviebox.ph HTML or parse Nuxt state", 
            details: e.message 
          }, 502);
        }

        // If no streams were found, return debug data so you can inspect the Nuxt schema
        if (freshSources.length === 0) {
          return jsonResponse({
            success: false,
            error: `No playable CDN streams found in Moviebox HTML for "${title}"`,
            debug: {
              note: "We successfully parsed the HTML page, but found no direct mp4/m3u8 URLs in the Nuxt payload.",
              extractedNuxtSample: debugNuxtData ? JSON.stringify(debugNuxtData).substring(0, 500) : "Null"
            }
          }, 404);
        }

        return jsonResponse({
          success: true,
          tmdbId: tmdbId,
          realQualitySources: freshSources
        });

      } catch (error) {
        return jsonResponse({ error: "Failed to resolve stream", details: error.message }, 500);
      }
    }

    return jsonResponse({ error: "Route not found" }, 404);
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
