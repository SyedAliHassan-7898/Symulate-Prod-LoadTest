# Excel Analysis Guide - Load Testing Reports

This guide shows you how to analyze CSV reports in Excel using Pivot Tables and charts.

---

## 📋 Table of Contents

1. [URLs by Response Time](#1-urls-by-response-time)
2. [Errors by Time Period](#2-errors-by-time-period)
3. [Load Pattern Visualization](#3-load-pattern-visualization)
4. [Performance Trends](#4-performance-trends)

---

## Prerequisites

### Files You Need:

**From Standard Reports:**
- `symulate-report-*-url-details.csv` - API endpoint performance
- `symulate-report-*-summary.csv` - Overall metrics

**From Grafana Export:**
- `grafana-http-requests-*.csv` - Time-series HTTP data
- `grafana-vus-timeseries-*.csv` - VUs over time
- `grafana-errors-*.csv` - Failed requests

**Location:** `reports/` folder

---

## 1. URLs by Response Time

**Goal:** Find which APIs are slowest and need optimization.

### Step-by-Step:

**A. Open CSV in Excel:**
```
File → Open → reports/symulate-report-*-url-details.csv
```

**B. Select All Data:**
- Click on cell `A1`
- Press `Ctrl+Shift+End` (selects all data)

**C. Create Pivot Table:**
```
Insert Tab → PivotTable → OK
```

**D. Configure Pivot:**

**Rows:** Drag `API Endpoint / Operation` to Rows area

**Values:** 
- Drag `Avg (ms)` to Values area → Right-click → Value Field Settings → Average
- Drag `# Requests` to Values area → Right-click → Value Field Settings → Sum
- Drag `P95 (ms)` to Values area → Right-click → Value Field Settings → Average

**E. Sort by Slowest:**
- Click dropdown on `Row Labels`
- More Sort Options → Descending → `Average of Avg (ms)`

**F. Add Conditional Formatting:**
```
Select Avg (ms) column
Home Tab → Conditional Formatting → Color Scales → Red-Yellow-Green
```

### 📊 Expected Output:

| API Endpoint | Avg Response (ms) | # Requests | P95 (ms) |
|--------------|-------------------|------------|----------|
| Create Project | 555.59 | 1 | 555.59 |
| Login - Super Admin | 481.00 | 1 | 481.00 |
| Submit Activity | 261.33 | 5 | 371.98 |
| Assign Task | 229.72 | 6 | 350.50 |
| Create Task | 195.90 | 15 | 375.05 |

### 💡 Insights:
- **Red cells** = Slowest endpoints (optimize these!)
- **High # Requests** = Most used APIs (prioritize optimization)
- **P95 > 2x Avg** = Inconsistent performance (investigate)

---

## 2. Errors by Time Period

**Goal:** Identify when errors occurred and find patterns.

### Step-by-Step:

**A. Open Grafana Errors CSV:**
```
File → Open → reports/grafana-errors-*.csv
```

**B. Add Time Bucket Column:**

**Column E (next to status):**
```
=TEXT(A2,"HH:MM")
```
- This groups errors by minute
- Drag formula down for all rows

**C. Create Pivot Table:**
```
Insert Tab → PivotTable → OK
```

**D. Configure Pivot:**

**Rows:** 
- Drag `Column E` (time bucket) to Rows area
- Drag `url` to Rows area

**Values:**
- Drag `value` to Values area → Count

**E. Add Chart:**
```
PivotChart → Column Chart
Chart Title: "Errors Over Time"
```

### 📊 Expected Output:

| Time | URL | Error Count |
|------|-----|-------------|
| 14:30 | https://api.example.com/tasks | 3 |
| 14:30 | https://api.example.com/projects | 1 |
| 14:35 | https://api.example.com/tasks | 2 |

### 💡 Insights:
- **Spike at specific time** = Possible concurrent load issue
- **Same URL repeatedly** = Specific endpoint problem
- **No errors** = Empty file means 100% success! ✅

---

## 3. Load Pattern Visualization

**Goal:** Visualize how VUs ramped up/down during test.

### Step-by-Step:

**A. Open VUs Time Series:**
```
File → Open → reports/grafana-vus-timeseries-*.csv
```

**B. Select Data:**
- Select columns A (time) and B (value)
- Include headers

**C. Insert Line Chart:**
```
Insert Tab → Line Chart → Line with Markers
```

**D. Format Chart:**
```
Chart Title: "Virtual Users Over Time"
Axis Titles: 
  - Horizontal: "Time"
  - Vertical: "Active VUs"
```

**E. Make Time Readable:**
- Right-click X-axis → Format Axis
- Number → Time → 13:30:55

### 📊 Expected Output:

```
VUs
 10 |         ████████████
    |     ████            
  5 |   ██                
    | ██                  
  0 |________________________
    0   5   10   15   20  Time (min)
```

### 💡 Insights:
- **Flat line** = Constant load test
- **Ramp up** = Gradual increase (realistic)
- **Drops** = VUs finishing iterations
- **Duration** = Total test time

---

## 4. Performance Trends

**Goal:** See how response times changed over test duration.

### Step-by-Step:

**A. Open HTTP Requests CSV:**
```
File → Open → reports/grafana-http-requests-*.csv
```

**B. Add Time Bucket & Minute Column:**

**Column H:**
```
=TEXT(A2,"HH:MM")
```

**Column I:**
```
=MINUTE(A2)
```

**C. Create Pivot Table:**
```
Insert Tab → PivotTable → OK
```

**D. Configure Pivot:**

**Rows:** Drag `Column H` (time bucket) to Rows

**Columns:** Drag `name` to Columns area

**Values:** 
- Drag `value` (response time) to Values → Average

**E. Create Line Chart:**
```
PivotChart → Line Chart
```

**F. Format:**
- Title: "Response Time Trend by Endpoint"
- Legend: Right side
- Remove gridlines for cleaner look

### 📊 Expected Output:

```
Response Time (ms)
 400 |                    ●  Create Task
     |          ●        /   Login
 300 |       ●  |  ●   ●    Submit Activity
     |     ●    | /   /
 200 |   ●     ●●   ●
     | ●_______________
     |________________________ Time
```

### 💡 Insights:
- **Increasing trend** = Performance degradation under load
- **Spikes** = Specific time periods with issues
- **Flat lines** = Consistent performance ✅
- **Compare endpoints** = Which APIs degrade faster

---

## 5. Advanced Analysis: Response Time Distribution

**Goal:** Understand distribution of response times (not just average).

### Step-by-Step:

**A. Open Summary CSV:**
```
File → Open → reports/symulate-report-*-aggregate.csv
```

**B. Select Data (Label, Average, Median, P90, P95, P99):**
- Columns A, C, D, E, F, G

**C. Create Clustered Column Chart:**
```
Insert Tab → Column Chart → Clustered Column
```

**D. Format:**
- Title: "Response Time Percentiles"
- Legend: Bottom
- Y-axis: "Time (ms)"

### 📊 Expected Output:

```
Time (ms)
 400 |     ▄   ▄
     |     █   █
 300 |     █   █   ▄
     |  ▄  █   █   █
 200 |  █  █   █   █   ▄
     |  █  █   █   █   █
 100 |  █  █   █   █   █
     |  █  █   █   █   █
   0 |___________________
     Avg Med P90 P95 P99
```

### 💡 Insights:
- **P99 >> Average** = Some requests very slow (outliers)
- **Median < Average** = Right-skewed distribution (expected)
- **P95 close to Average** = Consistent performance ✅
- **Large P99 spike** = Investigate slow requests

---

## 6. Combining Multiple Reports

**Goal:** Compare multiple test runs.

### Step-by-Step:

**A. Open Power Query:**
```
Data Tab → Get Data → From File → From Folder
```

**B. Select reports/ folder**

**C. Filter CSV files:**
```
Filter → Text Filters → Contains → "overview.csv"
```

**D. Combine Files:**
```
Combine → Combine & Transform Data
```

**E. Add Test Run Identifier:**
- New column from file name
- Extract timestamp

**F. Create Comparison Pivot:**

**Rows:** Test Run

**Values:**
- Total Requests
- Avg Response Time
- Error %
- P95

### 📊 Expected Output:

| Test Run | Total Req | Avg RT (ms) | Error % | P95 (ms) |
|----------|-----------|-------------|---------|----------|
| Run 1 (10 VUs) | 171 | 237 | 0% | 451 |
| Run 2 (50 VUs) | 850 | 312 | 1.2% | 623 |
| Run 3 (100 VUs) | 1700 | 445 | 3.5% | 890 |

### 💡 Insights:
- **Compare scalability** across VU counts
- **Track regression** between releases
- **Capacity planning** - when does system degrade?

---

## 7. Quick Formulas Reference

### Response Time Percentiles:
```excel
=PERCENTILE.INC(B:B, 0.50)  ' Median (P50)
=PERCENTILE.INC(B:B, 0.90)  ' P90
=PERCENTILE.INC(B:B, 0.95)  ' P95
=PERCENTILE.INC(B:B, 0.99)  ' P99
```

### Error Rate:
```excel
=COUNTIF(E:E, 1) / COUNTA(E:E) * 100  ' % failed
```

### Throughput (Requests/sec):
```excel
=COUNT(A:A) / ((MAX(A:A) - MIN(A:A)) * 86400)  ' Total reqs / time in seconds
```

### Time to Human Readable:
```excel
=TEXT(A2, "HH:MM:SS")           ' Hour:Min:Sec
=TEXT(A2, "DD-MMM HH:MM")       ' Date + Time
=HOUR(A2)*60 + MINUTE(A2)       ' Minutes since start
```

---

## 8. Pre-Built Templates

### Quick Start Template:

Create a new workbook with these sheets:

**Sheet 1: Dashboard**
- Summary metrics cards
- Key charts (VUs, Errors, Top Endpoints)

**Sheet 2: URL Analysis**
- Pivot table: URLs by response time

**Sheet 3: Time Series**
- Response time trends
- Error timeline

**Sheet 4: Comparisons**
- Multi-run comparison
- Before/After analysis

**Sheet 5: Raw Data**
- Imported CSV data
- Power Query connections

---

## 9. Automation Tips

### Auto-Refresh Data:

**A. Create Excel Template (.xltx):**
```
File → Save As → Excel Template
```

**B. Add Power Query Connections:**
```
Data → Queries & Connections
Right-click → Properties → Refresh on Open
```

**C. Usage:**
1. Run test
2. Open template
3. Data auto-refreshes
4. Charts update automatically

---

## 10. Export for Stakeholders

### Professional Report:

**A. Copy Pivot + Chart to PowerPoint:**
```
Select chart → Ctrl+C
PowerPoint → Paste as Picture
```

**B. Save Dashboard as PDF:**
```
File → Export → Create PDF
Select "Dashboard" sheet only
```

**C. Create Summary Slide:**

**Title:** "Load Test Results - [Date]"

**Key Metrics:**
- Total Requests: [X]
- Avg Response Time: [Y]ms
- Error Rate: [Z]%
- Peak VUs: [N]

**Charts:**
- Response Time Trend
- Top 5 Slowest Endpoints
- Load Pattern

---

## 💡 Pro Tips

1. **Use Tables:** Convert CSV data to Excel Tables (`Ctrl+T`) for easier filtering
2. **Named Ranges:** Create named ranges for key metrics for easier formulas
3. **Conditional Formatting:** Red-Yellow-Green for quick visual insights
4. **Slicers:** Add slicers to Pivots for interactive filtering
5. **Save Template:** Save configured workbook as template for future tests

---

## 🎯 Common Analysis Scenarios

### Scenario 1: Find Performance Bottleneck
```
1. Open url-details.csv
2. Sort by P95 descending
3. Top 3 = Your bottlenecks
4. Cross-reference with error CSV
```

### Scenario 2: Verify SLA Compliance
```
1. Open aggregate.csv
2. Filter P95 < 2000ms (your SLA)
3. Count PASS vs FAIL endpoints
4. Calculate % compliance
```

### Scenario 3: Compare Before/After Optimization
```
1. Import both test CSVs
2. Add "Version" column
3. Pivot: Version vs Avg Response Time
4. Create side-by-side chart
```

---

## 📚 Additional Resources

**Excel Learning:**
- Microsoft Excel Pivot Table Tutorial
- Power Query for Data Analysis
- Excel Charts Best Practices

**Load Testing Analysis:**
- Understanding Response Time Percentiles
- SLA Definition and Monitoring
- Capacity Planning Formulas

---

**Questions?** Check README.md or Professional HTML report for more context on metrics!
