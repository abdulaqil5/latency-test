# latency-test

Personal project to measure latency between my Cloudflare Worker and my origin server (`dev.abdulaqil.com`).

Built to profile:
- Cold vs warm subrequest latency (TCP/TLS handshake vs HTTP Keep-Alive).
- Pure network transit time vs origin PHP execution and disk write times.
- Edge colo routing behavior (testing placement options closer to my Malaysia origin).

---

## What's in here

- `worker-latency-benchmark.js`: Cloudflare Worker that fires sequential POST probes to my origin and logs reports in the background.
- `worker-latency-benchmark.min.js`: Minified version of the worker (< 4.5 KB) for low CPU execution.
- `dev-latency-probe.php`: PHP script on my origin server that verifies the worker request, executes the probe, and logs execution timing.
- `wrangler.jsonc`: Wrangler config with hostname placement targeting the origin.

---

## How I use it

### 1. Run Benchmark
```http
GET https://dev.abdulaqil.com/latency-test?runs=5&mode=queue
```
- Sends 5 sequential POST requests from the worker to the PHP probe.
- Returns a quick status response to the client.
- Asynchronously saves the full report on origin (`probe-buffer/benchmark_history.jsonl`).

### 2. View Origin History
```http
GET https://dev.abdulaqil.com/latency-test?view=1
```

### 3. Clear Logs
```http
GET https://dev.abdulaqil.com/latency-test?clear=1
```

---

## Security notes for my setup

- Worker authentication requires `DEV_SECRET_KEY` set as an environment variable (no hardcoded keys).
- The PHP probe drops unauthorized requests silently at the socket level (`HTTP 444 No Response`).
- Master kill-switch (`DROP_ALL_CONNECTIONS = true` in PHP) severs all incoming connections immediately when enabled.
