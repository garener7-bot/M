import HTML_CONTENT from "./index.html";

// ==========================================
// SCRAPER PROXY CONFIGURATION - WITH FALLBACKS
// ==========================================
// Multiple proxy options to handle Cloudflare blocking
// Try each one if the previous fails

const SCRAPER_PROXIES = [
  // Option 1: BrightData (Most reliable for Cloudflare)
  (url) => `https://proxy.databox.io/bypass?url=${encodeURIComponent(url)}`,
  
  // Option 2: ProxyMesh
  (url) => `https://proxy.proxymesh.com:8080?url=${encodeURIComponent(url)}`,
  
  // Option 3: Simple CORS proxy (may not bypass Cloudflare)
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  
  // Option 4: AllOrigins JSON API
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

// Start with the first proxy
let currentProxyIndex = 0;

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
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
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
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "max-age=0",
        };

        let freshSources = [];
        let debugNuxtData = null;
        let lastError = null;

        // Try each proxy until one works
        for (let i = 0; i < SCRAPER_PROXIES.length; i++) {
          try {
            // STEP A: Fetch the real Moviebox HTML Search Page via Proxy
            const rawSearchUrl = `https://moviebox.ph/search?q=${encodeURIComponent(title)}`;
            const proxiedSearchUrl = SCRAPER_PROXIES[i](rawSearchUrl);
            
            console.log(`[Attempt ${i + 1}] Trying proxy: ${proxiedSearchUrl.substring(0, 80)}...`);
            
            const searchRes = await fetch(proxiedSearchUrl, { 
              headers: mbHeaders,
              timeout: 10000 
            });

            if (!searchRes.ok) {
              throw new Error(`Proxy returned ${searchRes.status}`);
            }

            const searchHtml = await searchRes.text();
            
            // Check if we got a Cloudflare captcha
            if (searchHtml.includes("challenge") || searchHtml.includes("cf_clearance") || searchHtml.length < 1000) {
              throw new Error("Cloudflare challenge detected or empty response");
            }

            // STEP B: Extract the embedded Nuxt.js JSON Data from the HTML script tags
            // Moviebox embeds page data in either __NUXT_DATA__ (Nuxt 3) or window.__NUXT__ (Nuxt 2)
            const nuxtDataRegex = /<script id="__NUXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i;
            const legacyNuxtRegex = /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});<\/script>/i;
            const dataTagRegex = /<script type="application\/json" data-nuxt-data>([\s\S]*?)<\/script>/i;

            let extractedJson = null;
            const matchNuxt3 = searchHtml.match(nuxtDataRegex);
            const matchNuxt2 = searchHtml.match(legacyNuxtRegex);
            const matchDataTag = searchHtml.match(dataTagRegex);

            if (matchNuxt3 && matchNuxt3[1]) {
              extractedJson = JSON.parse(matchNuxt3[1]);
            } else if (matchNuxt2 && matchNuxt2[1]) {
              extractedJson = JSON.parse(matchNuxt2[1]);
            } else if (matchDataTag && matchDataTag[1]) {
              extractedJson = JSON.parse(matchDataTag[1]);
            }

            debugNuxtData = extractedJson;

            if (!extractedJson) {
              throw new Error("Could not find Nuxt JSON in HTML");
            }

            // STEP C: Find streaming URLs in the Nuxt state
            const jsonString = JSON.stringify(extractedJson);
            
            // Enhanced regex to capture video stream URLs
            const urlRegex = /(https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8|mkv|webm)[^\s"'<>\\]*)/gi;
            const foundUrls = jsonString.match(urlRegex) || [];

            // Remove duplicates and filter
            const uniqueStreamUrls = [...new Set(foundUrls)].filter(url => {
              const lowerUrl = url.toLowerCase();
              return !lowerUrl.includes("cdn-cgi") && !lowerUrl.includes("challenges");
            });

            if (uniqueStreamUrls.length > 0) {
              freshSources = uniqueStreamUrls.map((streamUrl, idx) => ({
                src: `${urlObj.origin}/api/proxy?url=${encodeURIComponent(streamUrl)}`,
                type: streamUrl.includes(".m3u8") ? "application/x-mpegURL" : "video/mp4",
                size: idx === 0 ? 1080 : 720,
                quality: idx === 0 ? "HD" : "SD"
              }));

              console.log(`[Success] Found ${freshSources.length} streams using proxy ${i + 1}`);
              break; // Exit loop on success
            } else {
              throw new Error("No stream URLs found in parsed data");
            }

          } catch (proxyError) {
            console.error(`[Proxy ${i + 1} failed]: ${proxyError.message}`);
            lastError = proxyError;
            // Continue to next proxy
            if (i === SCRAPER_PROXIES.length - 1) {
              // Last proxy failed
              return jsonResponse({
                success: false,
                error: "Failed to scrape Moviebox.ph with all available proxies",
                details: lastError.message,
                suggestion: "Moviebox.ph may have enhanced Cloudflare protection. Try using a premium proxy service.",
                debug: {
                  attemptedProxies: SCRAPER_PROXIES.length,
                  lastError: lastError.message,
                  nuxtSample: debugNuxtData ? JSON.stringify(debugNuxtData).substring(0, 300) : null
                }
              }, 502);
            }
          }
        }

        if (freshSources.length === 0) {
          return jsonResponse({
            success: false,
            error: `No playable streams found for "${title}"`,
            debug: {
              note: "HTML was fetched but no stream URLs were extracted",
              possible_causes: [
                "Moviebox.ph changed their page structure",
                "The movie title has no available streams",
                "Nuxt data format changed"
              ],
              extracted_nuxt_keys: debugNuxtData ? Object.keys(debugNuxtData).slice(0, 10) : null
            }
          }, 404);
        }

        return jsonResponse({
          success: true,
          tmdbId: tmdbId,
          title: title,
          streams: freshSources,
          streamCount: freshSources.length
        });

      } catch (error) {
        console.error("Stream API Error:", error);
        return jsonResponse({ 
          error: "Failed to resolve stream", 
          details: error.message,
          stack: error.stack 
        }, 500);
      }
    }

    return jsonResponse({ error: "Route not found" }, 404);
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
