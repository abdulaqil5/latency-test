/**
 * worker-latency-benchmark.js - Low-CPU Cloudflare Worker Latency Probe & Reporter
 * 
 * Route: dev.abdulaqil.com/latency-test*
 * Domain: strictly dev.abdulaqil.com
 * Secret: environment secret only (no hardcoded keys)
 * Behavior:
 *   - Client receives simple, clean confirmation JSON
 *   - Origin receives full benchmark report in background via ctx.waitUntil()
 *   - benchmark_history.jsonl is preserved for your reporting API
 */

const TARGET_HOST = 'dev.abdulaqil.com';
const PROBE_URL = `https://${TARGET_HOST}/dev-latency-probe.php`;

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate'
});

// Fast native 2-decimal rounding with zero string allocation
const round2 = (num) => Math.round(num * 100) / 100;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Host Guard
    if (url.hostname !== TARGET_HOST) {
      return new Response('Forbidden: Host not allowed', { status: 403 });
    }

    // 2. Prevent recursion loops
    if (request.headers.get('x-from-worker') === '1') {
      return fetch(request);
    }

    // 3. Strict Environment Secret Check
    const secretKey = env.DEV_SECRET_KEY || env.PROBE_SECRET_KEY;
    if (!secretKey) {
      return new Response(
        '{"status":"error","message":"Configuration error: DEV_SECRET_KEY or PROBE_SECRET_KEY environment secret is required."}',
        { status: 500, headers: JSON_HEADERS }
      );
    }

    const subHeaders = {
      'content-type': 'application/json',
      'user-agent': 'AA Latency Tester Worker/dev.abdulaqil.com',
      'x-auth-key': secretKey,
      'x-from-worker': '1'
    };

    // 4. View Saved Origin Logs (?view=1) - Reads benchmark_history.jsonl
    if (url.searchParams.has('view') || url.searchParams.has('history')) {
      const historyRes = await fetch(`${PROBE_URL}?action=view`, { headers: subHeaders });
      if (!historyRes.ok) {
        return new Response(JSON.stringify({
          status: 'error',
          httpStatus: historyRes.status,
          message: 'Origin dropped connection: Endpoint is in Lockdown Mode or unauthorized.'
        }), { status: historyRes.status, headers: JSON_HEADERS });
      }
      return new Response(historyRes.body, { status: historyRes.status, headers: JSON_HEADERS });
    }

    // 5. Clear Saved Origin Logs (?clear=1)
    if (url.searchParams.has('clear')) {
      const clearRes = await fetch(`${PROBE_URL}?action=clear`, { headers: subHeaders });
      if (!clearRes.ok) {
        return new Response(JSON.stringify({
          status: 'error',
          httpStatus: clearRes.status,
          message: 'Origin dropped connection: Endpoint is in Lockdown Mode or unauthorized.'
        }), { status: clearRes.status, headers: JSON_HEADERS });
      }
      return new Response(clearRes.body, { status: clearRes.status, headers: JSON_HEADERS });
    }

    // 6. Benchmark Probe Runs
    const runsParam = url.searchParams.get('runs');
    const runs = runsParam ? Math.min(Math.max(parseInt(runsParam, 10) || 5, 1), 10) : 5;
    const mode = url.searchParams.get('mode') === 'ping' ? 'ping' : 'queue';
    const shouldSave = url.searchParams.get('save') !== '0';
    const targetUrl = `${PROBE_URL}?mode=${mode}`;

    const edgeColo = request.cf?.colo || 'UNKNOWN';
    const edgeCountry = request.cf?.country || 'XX';
    const clientIp = request.headers.get('cf-connecting-ip') || '127.0.0.1';
    const nowSec = Math.trunc(Date.now() / 1000);
    const payloadSuffix = `,"shortcode":"latency-test-code","timestamp":${nowSec},"clientIp":"${clientIp}","colo":"${edgeColo}","country":"${edgeCountry}","message":"Synthetic click benchmark"}`;

    const results = new Array(runs);

    for (let i = 1; i <= runs; i++) {
      const payload = `{"iteration":${i}` + payloadSuffix;
      const tStart = performance.now();

      let httpStatus = 0;
      let phpExecMs = null;
      let diskWriteMs = null;
      let errorMessage = null;
      let isSuccess = false;

      try {
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: subHeaders,
          body: payload,
          signal: AbortSignal.timeout(5000)
        });

        httpStatus = res.status;
        isSuccess = res.ok;

        if (!isSuccess) {
          if (httpStatus === 444 || httpStatus === 520) {
            errorMessage = 'Origin dropped connection: Endpoint is in Lockdown Mode or unauthorized';
          } else {
            const text = await res.text();
            errorMessage = text.slice(0, 200) || `HTTP Error ${httpStatus}`;
          }
          await res.body?.cancel();
        } else {
          const phpHdr = res.headers.get('x-php-execution-ms');
          const diskHdr = res.headers.get('x-php-disk-write-ms');

          if (phpHdr !== null) {
            phpExecMs = Number(phpHdr);
            diskWriteMs = diskHdr !== null ? Number(diskHdr) : null;
            await res.arrayBuffer();
          } else {
            const parsed = await res.json().catch(() => null);
            if (parsed) {
              phpExecMs = typeof parsed.php_exec_ms === 'number' ? parsed.php_exec_ms : null;
              diskWriteMs = typeof parsed.disk_write_ms === 'number' ? parsed.disk_write_ms : null;
            }
          }
        }
      } catch (err) {
        errorMessage = err.name === 'TimeoutError' ? 'Subrequest Timed Out (> 5000ms)' : err.message;
      }

      const totalWallTime = round2(performance.now() - tStart);
      const networkTransitMs = phpExecMs !== null ? round2(Math.max(0, totalWallTime - phpExecMs)) : null;

      results[i - 1] = {
        run: i,
        connectionState: i === 1 ? 'Cold (TCP/TLS Handshake + First Request)' : 'Warm (HTTP Keep-Alive / Reused Socket)',
        httpStatus,
        success: isSuccess,
        workerWallTimeMs: totalWallTime,
        originPhpExecMs: phpExecMs,
        originDiskWriteMs: diskWriteMs,
        networkTransitAndTlsMs: networkTransitMs,
        error: errorMessage
      };
    }

    // 7. Single-Pass Metric Calculation
    let successCount = 0;
    let wallSum = 0, wallMin = Infinity, wallMax = 0;
    let phpSum = 0, phpCount = 0, phpMin = Infinity, phpMax = 0;
    let netSum = 0, netCount = 0, netMin = Infinity, netMax = 0;

    for (let j = 0; j < runs; j++) {
      const r = results[j];
      if (!r.success) continue;

      successCount++;
      const w = r.workerWallTimeMs;
      wallSum += w;
      if (w < wallMin) wallMin = w;
      if (w > wallMax) wallMax = w;

      const p = r.originPhpExecMs;
      if (p !== null) {
        phpCount++;
        phpSum += p;
        if (p < phpMin) phpMin = p;
        if (p > phpMax) phpMax = p;
      }

      const n = r.networkTransitAndTlsMs;
      if (n !== null) {
        netCount++;
        netSum += n;
        if (n < netMin) netMin = n;
        if (n > netMax) netMax = n;
      }
    }

    const avgWall = successCount > 0 ? round2(wallSum / successCount) : 0;
    const avgPhp = phpCount > 0 ? round2(phpSum / phpCount) : 0;
    const avgNet = netCount > 0 ? round2(netSum / netCount) : 0;

    const summary = {
      totalRuns: runs,
      successfulRuns: successCount,
      edgeColo,
      edgeCountry,
      workerWallTime: {
        avgMs: avgWall,
        minMs: wallMin === Infinity ? 0 : wallMin,
        maxMs: wallMax
      },
      originPhpExecution: {
        avgMs: avgPhp,
        minMs: phpMin === Infinity ? 0 : phpMin,
        maxMs: phpMax
      },
      networkTransitAndTls: {
        avgMs: avgNet,
        minMs: netMin === Infinity ? 0 : netMin,
        maxMs: netMax
      },
      verdict: successCount === 0
        ? 'FAILED: All origin subrequests failed or were dropped by origin lockdown.'
        : avgWall < 500
        ? 'EXCELLENT: Origin response is fast (< 500ms). Safe for asynchronous ctx.waitUntil() logging.'
        : avgWall < 2000
        ? 'ACCEPTABLE: Latency is within normal shared hosting bounds (< 2000ms).'
        : 'WARNING: Origin subrequest exceeds 2000ms. Check PHP cold-starts or network route.'
    };

    const finalReport = {
      timestamp: new Date().toISOString(),
      summary,
      runs: results
    };

    // 8. ASYNC BACKGROUND SAVE to benchmark_history.jsonl
    // Saves the complete report on origin disk for your reporting API
    if (shouldSave && successCount > 0) {
      ctx.waitUntil(
        fetch(`${PROBE_URL}?action=save_report`, {
          method: 'POST',
          headers: subHeaders,
          body: JSON.stringify(finalReport)
        }).catch(() => {})
      );
    }

    // 9. CLEAN, CONCISE CLIENT RESPONSE (No metadata payload)
    const isSuccess = successCount === runs;
    const lastStatus = results[results.length - 1]?.httpStatus || 0;

    const responsePayload = JSON.stringify({
      status: isSuccess ? 'ok' : 'failed',
      sent: isSuccess,
      requestedRuns: runs,
      deliveredRuns: successCount,
      originHttpStatus: lastStatus,
      message: isSuccess
        ? 'Probe successfully delivered.'
        : (lastStatus === 444 || lastStatus === 520)
        ? 'Origin dropped connection: Endpoint is in Lockdown Mode or unauthorized.'
        : 'Origin failed to process probe.'
    });

    return new Response(responsePayload, { headers: JSON_HEADERS });
  }
};
