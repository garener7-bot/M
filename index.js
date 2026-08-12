import HTML_CONTENT from "./index.html";

// ==========================================
// DEBUG MODE - EXTRACT RAW MOVIEBOX.PH JSON
// ==========================================
// This will show you EXACTLY what Moviebox is sending

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

    // 3. ROUTE: /api/proxy -> Video Stream Proxy
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

    // 4. NEW DEBUG ROUTE: /api/debug-scrape -> Show raw HTML and JSON
    if (pathname === "/api/debug-scrape" && request.method === "POST") {
      try {
        const body = await request.json();
        const { title } = body;

        if (!title) {
          return jsonResponse({ success: false, error: "Movie title is required" }, 400);
        }

        console.log(`\n========== DEBUGGING MOVIEBOX SCRAPE FOR: ${title} ==========\n`);

        const searchUrl = `https://moviebox.ph/search?q=${encodeURIComponent(title)}`;
        console.log(`[1] Fetching URL: ${searchUrl}`);

        // Try multiple ways to fetch
        const attempts = [
          {
            name: "Direct fetch",
            url: searchUrl,
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
              "Referer": "https://moviebox.ph/",
              "Cache-Control": "no-cache",
              "Pragma": "no-cache"
            }
          },
          {
            name: "With proxy (allorigins)",
            url: `https://api.allorigins.win/raw?url=${encodeURIComponent(searchUrl)}`,
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
          },
          {
            name: "With proxy (corsproxy)",
            url: `https://corsproxy.io/?${encodeURIComponent(searchUrl)}`,
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
          }
        ];

        const results = [];

        for (const attempt of attempts) {
          console.log(`\n[Attempt] ${attempt.name}`);
          console.log(`URL: ${attempt.url}`);

          try {
            const response = await fetch(attempt.url, {
              headers: attempt.headers,
              timeout: 15000
            });

            console.log(`Status: ${response.status}`);
            console.log(`Content-Type: ${response.headers.get("content-type")}`);

            const html = await response.text();
            const htmlSize = html.length;
            console.log(`HTML Size: ${htmlSize} bytes`);

            // Check for Cloudflare challenge
            const hasChallenge = html.includes("challenge") || html.includes("cf_clearance");
            console.log(`Cloudflare Challenge: ${hasChallenge ? "YES (blocked)" : "NO"}`);

            // Extract all script tags
            const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
            const scripts = html.match(scriptRegex) || [];
            console.log(`Found ${scripts.length} script tags`);

            // Try to find ALL JSON-like content
            const jsonRegex = /\{[\s\S]*?\}/g;
            const jsonMatches = html.match(jsonRegex) || [];
            console.log(`Found ${jsonMatches.length} potential JSON objects`);

            // Extract specific patterns
            const patterns = {
              "NUXT_DATA": /<script id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
              "window.__NUXT__": /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/i,
              "data-nuxt-data": /<script type="application\/json" data-nuxt-data>([\s\S]*?)<\/script>/i,
              "__NUXT_JSON__": /<script id="__NUXT_JSON__"[^>]*>([\s\S]*?)<\/script>/i,
              "state.data": /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/i,
            };

            const foundPatterns = {};
            for (const [name, regex] of Object.entries(patterns)) {
              const match = html.match(regex);
              if (match && match[1]) {
                console.log(`✓ Found pattern: ${name}`);
                foundPatterns[name] = match[1].substring(0, 500); // First 500 chars
              }
            }

            // Try to parse first valid JSON found
            let parsedJson = null;
            if (jsonMatches.length > 0) {
              for (let i = 0; i < Math.min(5, jsonMatches.length); i++) {
                try {
                  parsedJson = JSON.parse(jsonMatches[i]);
                  console.log(`✓ Successfully parsed JSON #${i + 1}`);
                  break;
                } catch (e) {
                  // Skip invalid JSON
                }
              }
            }

            // Extract video URLs from HTML
            const urlRegex = /(https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8|mkv|webm)[^\s"'<>\\]*)/gi;
            const foundUrls = html.match(urlRegex) || [];
            const uniqueUrls = [...new Set(foundUrls)];
            console.log(`Found ${uniqueUrls.length} video URLs`);
            if (uniqueUrls.length > 0) {
              uniqueUrls.slice(0, 5).forEach((url, i) => {
                console.log(`  URL ${i + 1}: ${url.substring(0, 100)}...`);
              });
            }

            results.push({
              success: true,
              attempt: attempt.name,
              htmlSize: htmlSize,
              hasChallenge: hasChallenge,
              scriptCount: scripts.length,
              jsonObjectsFound: jsonMatches.length,
              patterns: foundPatterns,
              videoUrlsFound: uniqueUrls.length,
              videoUrls: uniqueUrls.slice(0, 10),
              parsedJsonSample: parsedJson ? JSON.stringify(parsedJson).substring(0, 1000) : null,
              htmlPreview: html.substring(0, 2000)
            });

            // If this attempt succeeded, stop trying others
            if (!hasChallenge && htmlSize > 10000 && Object.keys(foundPatterns).length > 0) {
              console.log(`\n✓ SUCCESS with ${attempt.name}!`);
              break;
            }

          } catch (error) {
            console.error(`✗ Failed: ${error.message}`);
            results.push({
              success: false,
              attempt: attempt.name,
              error: error.message
            });
          }
        }

        console.log(`\n========== DEBUG COMPLETE ==========\n`);

        return jsonResponse({
          success: true,
          title: title,
          timestamp: new Date().toISOString(),
          debugResults: results,
          recommendations: generateRecommendations(results)
        });

      } catch (error) {
        console.error("Debug Error:", error);
        return jsonResponse({ 
          error: "Debug failed", 
          details: error.message,
          stack: error.stack
        }, 500);
      }
    }

    // 5. ROUTE: /api/get-stream -> Use the debug data to get streams
    if (pathname === "/api/get-stream" && request.method === "POST") {
      try {
        const body = await request.json();
        const { activeTVShowData, currentMediaType } = body;

        const title = activeTVShowData?.title || activeTVShowData?.original_title || "";
        const tmdbId = activeTVShowData?.id || null;

        if (!title) {
          return jsonResponse({ success: false, error: "Movie title is required" }, 400);
        }

        const searchUrl = `https://moviebox.ph/search?q=${encodeURIComponent(title)}`;

        // Try to fetch with different methods
        let html = null;
        let usedMethod = null;

        // Method 1: Direct
        try {
          const res = await fetch(searchUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              "Referer": "https://moviebox.ph/"
            }
          });
          if (res.ok) {
            html = await res.text();
            usedMethod = "Direct";
          }
        } catch (e) {
          console.log("Direct fetch failed, trying proxy...");
        }

        // Method 2: AllOrigins proxy
        if (!html) {
          try {
            const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(searchUrl)}`);
            if (res.ok) {
              html = await res.text();
              usedMethod = "AllOrigins Proxy";
            }
          } catch (e) {
            console.log("AllOrigins proxy failed, trying corsproxy...");
          }
        }

        // Method 3: CORS Proxy
        if (!html) {
          try {
            const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(searchUrl)}`);
            if (res.ok) {
              html = await res.text();
              usedMethod = "CORS Proxy";
            }
          } catch (e) {
            console.log("CORS proxy failed");
          }
        }

        if (!html) {
          return jsonResponse({
            success: false,
            error: "Could not fetch Moviebox.ph HTML",
            suggestion: "Use /api/debug-scrape to see what's happening"
          }, 502);
        }

        // Extract video URLs
        const urlRegex = /(https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8|mkv|webm)[^\s"'<>\\]*)/gi;
        const foundUrls = (html.match(urlRegex) || [])
          .filter(url => !url.toLowerCase().includes("cdn-cgi"));

        const uniqueUrls = [...new Set(foundUrls)];

        if (uniqueUrls.length === 0) {
          return jsonResponse({
            success: false,
            error: "No streams found",
            suggestion: "Run /api/debug-scrape to inspect the HTML content",
            details: `Fetched ${html.length} bytes of HTML from ${usedMethod}`
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
          fetchMethod: usedMethod,
          streams: streams,
          streamCount: streams.length
        });

      } catch (error) {
        console.error("Stream API Error:", error);
        return jsonResponse({ 
          error: "Failed to resolve stream", 
          details: error.message
        }, 500);
      }
    }

    return jsonResponse({ error: "Route not found. Try /api/debug-scrape or /api/get-stream" }, 404);
  },
};

/**
 * Generate recommendations based on debug results
 */
function generateRecommendations(results) {
  const recommendations = [];

  const successResult = results.find(r => r.success && !r.hasChallenge);
  
  if (successResult) {
    recommendations.push({
      level: "SUCCESS",
      message: `Use ${successResult.attempt} method - it works!`,
      details: `Found ${successResult.videoUrlsFound} video URLs and ${Object.keys(successResult.patterns).length} JSON patterns`
    });
  } else {
    const hasChallenge = results.some(r => r.hasChallenge);
    if (hasChallenge) {
      recommendations.push({
        level: "ERROR",
        message: "Cloudflare is blocking all access",
        solutions: [
          "1. Use a premium residential proxy (BrightData, Oxylabs)",
          "2. Setup your own Puppeteer server to render JavaScript",
          "3. Try requesting with different User-Agent headers",
          "4. Contact your friend to allow your IP"
        ]
      });
    }

    const hasSmallHtml = results.some(r => r.htmlSize < 10000);
    if (hasSmallHtml) {
      recommendations.push({
        level: "WARNING",
        message: "Received very small HTML - likely Cloudflare challenge page",
        action: "Need to bypass Cloudflare with residential proxy or browser automation"
      });
    }
  }

  return recommendations;
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
