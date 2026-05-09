// Connect to dev-kaiad-1's Node inspector at :9229 and (a) sample
// process.memoryUsage() / GC stats periodically, and (b) take heap
// snapshots on demand. Output path conventions:
//   /tmp/kaiad-mem-samples.tsv      one row per sample
//   /tmp/kaiad-heap-<label>.heapsnapshot   raw V8 snapshot
//
// Usage:
//   node heap-snap.mjs sample            run sampler until SIGINT
//   node heap-snap.mjs snapshot <label>  take one snapshot, write file
//   node heap-snap.mjs both <durSec> <intervalSec>
//                                        sample for duration; snapshot at
//                                        start, mid, and end
import http from "node:http";
import fs from "node:fs";
import WebSocket from "/home/firestar/kaiad/node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs";

const HOST = "127.0.0.1";
const PORT = 9229;
const SAMPLES_PATH = "/tmp/kaiad-mem-samples.tsv";

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: HOST, port: PORT, path }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function getInspectorUrl() {
  const list = await getJson("/json/list");
  if (!Array.isArray(list) || !list.length) throw new Error("No inspector targets");
  return list[0].webSocketDebuggerUrl;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        this.handlers.get(msg.method)(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    this.handlers.set(method, fn);
  }
}

async function evaluateInTarget(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  }
  return r.result.value;
}

async function memoryUsage(cdp) {
  return evaluateInTarget(
    cdp,
    `(() => {
       const m = process.memoryUsage();
       const rss = m.rss, ht = m.heapTotal, hu = m.heapUsed, ext = m.external, ab = m.arrayBuffers ?? 0;
       return { rss, ht, hu, ext, ab, t: Date.now(), uptime: Math.round(process.uptime()) };
     })()`
  );
}

async function takeHeapSnapshot(cdp, label) {
  await cdp.send("HeapProfiler.enable");
  const out = fs.createWriteStream(`/tmp/kaiad-heap-${label}.heapsnapshot`);
  let totalChunks = 0;
  cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => {
    out.write(chunk);
    totalChunks++;
  });
  console.log(`[heap-snap] taking snapshot label=${label} ...`);
  const t0 = Date.now();
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false });
  out.end();
  console.log(
    `[heap-snap] snapshot label=${label} chunks=${totalChunks} elapsed=${Date.now() - t0}ms file=/tmp/kaiad-heap-${label}.heapsnapshot`
  );
}

async function main() {
  const mode = process.argv[2] ?? "both";
  const wsUrl = await getInspectorUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  const cdp = new CDP(ws);
  await cdp.send("Runtime.enable");

  if (mode === "snapshot") {
    const label = process.argv[3] ?? "manual";
    await takeHeapSnapshot(cdp, label);
    ws.close();
    return;
  }

  if (mode === "sample") {
    fs.writeFileSync(SAMPLES_PATH, "ts\tuptime_s\trss_mb\theap_total_mb\theap_used_mb\texternal_mb\tarraybuffers_mb\n");
    console.log(`[heap-snap] sampling every 2s → ${SAMPLES_PATH} (Ctrl+C to stop)`);
    const tick = async () => {
      try {
        const m = await memoryUsage(cdp);
        const row = [
          new Date(m.t).toISOString(),
          m.uptime,
          (m.rss / 1048576).toFixed(2),
          (m.ht / 1048576).toFixed(2),
          (m.hu / 1048576).toFixed(2),
          (m.ext / 1048576).toFixed(2),
          (m.ab / 1048576).toFixed(2)
        ].join("\t");
        fs.appendFileSync(SAMPLES_PATH, row + "\n");
        process.stdout.write(`\r${row}`);
      } catch (err) {
        console.error("\n[sample] err:", err.message);
      }
    };
    await tick();
    setInterval(tick, 2000);
    return;
  }

  // both: sample continuously and snapshot at evenly-spaced times.
  // Args: <durSec> <intervalSec> [snapTimesCsv]
  // Default snap times: 0, 60, 120, 240, durSec
  const durSec = Number(process.argv[3] ?? 300);
  const intervalSec = Number(process.argv[4] ?? 2);
  const snapTimes = (process.argv[5] ?? `0,60,120,240,${durSec}`)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  fs.writeFileSync(SAMPLES_PATH, "ts\tuptime_s\trss_mb\theap_total_mb\theap_used_mb\texternal_mb\tarraybuffers_mb\n");
  console.log(
    `[heap-snap] sampling for ${durSec}s every ${intervalSec}s; snapshots at t=${snapTimes.join(",")}s`
  );

  const startMs = Date.now();
  const samples = [];
  const snapDone = new Set();

  while (Date.now() - startMs < durSec * 1000) {
    const elapsed = Math.floor((Date.now() - startMs) / 1000);
    // Take any snapshot whose scheduled time we've reached.
    for (const t of snapTimes) {
      if (!snapDone.has(t) && elapsed >= t) {
        snapDone.add(t);
        process.stdout.write("\n");
        await takeHeapSnapshot(cdp, `t${t}`);
      }
    }
    const m = await memoryUsage(cdp);
    samples.push(m);
    const row = [
      new Date(m.t).toISOString(),
      m.uptime,
      (m.rss / 1048576).toFixed(2),
      (m.ht / 1048576).toFixed(2),
      (m.hu / 1048576).toFixed(2),
      (m.ext / 1048576).toFixed(2),
      (m.ab / 1048576).toFixed(2)
    ].join("\t");
    fs.appendFileSync(SAMPLES_PATH, row + "\n");
    process.stdout.write(`\r${row}     `);
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
  process.stdout.write("\n");
  // Final snapshot at exact durSec, in case loop exited just before.
  if (!snapDone.has(durSec)) await takeHeapSnapshot(cdp, `t${durSec}`);
  ws.close();

  // Quick CLI summary.
  const peak = samples.reduce((a, b) => (a.rss > b.rss ? a : b));
  const start = samples[0];
  const end = samples[samples.length - 1];
  console.log("\n[summary]");
  console.log(`  start  rss=${(start.rss / 1048576).toFixed(1)} MiB heap=${(start.hu / 1048576).toFixed(1)} MiB ext=${(start.ext / 1048576).toFixed(1)} MiB ab=${(start.ab / 1048576).toFixed(1)} MiB`);
  console.log(`  peak   rss=${(peak.rss / 1048576).toFixed(1)} MiB heap=${(peak.hu / 1048576).toFixed(1)} MiB ext=${(peak.ext / 1048576).toFixed(1)} MiB ab=${(peak.ab / 1048576).toFixed(1)} MiB at uptime=${peak.uptime}s`);
  console.log(`  end    rss=${(end.rss / 1048576).toFixed(1)} MiB heap=${(end.hu / 1048576).toFixed(1)} MiB ext=${(end.ext / 1048576).toFixed(1)} MiB ab=${(end.ab / 1048576).toFixed(1)} MiB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
