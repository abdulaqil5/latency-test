<?php
/**
 * dev-latency-probe.php - Zero-dependency Latency Probe with Silent Connection Dropping
 * Place in public root of dev.abdulaqil.com (e.g., public_html/dev-latency-probe.php)
 * 
 * Security Features:
 *  - DROP_ALL_CONNECTIONS: Master kill-switch to drop 100% of requests
 *  - Silent Drop: Drops unauthorized connections immediately with HTTP 444 (No Response)
 *  - FastCGI Socket Severing: Closes connection at the TCP level with zero response bytes
 */

// =============================================================================
// 1. CONFIGURATION & ACCESS GUARDS
// =============================================================================

// Set to true to immediately DROP ALL incoming connections (Lockdown Mode)
define('DROP_ALL_CONNECTIONS', false);

// Enforce Worker User-Agent
define('REQUIRED_USER_AGENT', 'AA Latency Tester Worker/dev.abdulaqil.com');

// Load DEV_SECRET_KEY strictly from environment / .env (Zero hardcoded secrets)
$existingDevSecret = getenv('DEV_SECRET_KEY') ?: getenv('PROBE_SECRET_KEY') ?: '';
if (empty($existingDevSecret)) {
    $envCandidates = [__DIR__ . '/.env', dirname(__DIR__) . '/.env'];
    foreach ($envCandidates as $ef) {
        if (file_exists($ef) && is_readable($ef)) {
            foreach (file($ef, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $el) {
                if (str_starts_with(trim($el), 'DEV_SECRET_KEY=')) {
                    $p = explode('=', trim($el), 2);
                    $existingDevSecret = trim($p[1] ?? '', " \t\n\r\0\x0B\"'");
                    break 2;
                }
            }
        }
    }
}
define('PROBE_SECRET_KEY', $existingDevSecret);

/**
 * Drop connection silently with zero response body
 */
function drop_connection() {
    // HTTP 444 signals Cloudflare / LiteSpeed / Nginx to close connection immediately
    header('HTTP/1.1 444 No Response');
    header('Status: 444 No Response');
    header('Connection: close');
    header('Content-Length: 0');
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    }
    exit(0);
}

// Check Master Kill-Switch
if (DROP_ALL_CONNECTIONS === true) {
    drop_connection();
}

// 1. Verify Worker User-Agent (Only allow requests from Worker)
$incoming_ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
if ($incoming_ua !== REQUIRED_USER_AGENT) {
    drop_connection();
}

// 2. Verify Secret Authentication Key via Header only (No query string keys)
$incoming_auth = $_SERVER['HTTP_X_AUTH_KEY'] ?? '';
if (empty(PROBE_SECRET_KEY) || empty($incoming_auth) || !hash_equals(PROBE_SECRET_KEY, $incoming_auth)) {
    drop_connection();
}

// =============================================================================
// 2. AUTHORIZED TRAFFIC PROCESSING
// =============================================================================

$start_time = microtime(true);

// Security & CORS Headers for Authorized Worker Requests
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Auth-Key, X-From-Worker, User-Agent');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Enforce allowed HTTP methods (405 Method Not Allowed)
if (!in_array($_SERVER['REQUEST_METHOD'], ['GET', 'POST'], true)) {
    header('Allow: GET, POST, OPTIONS');
    http_response_code(405);
    echo json_encode([
        'status'  => 'error',
        'message' => 'Method Not Allowed'
    ], JSON_PRETTY_PRINT);
    exit;
}

$buffer_dir   = __DIR__ . '/probe-buffer';
$buffer_file  = $buffer_dir . '/latency_buffer.log';
$history_file = $buffer_dir . '/benchmark_history.jsonl';

// Auto-create protected directory
if (!is_dir($buffer_dir)) {
    @mkdir($buffer_dir, 0755, true);
    @file_put_contents($buffer_dir . '/.htaccess', "Require all denied\nDeny from all\n");
}

$action = $_GET['action'] ?? '';

// --- ACTION A: VIEW SAVED TEST RUNS & REPORTS ---
if ($action === 'view' || $action === 'history') {
    $reports = [];
    if (file_exists($history_file)) {
        $lines = file($history_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        foreach ($lines as $line) {
            $decoded = json_decode($line, true);
            if ($decoded) $reports[] = $decoded;
        }
    }

    echo json_encode([
        'total_benchmarks_saved' => count($reports),
        'buffer_file_bytes'      => file_exists($buffer_file) ? filesize($buffer_file) : 0,
        'benchmark_history'      => array_reverse($reports)
    ], JSON_PRETTY_PRINT);
    exit;
}

// --- ACTION B: CLEAR SAVED LOGS ---
if ($action === 'clear') {
    if (file_exists($buffer_file))  @unlink($buffer_file);
    if (file_exists($history_file)) @unlink($history_file);

    echo json_encode([
        'status'  => 'OK',
        'message' => 'All probe buffer files and benchmark history logs have been cleared.'
    ], JSON_PRETTY_PRINT);
    exit;
}

// --- ACTION C: SAVE COMPLETED WORKER BENCHMARK REPORT ---
if ($action === 'save_report' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = file_get_contents('php://input');
    if (!empty($input)) {
        $report_entry = json_encode([
            'saved_at'   => date('Y-m-d H:i:s'),
            'client_ip'  => $_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'] ?? 'UNKNOWN',
            'cf_ray'     => $_SERVER['HTTP_CF_RAY'] ?? 'NO-RAY',
            'report'     => json_decode($input, true)
        ]);
        file_put_contents($history_file, $report_entry . PHP_EOL, FILE_APPEND | LOCK_EX);
    }

    echo json_encode(['status' => 'OK', 'saved' => true]);
    if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
    exit;
}

// --- ACTION D: STANDARD PROBE RUN (mode=queue or mode=ping) ---
$mode = $_GET['mode'] ?? 'queue';
$raw_input = file_get_contents('php://input');
$bytes_received = strlen($raw_input);

$write_ms = 0;

if ($mode === 'queue' || $mode === 'write') {
    $t_disk_start = microtime(true);

    $payload = !empty($raw_input) ? $raw_input : json_encode([
        'shortcode' => 'bench-test',
        'ip'        => $_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1',
        'time'      => time(),
        'source'    => 'worker-probe'
    ]);

    file_put_contents($buffer_file, $payload . PHP_EOL, FILE_APPEND | LOCK_EX);
    $write_ms = round((microtime(true) - $t_disk_start) * 1000, 3);
}

// Calculate Timing
$exec_ms = round((microtime(true) - $start_time) * 1000, 3);

header('X-PHP-Execution-Ms: ' . $exec_ms);
header('X-PHP-Disk-Write-Ms: ' . $write_ms);
header('X-PHP-Memory-Peak: ' . memory_get_peak_usage(true));
header('X-Server-Time: ' . date('Y-m-d H:i:s'));

http_response_code(200);

echo json_encode([
    'status'         => 'OK',
    'mode'           => $mode,
    'php_exec_ms'    => $exec_ms,
    'disk_write_ms'  => $write_ms,
    'bytes_received' => $bytes_received,
    'server_time'    => date('Y-m-d H:i:s'),
    'client_ip'      => $_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'] ?? 'UNKNOWN',
    'cf_colo'        => $_SERVER['HTTP_CF_RAY'] ?? 'NO-RAY',
    'buffer_info'    => [
        'writable'   => is_dir($buffer_dir) && is_writable($buffer_dir),
        'file_size'  => file_exists($buffer_file) ? filesize($buffer_file) : 0
    ]
], JSON_PRETTY_PRINT);

if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
}
