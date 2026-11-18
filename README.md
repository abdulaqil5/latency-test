# Cloudflare Worker to Origin Latency Benchmark & Probe

A lightweight, zero-dependency latency benchmark suite designed to measure end-to-end round-trip latency, network transit time, TCP/TLS handshake overhead, and origin server PHP/disk execution times between a **Cloudflare Edge Worker** and an **Origin Server**.

---

## 🚀 Architecture

```
[Client / Browser]
       │
       ▼  GET https://dev.abdulaqil.com/latency-test?runs=5&mode=queue
[Cloudflare Edge Worker]
       │
       ├─► Sequential POST subrequests to origin probe
       │   - Cold connection (TCP + TLS handshake + First request)
       │   - Warm connections (HTTP Keep-Alive socket reuse)
       │
       ▼
[Origin Server (dev-latency-probe.php)]
       │
       ├─► 1. Verifies exact Worker User-Agent & Secret Auth Header
       ├─► 2. Measures PHP execution time (`microtime`)
       ├─► 3. Measures disk write time (optional queue mode)
       ├─► 4. Returns timing headers (`X-PHP-Execution-Ms`, `X-PHP-Disk-Write-Ms`)
       ▼
[Cloudflare Worker Output]
       │
       ├─► Asynchronously saves full report to `benchmark_history.jsonl` (via `ctx.waitUntil`)
       └─► Returns concise status response to the client
```

---

## 📁 Repository Structure

```
├── dev-latency-probe.php            # Zero-dependency PHP probe script (place on origin)
├── worker-latency-benchmark.js      # Source Cloudflare Worker
├── worker-latency-benchmark.min.js  # Minified Cloudflare Worker (production ready, < 4.5 KB)
├── wrangler.jsonc                   # Wrangler configuration with explicit Smart Placement
├── .env.example                     # Environment variable template
└── .gitignore                       # Protects secrets, buffer logs, and node modules
```

---

## 🔒 Security Features

* **Zero Hardcoded Secrets**: Secrets are loaded strictly from Cloudflare Worker Environment Secrets (`env.DEV_SECRET_KEY`) and origin `.env` or system environment variables.
* **Silent Drop (HTTP 444)**: Unauthorized requests (missing/invalid secret key or invalid User-Agent) are immediately severed at the FastCGI socket level with 0 response bytes.
* **Master Kill-Switch**: Setting `define('DROP_ALL_CONNECTIONS', true);` in `dev-latency-probe.php` silently drops 100% of incoming connections.
* **Strict Host Restriction**: The Worker only processes requests targeting the configured domain.

---

## ⚙️ Setup Instructions

### 1. Origin Server Setup (PHP)
1. Copy [`dev-latency-probe.php`](dev-latency-probe.php) to your origin web root (e.g. `public_html/dev-latency-probe.php`).
2. Set your secret key in your origin `.env` file (or set as a system environment variable):
   ```bash
   DEV_SECRET_KEY=your-strong-secret-key-here
   ```
3. Make sure the PHP script has write permissions to create the `probe-buffer/` folder.

### 2. Cloudflare Worker Setup
1. Deploy `worker-latency-benchmark.js` (or `worker-latency-benchmark.min.js`) to Cloudflare Workers.
2. Bind the Worker route to your custom domain:
   ```
   dev.abdulaqil.com/latency-test*
   ```
3. Add your secret key as an encrypted environment variable in the Cloudflare Dashboard (or via Wrangler):
   ```bash
   wrangler secret put DEV_SECRET_KEY
   ```
4. Update `wrangler.jsonc` with your target hostname for placement optimization.

---

## 📊 Endpoints & Usage

| Action | URL | Description |
| :--- | :--- | :--- |
| **Run Benchmark** | `GET /latency-test?runs=5&mode=queue` | Runs 5 sequential POST probes and logs metrics |
| **Ping Only (No Disk)** | `GET /latency-test?runs=5&mode=ping` | Measures pure network and PHP execution without disk I/O |
| **View Saved History** | `GET /latency-test?view=1` | Views historical benchmark reports from origin |
| **Clear Buffer Logs** | `GET /latency-test?clear=1` | Clears origin buffer logs and history |

---

## 📄 License
MIT License.
