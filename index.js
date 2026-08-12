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

    // DEBUG endpoint - THIS WILL SHOW YOU EXACTLY WHAT MOVIEBOX IS SENDING
    if (pathname === "/api/debug-scrape" && request.method === "POST") {
      try {
        const body = await request.json();
        const { title } = body;

        if (!title) {
          return jsonResponse({ success: false, error: "Movie title is required" }, 400);
        }

        const searchUrl = `https://moviebox.ph/search?q=${encodeURIComponent(title)}`;
        const allAttempts = [];

        // ATTEMPT 1: Direct fetch with full browser headers
        console.log(`\n[ATTEMPT 1] Direct fetch from: ${searchUrl}\n`);
        try {
          const response = await fetch(searchUrl, {
            method: "GET",
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
              "Accept-Language": "en-US,en;q=0.9",
              "Accept-Encoding": "gzip, deflate, br",
              "DNT": "1",
              "Connection": "keep-alive",
              "Upgrade-Insecure-Requests": "1",
              "Sec-Fetch-Dest": "document",
              "Sec-Fetch-Mode": "navigate",
              "Sec-Fetch-Site": "none",
              "Sec-Fetch-User": "?1",
              "Cache-Control": "max-age=0"
            }
          });

          const html = await response.text();
          const size = html.length;
          const isCloudflareChallenge = html.includes("challenge-platform") || 
                                       html.includes("__cf_bm") || 
                                       html.includes("Checking your browser") ||
                                       html.includes("cf_clearance");

          console.log(`Status: ${response.status}`);
          console.log(`Size: ${size} bytes`);
          console.log(`Is Cloudflare Challenge: ${isCloudflareChallenge}`);

          // Extract patterns
          const allScripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
          const allJson = html.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) || [];
          const videoUrls = html.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|mkv|webm)[^\s"'<>]*)/gi) || [];

          // Specific pattern searches
          const patterns = {};
          const patternChecks = [
            { name: "__NUXT_DATA__", regex: /<script id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i },
            { name: "window.__NUXT__", regex: /window\.__NUXT__\s*=\s*\{([\s\S]*?)\};<\/script>/i },
            { name: "data-nuxt-data", regex: /<script[^>]*data-nuxt-data[^>]*>([\s\S]*?)<\/script>/i },
            { name: "__NUXT_JSON__", regex: /<script id="__NUXT_JSON__"[^>]*>([\s\S]*?)<\/script>/i },
            { name: "__INITIAL_STATE__", regex: /window\.__INITIAL_STATE__\s*=\s*\{([\s\S]*?)\};/i },
            { name: "initial-state", regex: /<script id="initial-state"[^>]*>([\s\S]*?)<\/script>/i }
          ];

          for (const check of patternChecks) {
            const match = html.match(check.regex);
            if (match && match[1]) {
              patterns[check.name] = `FOUND - ${match[1].substring(0, 200)}...`;
            }
          }

          allAttempts.push({
            attempt: "Direct Fetch",
            status: response.status,
            htmlSize: size,
            isCloudflareChallenge: isCloudflareChallenge,
            scriptTagsCount: allScripts.length,
            jsonObjectsFound: allJson.length,
            videoUrlsCount: videoUrls.length,
            videoUrls: videoUrls.slice(0, 3),
            patternsFound: patterns,
            htmlPreview: html.substring(0, 2000),
            rawHtml: html // FULL RAW HTML FOR INSPECTION
          });

        } catch (error) {
          console.error("Direct fetch error:", error.message);
          allAttempts.push({
            attempt: "Direct Fetch",
            error: error.message,
            errorType: error.constructor.name
          });
        }

        // ATTEMPT 2: Via allorigins proxy
        console.log(`\n[ATTEMPT 2] Via allorigins proxy\n`);
        try {
          const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(searchUrl)}`;
          const response = await fetch(proxyUrl, {
            method: "GET",
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
          });

          const html = await response.text();
          const size = html.length;
          const isCloudflareChallenge = html.includes("challenge-platform") || html.includes("__cf_bm");

          const videoUrls = html.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|mkv|webm)[^\s"'<>]*)/gi) || [];

          allAttempts.push({
            attempt: "AllOrigins Proxy",
            status: response.status,
            htmlSize: size,
            isCloudflareChallenge: isCloudflareChallenge,
            videoUrlsCount: videoUrls.length,
            videoUrls: videoUrls.slice(0, 3),
            htmlPreview: html.substring(0, 1000)
          });

        } catch (error) {
          console.error("AllOrigins error:", error.message);
          allAttempts.push({
            attempt: "AllOrigins Proxy",
            error: error.message
          });
        }

        // ATTEMPT 3: Via corsproxy
        console.log(`\n[ATTEMPT 3] Via corsproxy\n`);
        try {
          const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(searchUrl)}`;
          const response = await fetch(proxyUrl);
          const html = await response.text();
          const size = html.length;

          const videoUrls = html.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|mkv|webm)[^\s"'<>]*)/gi) || [];

          allAttempts.push({
            attempt: "CORS Proxy",
            status: response.status,
            htmlSize: size,
            videoUrlsCount: videoUrls.length,
            videoUrls: videoUrls.slice(0, 3)
          });

        } catch (error) {
          allAttempts.push({
            attempt: "CORS Proxy",
            error: error.message
          });
        }

        return jsonResponse({
          success: true,
          title: title,
          message: "DEBUG OUTPUT - Share this with the developer to fix the scraper",
          timestamp: new Date().toISOString(),
          attempts: allAttempts
        });

      } catch (error) {
        console.error("Debug error:", error);
        return jsonResponse({ 
          error: "Debug failed", 
          details: error.message,
          stack: error.stack 
        }, 500);
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

        // Try multiple fetch methods
        let html = null;
        let method = null;

        // Method 1: Direct
        try {
          const res = await fetch(searchUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
              "Referer": "https://moviebox.ph/",
              "Cache-Control": "max-age=0"
            }
          });
          if (res.ok && res.status === 200) {
            html = await res.text();
            method = "Direct";
          }
        } catch (e) {}

        // Method 2: AllOrigins proxy
        if (!html) {
          try {
            const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(searchUrl)}`);
            if (res.ok) {
              html = await res.text();
              method = "AllOrigins";
            }
          } catch (e) {}
        }

        // Method 3: CORS proxy
        if (!html) {
          try {
            const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(searchUrl)}`);
            if (res.ok) {
              html = await res.text();
              method = "CORS Proxy";
            }
          } catch (e) {}
        }

        if (!html) {
          return jsonResponse({
            success: false,
            error: "Cannot fetch Moviebox.ph with any method",
            details: "Moviebox.ph is blocking all access (likely Cloudflare protection)",
            solution: "You need either:\n1. A premium residential proxy (BrightData, Oxylabs, Luminati)\n2. Your own Puppeteer server running browser automation\n3. Access to your friend's API\n4. A working Moviebox mirror/clone",
            debugUrl: `https://${urlObj.host}/api/debug-scrape`
          }, 502);
        }

        // Extract video URLs
        const videoUrls = (html.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|mkv|webm)[^\s"'<>]*)/gi) || [])
          .filter(url => !url.toLowerCase().includes("cdn-cgi"));

        const uniqueUrls = [...new Set(videoUrls)];

        if (uniqueUrls.length === 0) {
          return jsonResponse({
            success: false,
            error: "No video streams found",
            details: `Fetched ${html.length} bytes via ${method}, but no .mp4/.m3u8 URLs found`,
            htmlLength: html.length,
            fetchMethod: method,
            debugUrl: `https://${urlObj.host}/api/debug-scrape?title=${encodeURIComponent(title)}`
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
          fetchMethod: method,
          streams: streams,
          streamCount: streams.length
        });

      } catch (error) {
        console.error("Stream Error:", error);
        return jsonResponse({ 
          error: "Failed to get streams", 
          details: error.message 
        }, 500);
      }
    }

    return jsonResponse({ 
      error: "Route not found",
      routes: {
        "GET /": "UI",
        "POST /api/debug-scrape": "Shows exactly what Moviebox.ph sends back (body: {title})",
        "POST /api/get-stream": "Gets video streams (body: {activeTVShowData})"
      }
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
