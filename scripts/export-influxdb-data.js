#!/usr/bin/env node
/**
 * InfluxDB Data Exporter for Grafana Metrics
 * 
 * Extracts time-series data from InfluxDB and exports to CSV format.
 * Captures actual URLs, response times, and all HTTP metrics that Grafana visualizes.
 * 
 * Requirements:
 * - InfluxDB container must be running (npm run monitoring:up)
 * - k6 test must have been run with --out influxdb flag
 * 
 * Usage:
 *   node scripts/export-influxdb-data.js
 *   node scripts/export-influxdb-data.js --database k6 --output grafana-export.csv
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'reports');

// Parse command line arguments
const args = process.argv.slice(2);
const database = args.includes('--database') ? args[args.indexOf('--database') + 1] : 'k6';
const customOutput = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

/**
 * Check if InfluxDB container is running
 */
function checkInfluxDB() {
  console.log('🔍 Checking InfluxDB availability...\n');
  
  const check = spawnSync('docker', ['ps', '--filter', 'name=symulate-influxdb', '--format', '{{.Names}}'], {
    encoding: 'utf-8',
    shell: false
  });
  
  if (check.error || !check.stdout.includes('symulate-influxdb')) {
    console.error('❌ InfluxDB container is not running.');
    console.error('   Start monitoring stack first: npm run monitoring:up\n');
    process.exit(1);
  }
  
  console.log('✅ InfluxDB container is running\n');
}

/**
 * Execute InfluxDB query and return results
 */
function executeInfluxQuery(query) {
  const result = spawnSync('docker', [
    'exec',
    'symulate-influxdb',
    'influx',
    '-database', database,
    '-execute', query,
    '-format', 'csv'
  ], {
    encoding: 'utf-8',
    shell: false,
    maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large datasets
  });
  
  if (result.error) {
    throw new Error(`Failed to execute InfluxDB query: ${result.error.message}`);
  }
  
  if (result.status !== 0) {
    throw new Error(`InfluxDB query failed: ${result.stderr}`);
  }
  
  return result.stdout;
}

/**
 * Check if database has data
 */
function checkDatabaseHasData() {
  try {
    const measurements = executeInfluxQuery('SHOW MEASUREMENTS');
    
    if (!measurements || measurements.trim() === '' || measurements.includes('ERR:')) {
      console.error('❌ No data found in InfluxDB database:', database);
      console.error('   Run a test with Grafana output first:');
      console.error('   npm run load:shared:grafana\n');
      process.exit(1);
    }
    
    console.log('✅ Database has metrics data\n');
    return true;
  } catch (err) {
    console.error('❌ Failed to check database:', err.message);
    process.exit(1);
  }
}

/**
 * Export HTTP request duration metrics with URLs
 */
function exportHttpRequestDuration() {
  console.log('📊 Exporting HTTP request durations with URLs...');
  
  const query = `
    SELECT time, value, url, name, method, status, expected_response
    FROM http_req_duration
    ORDER BY time ASC
  `;
  
  try {
    const data = executeInfluxQuery(query);
    const outputFile = customOutput || path.join(REPORTS_DIR, `grafana-http-requests-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
    
    // Parse and clean CSV data
    const lines = data.split('\n').filter(line => line.trim());
    if (lines.length <= 1) {
      console.log('⚠️  No HTTP request data found in InfluxDB\n');
      return null;
    }
    
    // Write cleaned data
    fs.writeFileSync(outputFile, data, 'utf-8');
    console.log(`✅ Exported ${lines.length - 1} HTTP requests`);
    console.log(`📄 File: ${path.basename(outputFile)}\n`);
    
    return outputFile;
  } catch (err) {
    console.error('⚠️  Failed to export HTTP requests:', err.message, '\n');
    return null;
  }
}

/**
 * Export all key metrics summary
 */
function exportMetricsSummary() {
  console.log('📊 Exporting metrics summary...');
  
  const metrics = [
    'http_reqs',
    'http_req_failed', 
    'http_req_duration',
    'http_req_blocked',
    'http_req_connecting',
    'http_req_sending',
    'http_req_waiting',
    'http_req_receiving',
    'data_received',
    'data_sent',
    'vus',
    'vus_max',
    'iterations',
    'checks'
  ];
  
  const summaryFile = path.join(REPORTS_DIR, `grafana-metrics-summary-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  const summaryData = ['Metric,Count,Mean,Min,Max,Sum'];
  
  for (const metric of metrics) {
    try {
      const query = `
        SELECT COUNT(value) as count, MEAN(value) as mean, MIN(value) as min, MAX(value) as max, SUM(value) as sum
        FROM ${metric}
      `;
      
      const result = executeInfluxQuery(query);
      const lines = result.split('\n').filter(line => line.trim() && !line.startsWith('name,'));
      
      if (lines.length > 0) {
        const values = lines[0].split(',');
        if (values.length >= 6) {
          summaryData.push(`${metric},${values[2]},${values[3]},${values[4]},${values[5]},${values[6]}`);
        }
      }
    } catch (err) {
      // Metric might not exist, skip
      continue;
    }
  }
  
  if (summaryData.length > 1) {
    fs.writeFileSync(summaryFile, summaryData.join('\n') + '\n', 'utf-8');
    console.log(`✅ Exported ${summaryData.length - 1} metrics`);
    console.log(`📄 File: ${path.basename(summaryFile)}\n`);
    return summaryFile;
  }
  
  return null;
}

/**
 * Export VUs over time (for load pattern visualization)
 */
function exportVUsTimeSeries() {
  console.log('📊 Exporting VUs time series...');
  
  const query = `
    SELECT time, value
    FROM vus
    ORDER BY time ASC
  `;
  
  try {
    const data = executeInfluxQuery(query);
    const outputFile = path.join(REPORTS_DIR, `grafana-vus-timeseries-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
    
    const lines = data.split('\n').filter(line => line.trim());
    if (lines.length <= 1) {
      console.log('⚠️  No VUs data found\n');
      return null;
    }
    
    fs.writeFileSync(outputFile, data, 'utf-8');
    console.log(`✅ Exported ${lines.length - 1} VU data points`);
    console.log(`📄 File: ${path.basename(outputFile)}\n`);
    
    return outputFile;
  } catch (err) {
    console.error('⚠️  Failed to export VUs:', err.message, '\n');
    return null;
  }
}

/**
 * Export error rate over time
 */
function exportErrorRate() {
  console.log('📊 Exporting error rate time series...');
  
  const query = `
    SELECT time, value, url, name, status
    FROM http_req_failed
    WHERE value = 1
    ORDER BY time ASC
  `;
  
  try {
    const data = executeInfluxQuery(query);
    const outputFile = path.join(REPORTS_DIR, `grafana-errors-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
    
    const lines = data.split('\n').filter(line => line.trim());
    if (lines.length <= 1) {
      console.log('✅ No errors found (100% success rate)\n');
      return null;
    }
    
    fs.writeFileSync(outputFile, data, 'utf-8');
    console.log(`⚠️  Exported ${lines.length - 1} failed requests`);
    console.log(`📄 File: ${path.basename(outputFile)}\n`);
    
    return outputFile;
  } catch (err) {
    console.error('⚠️  Failed to export errors:', err.message, '\n');
    return null;
  }
}

/**
 * Main execution
 */
function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║       InfluxDB Data Exporter - Grafana Metrics            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  
  checkInfluxDB();
  checkDatabaseHasData();
  
  const exportedFiles = [];
  
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('Starting data export...\n');
  
  // Export all metrics
  const httpFile = exportHttpRequestDuration();
  if (httpFile) exportedFiles.push(httpFile);
  
  const summaryFile = exportMetricsSummary();
  if (summaryFile) exportedFiles.push(summaryFile);
  
  const vusFile = exportVUsTimeSeries();
  if (vusFile) exportedFiles.push(vusFile);
  
  const errorsFile = exportErrorRate();
  if (errorsFile) exportedFiles.push(errorsFile);
  
  // Summary
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('✅ Export Complete!\n');
  console.log(`📁 Location: ${REPORTS_DIR}\n`);
  
  if (exportedFiles.length > 0) {
    console.log('📄 Generated files:');
    exportedFiles.forEach(file => {
      console.log(`   - ${path.basename(file)}`);
    });
    console.log('');
  } else {
    console.log('⚠️  No files were generated. Database might be empty.\n');
  }
  
  console.log('💡 Tip: Open CSV files in Excel to analyze Grafana chart data\n');
}

// Run if called directly
if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('\n❌ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

module.exports = { exportHttpRequestDuration, exportMetricsSummary, exportVUsTimeSeries, exportErrorRate };
