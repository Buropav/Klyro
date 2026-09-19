import http from 'k6/http';
import { check, group, sleep } from 'k6';

const BASE_URL = __ENV.TARGET_URL;
if (!BASE_URL) {
  throw new Error('TARGET_URL environment variable is required (e.g. http://<app-host>:3000)');
}

// Fixed ~90s load profile:
//   - 20s warmup: ramp 0->15 VUs over 5s, hold 15 VUs for 15s. Primes DB
//     connections and Node's JIT. Tagged phase=warmup.
//   - 70s measurement: constant 15 VUs. Tagged phase=measurement.
//
// 15 concurrent VUs hitting /orders?pageSize=50 (51 db_queries per request
// via the seeded N+1 — see demo-app/src/routes/orders.js) against the
// app's 10-connection pg pool is enough to queue visibly and blow out p95
// latency there, while /products (2 queries per request) stays flat —
// giving a clear before/after contrast. The sync-flush logger bug doesn't
// show up in HTTP-level metrics at all; this profile just needs to push
// enough request volume that its flush_ops/CPU cost is visible in the EMF
// metrics a later stage reads from CloudWatch.
//
// Referencing "{phase:measurement}" submetrics in thresholds is what makes
// k6 compute and export them as distinct entries in the summary JSON —
// that's how the 20s warmup gets excluded from measurement without a
// custom handleSummary() (run-and-upload.sh controls the export via
// --summary-export instead).
export const options = {
  scenarios: {
    warmup: {
      executor: 'ramping-vus',
      exec: 'mainScenario',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 15 },
        { duration: '15s', target: 15 },
      ],
      gracefulStop: '0s',
      tags: { phase: 'warmup' },
    },
    measurement: {
      executor: 'constant-vus',
      exec: 'mainScenario',
      vus: 15,
      duration: '70s',
      startTime: '20s',
      gracefulStop: '5s',
      tags: { phase: 'measurement' },
    },
  },
  thresholds: {
    'http_req_duration{phase:measurement}': ['p(95)<60000'],
    'http_req_failed{phase:measurement}': ['rate<1.0'],
    'http_reqs{phase:measurement}': ['count>0'],
    'http_req_duration{phase:measurement,endpoint:orders}': ['p(95)<60000'],
    'http_req_duration{phase:measurement,endpoint:products}': ['p(95)<60000'],
  },
};

export function mainScenario() {
  group('login', () => {
    const res = http.post(
      `${BASE_URL}/login`,
      JSON.stringify({ username: `loadtest-vu${__VU}` }),
      { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'login' } }
    );
    check(res, { 'login: 200': (r) => r.status === 200 });
  });

  group('products', () => {
    const page = Math.floor(Math.random() * 10) + 1;
    const res = http.get(`${BASE_URL}/products?page=${page}&pageSize=20`, {
      tags: { endpoint: 'products' },
    });
    check(res, { 'products: 200': (r) => r.status === 200 });
  });

  group('orders', () => {
    const page = Math.floor(Math.random() * 10) + 1;
    // pageSize=50 -> exactly the N+1 shape: 1 + 50 db_queries per request.
    const res = http.get(`${BASE_URL}/orders?page=${page}&pageSize=50`, {
      tags: { endpoint: 'orders' },
    });
    check(res, { 'orders: 200': (r) => r.status === 200 });
  });

  sleep(1);
}
