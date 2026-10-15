# Grafana Live Monitoring Setup



## Quick Start

### 1. Start Monitoring Stack
```powershell
cd monitoring
docker compose up -d
```

**Services:**
- Grafana: http://localhost:3001 (admin / admin)
- InfluxDB: http://localhost:8087 (database: k6)

### 2. Run Load Test with Live Monitoring
```powershell
# From project root

# Standard smoke test
npm run smoke:grafana

# Full load test
npm run load:grafana

# Anam disabled load test
npm run load:grafana:no-anum

# Shared project load test (2-phase: setup + concurrent VUs)
npm run load:shared:grafana
```

### 3. View Live Dashboard
1. Open browser: http://localhost:3001
2. Login (admin / admin) - change password on first login
3. Go to **Dashboards → k6 Load Testing → Symulate k6 Load Test - Live Monitoring**
4. Dashboard auto-refreshes every 5 seconds

---

## Dashboard Panels

| Panel | Metric | Description |
|-------|--------|-------------|
| **Virtual Users (VUs)** | `vus` | Concurrent users running tests |
| **Requests / sec** | `http_reqs` | HTTP request rate |
| **Response Time p95 / p99** | `http_req_duration` | 95th/99th percentile latency |
| **Error Rate (%)** | `http_req_failed` | Failed request percentage |
| **p95 by Step** | `http_req_duration` grouped by `name` tag | Latency per API endpoint |
| **Checks Pass Rate** | `checks` | k6 assertion success rate |
| **Data Received/Sent** | `recv_bytes` | Network throughput |
| **Total Stats** | `http_reqs`, `http_req_failed`, `iterations` | Run summary |

---

## Troubleshooting

### Charts still empty?
1. **Check time range** - Top-right corner, set to "Last 15 minutes"
2. **Verify data** - Run a test first: `npm run smoke:grafana`
3. **Check InfluxDB**:
   ```powershell
   curl.exe "http://localhost:8087/query?db=k6&q=SHOW+MEASUREMENTS"
   ```
   Should show metrics like `http_reqs`, `vus`, etc.

### Datasource not connected?
1. Open Grafana → Configuration → Data Sources
2. **InfluxDB-k6** should be listed
3. Click "Test" button - should show "Data source is working"
4. If missing, it auto-provisions from `grafana-provisioning/datasources/influxdb.yml`

### Dashboard not loading?
```powershell
# Restart Grafana to reload dashboard
docker restart k6-grafana
```

### Port conflict (8087 already in use)?
1. Edit `monitoring/docker-compose.yml`:
   ```yaml
   ports:
     - '8088:8086'  # Change LEFT side only
   ```
2. Update all `package.json` Grafana scripts:
   ```
   --out influxdb=http://localhost:8088/k6
   ```

---

## Stop Monitoring Stack

```powershell
# Stop containers
docker compose -f monitoring/docker-compose.yml down

# Stop + delete all metrics data
docker compose -f monitoring/docker-compose.yml down -v
```

---

## Technical Details

**InfluxDB Version:** 1.8 (k6 native support - no extension needed)  
**Grafana Version:** 10.4.2  
**k6 Output:** Built-in `--out influxdb=...` flag  
**Dashboard Refresh:** 5 seconds (configurable in dashboard settings)  
**Data Retention:** Persists until `docker compose down -v`
