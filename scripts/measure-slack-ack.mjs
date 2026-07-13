import { createHmac, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import "dotenv/config";

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const receiverUrl = process.env.KNOT_PUBLIC_SLACK_URL;
const sampleCount = Number.parseInt(process.env.KNOT_ACK_SAMPLES ?? "100", 10);
const concurrency = Number.parseInt(process.env.KNOT_ACK_CONCURRENCY ?? "5", 10);

if (!signingSecret) {
  throw new Error("SLACK_SIGNING_SECRET is required for the signed acknowledgement probe.");
}
if (!receiverUrl || !/^https:\/\/[^/]+\/slack\/events$/u.test(receiverUrl)) {
  throw new Error("KNOT_PUBLIC_SLACK_URL must be an HTTPS /slack/events URL.");
}
if (!Number.isSafeInteger(sampleCount) || sampleCount < 20 || sampleCount > 500) {
  throw new Error("KNOT_ACK_SAMPLES must be an integer from 20 through 500.");
}
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 20) {
  throw new Error("KNOT_ACK_CONCURRENCY must be an integer from 1 through 20.");
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function signedHeaders(timestamp, body, secret = signingSecret) {
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", secret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`,
  };
}

function probeBody(timestamp, nonce) {
  const payload = {
    type: "block_actions",
    team: { id: "TACKPROBE1", domain: "knot-ack-probe" },
    user: { id: "UACKPROBE1", username: "ack-probe", team_id: "TACKPROBE1" },
    api_app_id: "AACKPROBE1",
    trigger_id: `${nonce}.${randomUUID()}`,
    container: {
      type: "message",
      message_ts: `${timestamp}.000001`,
      channel_id: "DACKPROBE1",
      is_ephemeral: false,
    },
    channel: { id: "DACKPROBE1", name: "directmessage" },
    actions: [
      {
        action_id: "knot_outcome_check_v1",
        block_id: "knot_ack_probe_v1",
        type: "button",
        value: randomUUID(),
        action_ts: `${timestamp}.000001`,
      },
    ],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

async function expectRejected(name, timestamp, body, headers) {
  const response = await fetch(receiverUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
  if (response.status !== 401) {
    throw new Error(`${name} security probe returned HTTP ${response.status}; expected 401.`);
  }
  return { name, status: response.status, passed: true, timestamp };
}

async function verifyIngressSecurity() {
  const currentTimestamp = Math.floor(Date.now() / 1000).toString();
  const currentBody = probeBody(currentTimestamp, "unsigned");
  const staleTimestamp = String(Number(currentTimestamp) - 10 * 60);
  const staleBody = probeBody(staleTimestamp, "stale");
  return Promise.all([
    expectRejected("unsigned-request", currentTimestamp, currentBody, {}),
    expectRejected("forged-signature", currentTimestamp, currentBody, {
      "x-slack-request-timestamp": currentTimestamp,
      "x-slack-signature": "v0=0000000000000000000000000000000000000000000000000000000000000000",
    }),
    expectRejected(
      "stale-replay",
      staleTimestamp,
      staleBody,
      signedHeaders(staleTimestamp, staleBody),
    ),
  ]);
}

async function probe(index) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = probeBody(timestamp, String(index));
  const startedAt = performance.now();
  const response = await fetch(receiverUrl, {
    method: "POST",
    headers: signedHeaders(timestamp, body),
    body,
  });
  const elapsedMs = performance.now() - startedAt;
  if (response.status !== 200) {
    throw new Error(`Signed acknowledgement probe returned HTTP ${response.status}.`);
  }
  return elapsedMs;
}

const securityChecks = await verifyIngressSecurity();
const durations = [];
for (let offset = 0; offset < sampleCount; offset += concurrency) {
  const batchSize = Math.min(concurrency, sampleCount - offset);
  durations.push(
    ...(await Promise.all(Array.from({ length: batchSize }, (_, index) => probe(offset + index)))),
  );
}

durations.sort((left, right) => left - right);
const p50 = percentile(durations, 0.5);
const p95 = percentile(durations, 0.95);
const p99 = percentile(durations, 0.99);
const maximum = durations.at(-1);

console.log(
  JSON.stringify({
    probe: "signed-cross-workspace-rejection",
    samples: sampleCount,
    concurrency,
    p50Ms: Number(p50.toFixed(1)),
    p95Ms: Number(p95.toFixed(1)),
    p99Ms: Number(p99.toFixed(1)),
    maxMs: Number(maximum.toFixed(1)),
    securityChecks: securityChecks.map(({ name, status, passed }) => ({ name, status, passed })),
    note: "This measures the public signed-ingress acknowledgement path without creating domain state; the live state-changing flow remains mandatory.",
  }),
);

if (p95 >= 500 || p99 >= 1000 || maximum >= 3000) {
  process.exitCode = 1;
}
