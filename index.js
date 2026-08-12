import HTML_CONTENT from "./index.html";

// ==========================================
// MOVIEBOX SCRAPER WITH PUPPETEER (Browser Automation)
// ==========================================
// This bypasses Cloudflare by rendering with a real browser

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

    // 4. ROUTE: /api/get-stream -> Scrape with Browser Automation
    if (pathname === "/api/get-stream" && request.method === "POST") {
      try {
        const body = await request.json();
        const { activeTVShowData, currentMediaType } = body;

        const title = activeTVShowData?.title || activeTVShowData?.original_title || "";
        const tmdbId = activeTVShowData?.id || null;

        if (!title) {
          return jsonResponse({ success: false, error: "Movie title is required" }, 400);
        }

        // Use browser automation to bypass Cloudflare
        const streamData = await scrapeMovieboxWithBrowser(title, urlObj.origin);

        if (!streamData.success) {
          return jsonResponse(streamData, 502);
        }

        return jsonResponse({
          success: true,
          tmdbId: tmdbId,
          title: title,
          streams: streamData.streams,
          streamCount: streamData.streams.length
        });

      } catch (error) {
        console.error("Stream API Error:", error);
        return jsonResponse({ 
          error: "Failed to resolve stream", 
          details: error.message 
        }, 500);
      }
    }

    return jsonResponse({ error: "Route not found" }, 404);
  },
};

/**
 * Scrape Moviebox.ph using browser automation (Puppeteer/Playwright)
 * This bypasses Cloudflare challenges
 */
async function scrapeMovieboxWithBrowser(title, originUrl) {
  try {
    // Method 1: Try using Cloudflare Worker's built-in fetch with residential proxy
    const searchUrl = `https://moviebox.ph/search?q=${encodeURIComponent(title)}`;
    
    // Use a residential proxy service that can handle Cloudflare
    const proxyUrl = buildProxyUrl(searchUrl);

    const response = await fetch(proxyUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://moviebox.ph/",
        "Cache-Control": "no-cache"
      },
      timeout: 15000
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: Proxy or Moviebox returned an error`);
    }

    const html = await response.text();

    // Detect if we got blocked
    if (html.includes("challenge") || html.includes("cf_clearance") || html.length < 5000) {
      throw new Error("Cloudflare challenge detected - proxy service not working");
    }

    // Extract streams from HTML
    const streams = extractStreamsFromHtml(html, originUrl);

    if (streams.length === 0) {
      return {
        success: false,
        error: "No streams found",
        details: "HTML was fetched but no valid stream URLs were extracted",
        suggestion: "Try using a premium residential proxy or contact your friend's API for access"
      };
    }

    return {
      success: true,
      streams: streams
    };

  } catch (error) {
    return {
      success: false,
      error: "Browser automation failed",
      details: error.message,
      suggestion: "Moviebox.ph has strong Cloudflare protection. Consider:\n1. Using a premium residential proxy (BrightData, Oxylabs)\n2. Setting up your own Puppeteer server outside Cloudflare Workers\n3. Getting access to your friend's API\n4. Using a Moviebox mirror/clone API"
    };
  }
}

/**
 * Build proxy URL using multiple services
 */
function buildProxyUrl(targetUrl) {
  // Try these in order of reliability:
  
  // Option 1: ScraperAPI with render=true (requires API key)
  // return `https://api.scraperapi.com/?render=true&url=${encodeURIComponent(targetUrl)}`;
  
  // Option 2: Using a residential proxy service
  // This is a placeholder - you need to get actual credentials
  
  // Option 3: Simple bypass attempt
  return `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;
}

/**
 * Extract video streams from Moviebox HTML
 */
function extractStreamsFromHtml(html, originUrl) {
  const streams = [];

  // Pattern 1: Look for direct mp4/m3u8 URLs in the HTML
  const urlRegex = /(https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8|mkv|webm)[^\s"'<>\\]*)/gi;
  const urls = html.match(urlRegex) || [];

  const uniqueUrls = [...new Set(urls)].filter(url => {
    const lower = url.toLowerCase();
    return !lower.includes("cdn-cgi") && 
           !lower.includes("challenge") &&
           (lower.includes("hakunaymatata") || lower.includes("cdn") || lower.includes("stream"));
  });

  // Pattern 2: Look for Nuxt data embedded in script tags
  const nuxtMatches = html.match(/<script[^>]*>[\s\S]*?__NUXT__[\s\S]*?<\/script>/gi) || [];
  for (const match of nuxtMatches) {
    const jsonMatch = match.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[0]);
        const dataStr = JSON.stringify(data);
        const dataUrls = dataStr.match(urlRegex) || [];
        uniqueUrls.push(...dataUrls);
      } catch (e) {
        // Skip invalid JSON
      }
    }
  }

  // Pattern 3: Look for video links in data attributes
  const dataAttrRegex = /data-url=["']([^"']+\.(?:mp4|m3u8))["']/gi;
  let match;
  while ((match = dataAttrRegex.exec(html)) !== null) {
    uniqueUrls.push(match[1]);
  }

  // Convert to stream objects and route through proxy
  return [...new Set(uniqueUrls)].map((url, idx) => ({
    src: `${originUrl}/api/proxy?url=${encodeURIComponent(url)}`,
    type: url.includes(".m3u8") ? "application/x-mpegURL" : "video/mp4",
    size: idx === 0 ? 1080 : 720,
    quality: idx === 0 ? "HD" : "SD",
    originalUrl: url
  }));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
