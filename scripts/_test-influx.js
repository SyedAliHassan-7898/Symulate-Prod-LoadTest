const { spawnSync } = require('child_process');

function run(query) {
  const r = spawnSync('docker', ['exec', 'k6-influxdb', 'influx', '-database', 'k6', '-execute', query, '-format', 'csv'], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').slice(0, 400), err: (r.stderr || '').slice(0, 300) };
}

// 1) single-line, quoted name
console.log('--- TEST 1: single-line GROUP BY "name" ---');
let r = run('SELECT count(value) as samples, mean(value) as avg FROM http_req_duration GROUP BY "name"');
console.log('status', r.status); console.log(r.out); console.log('err', r.err);

// 2) multi-line (should reproduce "empty input" if that's the bug)
console.log('--- TEST 2: multi-line ---');
r = run('\n    SELECT count(value) as samples\n    FROM http_req_duration\n  ');
console.log('status', r.status); console.log(JSON.stringify(r.out)); console.log('err', JSON.stringify(r.err));

// 3) unquoted name keyword
console.log('--- TEST 3: unquoted name ---');
r = run('SELECT count(value) FROM http_req_duration GROUP BY name');
console.log('status', r.status); console.log('err', r.err);
