import HTML_CONTENT from "./index.html";

export default {
  async fetch(request, env, ctx) {
    const urlObj = new URL(request.url);
    const pathname = urlObj.pathname;

    // CORS Preflight
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

    // Root UI
    if (pathname === "/" && request.method === "GET") {
      return new Response(HTML_CONTENT, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Video proxy
    if (pathname === "/api/proxy") {
      const targetUrl = urlObj.searchParams.get("url");
      if (!targetUrl) {
        return jsonResponse({ error: "Missing 'url' parameter" }, 400);
      }

      try {
        const upstreamHeaders = new Headers();
        const rangeHeader = request.headers.get("Range");
        if (rangeHeader) upstreamHeaders.set("Range", rangeHeader);

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

    // DEBUG endpoint - shows EXACT what Moviebox sends
    if (pathname === "/api/debug-scrape" && request.method === "POST") {
      try {
        const body = await request.json();
        const { title } = body;

        if (!title) {
          return jsonResponse({ success: false, error: "Movie title is required" }, 400);
        }

        const searchUrl = `https://moviebox.ph/search?q=${encodeURIComponent(title)}`;
        const results = [];

        // Try direct fetch
        console.log(`\n[DEBUG] Fetching: ${searchUrl}\n`);
        try {
          const response = await fetch(searchUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
              "Referer": "https://moviebox.ph/",
              "Cache-Control": "no-cache"
            }
          });

          const html = await response.text();
          const htmlSize = html.length;
          const hasChallenge = html.includes("challenge") || html.includes("cf_clearance") || html.includes("__cf_bm");

          console.log(`Status: ${response.status}, Size: ${htmlSize} bytes, Challenge: ${hasChallenge}`);

          // Extract everything
          const scriptTags = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
          const allJson = html.match(/\{[\s\S]*?\}/g) || [];
          const videoUrls = html.match(/(https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8|mkv|webm)[^\s"'<>\\]*)/gi) || [];

          // Look for specific patterns
          const patterns = {};
          const patternRegexes = {
            "__NUXT_DATA__": /<script id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
            "window.__NUXT__": /window\.__NUXT__\s*=\s*({[\s\S]*?});/i,
            "nuxt-data attribute": /<script[^>]*data-nuxt-data[^>]*>([\s\S]*?)<\/script>/i,
            "__NUXT_JSON__": /<script id="__NUXT_JSON__"[^>]*>([\s\S]*?)<\/script>/i,
            "window.__INITIAL_STATE__": /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/i,
          };

          for (const [name, regex] of Object.entries(patternRegexes)) {
            const match = html.match(regex);
            if (match && match[1]) {
              patterns[name] = match[1].substring(0, 1000);
            }
          }

          results.push({
            method: "Direct Fetch",
            status: response.status,
            htmlSize: htmlSize,
            hasCloudflareChallenge: hasChallenge,
            scriptTagsCount: scriptTags.length,
            jsonObjectsFound: allJson.length,
            videoUrlsFound: videoUrls.length,
            videoUrls: videoUrls.slice(0, 5),
            foundPatterns: Object.keys(patterns),
            patternsData: patterns,
            rawHtmlPreview: html.substring(0, 3000),
            firstJsonSample: allJson.length > 0 ? allJson[0].substring(0, 500) : null
          });
        } catch (error) {
          results.push({
            method: "Direct Fetch",
            error: error.message
          });
        }

        return jsonResponse({
          success: true,
          title: title,
          message: "This shows EXACTLY what Moviebox.ph is sending. Share this output to debug.",
          timestamp: new Date().toISOString(),
          debugResults: results
        });

      } catch (error) {
        return jsonResponse({ error: "Debug failed", details: error.message }, 500);
      }
    }

    // Get streams (production endpoint)
    if (pathname === "/api/get-stream" && request.method === "POST") {
      try {
        const body = await request.json();
        const { activeTVShowData } = body;

        const title = activeTVShowData?.title || activeTVShowData?.original_title || "";
        const tmdbId = activeTVShowData?.id || null;

        if (!title) {
          return jsonResponse({ success: false, error: "Movie title is required" }, 400);
        }

        const searchUrl = `https://moviebox.ph/search?q=${encodeURIComponent(title)}`;

        // Try to fetch
        let html = null;
        try {
          const res = await fetch(searchUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Referer": "https://moviebox.ph/"
            }
          });
          if (res.ok) {
            html = await res.text();
          }
        } catch (e) {
          console.log("Direct fetch failed");
        }

        // Fallback to proxy if direct fails
        if (!html) {
          try {
            const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(searchUrl)}`);
            if (res.ok) {
              html = await res.text();
            }
          } catch (e) {
            console.log("Proxy fetch failed");
          }
        }

        if (!html) {
          return jsonResponse({
            success: false,
            error: "Cannot fetch Moviebox.ph",
            details: "Both direct and proxy methods failed. Try /api/debug-scrape to diagnose.",
            debugUrl: `${urlObj.origin}/api/debug-scrape`
          }, 502);
        }

        // Extract video URLs
        const videoUrls = (html.match(/(https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8|mkv|webm)[^\s"'<>\\]*)/gi) || [])
          .filter(url => !url.toLowerCase().includes("cdn-cgi"));

        const uniqueUrls = [...new Set(videoUrls)];

        if (uniqueUrls.length === 0) {
          return jsonResponse({
            success: false,
            error: "No video streams found in Moviebox response",
            details: `Received ${html.length} bytes but no .mp4/.m3u8 URLs found`,
            debugUrl: `${urlObj.origin}/api/debug-scrape?title=${encodeURIComponent(title)}`,
            suggestion: "Use /api/debug-scrape to see what Moviebox is actually sending"
          }, 404);
        }

        const streams = uniqueUrls.map((url, idx) => ({
          src: `${urlObj.origin}/api/proxy?url=${encodeURIComponent(url)}`,
          type: url.includes(".m3u8") ? "application/x-mpegURL" : "video/mp4",
          size: idx === 0 ? 1080 : 720,
          quality: idx === 0 ? "HD" : "SD"
        }));

        return jsonResponse({
          success: true,
          tmdbId: tmdbId,
          title: title,
          streams: streams,
          streamCount: streams.length
        });

      } catch (error) {
        console.error("Stream Error:", error);
        return jsonResponse({ error: "Failed to get streams", details: error.message }, 500);
      }
    }

    return jsonResponse({ 
      error: "Route not found",
      available_routes: [
        "GET /",
        "POST /api/debug-scrape (shows exact Moviebox JSON)",
        "POST /api/get-stream (gets video streams)"
      ]
    }, 404);
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
