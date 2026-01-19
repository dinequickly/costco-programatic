#!/usr/bin/env node
/**
 * Standalone Costco Item Availability API Server
 * 
 * Usage:
 *   node costco-server.js [--port 3847]
 *   bun costco-server.js [--port 3847]
 * 
 * API Endpoints:
 *   GET  /api/costco?keyword=juice&zipCode=90210&limit=24
 *   POST /api/costco
 *        Body: { "keyword": "juice", "zipCode": "90210", "limit": 24 }
 *   GET  /health
 */

import express from 'express';
import axios from 'axios';
import net from 'net';

// Default axios headers/timeout for desktop-like requests
axios.defaults.timeout = 10000;
axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
axios.defaults.headers.common['Accept'] = 'application/json, text/plain, */*';
axios.defaults.headers.common['Accept-Language'] = 'en-US,en;q=0.9';

let globalConfig = {
  keyword: "juice",
  zipCode: "90210",
  limit: 24,
  warehouseId: null
};

/**
 * Run the Costco item availability workflow
 */
async function runWorkflow(inputs) {
  const outputs = {};
  const { keyword, zipCode, limit, warehouseId } = inputs;

  // Step 1: Resolve warehouse
  outputs.warehouse = await (async () => {
    // If warehouseId is provided directly, skip lookup
    if (warehouseId) {
      return {
        id: warehouseId,
        name: `Store ${warehouseId}`, // Name unknown without lookup
        city: "Unknown",
        state: "Unknown"
      };
    }

    // Step 1: Geocode zip code
    const geoUrl = "https://geocodeservice.costco.com/Locations";
    const geoResp = await axios.get(geoUrl, {
      params: { q: inputs.zipCode },
      headers: { 'Referer': 'https://www.costco.com/' }
    });
    if (!geoResp.data || geoResp.data.length === 0) throw new Error("Zip code not found");
    const { latitude, longitude } = geoResp.data[0];
    
    // Step 2: Find nearest warehouse
    const whUrl = "https://ecom-api.costco.com/core/warehouse-locator/v1/warehouses.json";
    const whResp = await axios.get(whUrl, {
      params: {
        latitude,
        longitude,
        limit: 1,
        openingDate: new Date().toISOString().split('T')[0]
      },
      headers: {
        'Referer': 'https://www.costco.com/',
        'client-identifier': '7c71124c-7bf1-44db-bc9d-498584cd66e5'
      }
    });
    if (!whResp.data.warehouses || whResp.data.warehouses.length === 0) throw new Error("No warehouses found");
    const w = whResp.data.warehouses[0];
    return {
      id: w.warehouseId,
      name: w.name[0].value,
      city: w.address.city,
      state: w.address.territory
    };
  })();

  // Step 2: Search items
  outputs.items = await (async () => {
    // Step 3: Search items
    const searchUrl = "https://search.costco.com/api/apps/www_costco_com/query/www_costco_com_search";
    const params = {
      expoption: 'lucidworks',
      q: inputs.keyword,
      locale: 'en-US',
      start: 0,
      rows: inputs.limit || 24,
      whloc: `${outputs.warehouse.id}-wh`,
      loc: `${outputs.warehouse.id}-wh`,
      fq: '{!tag=item_program_eligibility}item_program_eligibility:("InWarehouse")'
    };
    
    const response = await axios.get(searchUrl, {
      params,
      headers: {
        'Referer': 'https://www.costco.com/',
        'x-api-key': '273db6be-f015-4de7-b0d6-dd4746ccd5c3'
      }
    });
    
    return response.data.response.docs.map(d => ({
      name: d.item_product_name,
      price: d.item_location_pricing_salePrice,
      availability: d.item_location_availability,
      deliveryOptions: d.item_program_eligibility,
      partNumber: d.item_partnumber
    }));
  })();

  return outputs;
}

/**
 * Find an available port, starting from the requested port
 */
function findAvailablePort(startPort) {
  return new Promise((resolve, reject) => {
    const checkPort = (port) => {
      if (port > startPort + 100) {
        reject(new Error(`Could not find available port after trying 100 ports`));
        return;
      }

      const server = net.createServer();
      server.listen(port, () => {
        server.once('close', () => resolve(port));
        server.close();
      });
      
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // Try next port
          checkPort(port + 1);
        } else {
          reject(err);
        }
      });
    };
    
    checkPort(startPort);
  });
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      flags.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      flags.help = true;
    }
  }
  
  return flags;
}

/**
 * Main server setup
 */
async function main() {
  const flags = parseArgs();
  
  if (flags.help) {
    console.log(`
Costco Item Availability API Server

Usage:
  node costco-server.js [--port 3847]
  bun costco-server.js [--port 3847]

Options:
  --port <number>  Port to listen on (default: 3847)
  --help, -h       Show this help message

API Endpoints:
  GET  /api/costco?keyword=juice&zipCode=90210&limit=24
  POST /api/costco
       Body: { "keyword": "juice", "zipCode": "90210", "limit": 24 }
  GET  /health

Example:
  curl "http://localhost:3847/api/costco?keyword=juice&zipCode=90210&limit=5"
`);
    process.exit(0);
  }

  const requestedPort = flags.port || process.env.PORT || 3847;
  
  // Find available port
  let actualPort = requestedPort;
  try {
    actualPort = await findAvailablePort(requestedPort);
  } catch (err) {
    console.error(`❌ Failed to find available port: ${err.message}`);
    process.exit(1);
  }

  const app = express();
  app.use(express.json());

  // GET endpoint - run with query params as inputs
  app.get('/api/costco', async (req, res) => {
    const startTime = Date.now();
    try {
      // Merge query params with defaults
      const inputs = {
        keyword: req.query.keyword || globalConfig.keyword,
        zipCode: req.query.zipCode || globalConfig.zipCode,
        limit: req.query.limit ? parseInt(req.query.limit, 10) : globalConfig.limit,
        warehouseId: req.query.warehouseId || globalConfig.warehouseId
      };

      const outputs = await runWorkflow(inputs);
      res.json({
        success: true,
        duration: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
        outputs
      });
    } catch (err) {
      res.status(500).json({ 
        success: false, 
        error: err.message,
        duration: `${((Date.now() - startTime) / 1000).toFixed(2)}s`
      });
    }
  });

  // POST endpoint - run with body as inputs
  app.post('/api/costco', async (req, res) => {
    const startTime = Date.now();
    try {
      // Merge body with defaults
      const inputs = {
        keyword: req.body.keyword || globalConfig.keyword,
        zipCode: req.body.zipCode || globalConfig.zipCode,
        limit: req.body.limit || globalConfig.limit,
        warehouseId: req.body.warehouseId || globalConfig.warehouseId
      };

      const outputs = await runWorkflow(inputs);
      res.json({
        success: true,
        duration: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
        outputs
      });
    } catch (err) {
      res.status(500).json({ 
        success: false, 
        error: err.message,
        duration: `${((Date.now() - startTime) / 1000).toFixed(2)}s`
      });
    }
  });

  // Configuration endpoint
  app.post('/api/config', (req, res) => {
    if (req.body.keyword) globalConfig.keyword = req.body.keyword;
    if (req.body.zipCode) globalConfig.zipCode = req.body.zipCode;
    if (req.body.limit) globalConfig.limit = req.body.limit;
    if (req.body.warehouseId) globalConfig.warehouseId = req.body.warehouseId;
    
    res.json({
      success: true,
      config: globalConfig
    });
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      service: 'costco-item-availability',
      timestamp: new Date().toISOString()
    });
  });

  // Root endpoint
  app.get('/', (req, res) => {
    res.json({
      service: 'Costco Item Availability API',
      version: '1.1.0',
      endpoints: {
        'GET /api/costco': 'Search for items (query params: keyword, zipCode, limit, warehouseId)',
        'POST /api/costco': 'Search for items (JSON body: keyword, zipCode, limit, warehouseId)',
        'POST /api/config': 'Update global configuration (JSON body: keyword, zipCode, limit, warehouseId)',
        'GET /health': 'Health check'
      },
      example: `http://localhost:${actualPort}/api/costco?keyword=juice&zipCode=90210&limit=5`
    });
  });

  // Start server
  const server = app.listen(actualPort, () => {
    const baseUrl = `http://localhost:${actualPort}`;
    
    console.log('');
    console.log('╭─────────────────────────────────────────────────────────────╮');
    console.log('│  ✓ Costco Item Availability API Server Running            │');
    console.log('│                                                             │');
    
    if (actualPort !== requestedPort) {
      console.log(`│  ⚠ Port ${requestedPort} was in use, using port ${actualPort}      │`);
      console.log('│                                                             │');
    }
    
    console.log(`│  ▸ ${baseUrl}/api/costco                                    │`);
    console.log('│                                                             │');
    console.log('│  Example:                                                   │');
    console.log(`│  ${baseUrl}/api/costco?keyword=juice&zipCode=90210&limit=5  │`);
    console.log('╰─────────────────────────────────────────────────────────────╯');
    console.log('');
    console.log('  Methods: GET (query params) │ POST (JSON body)');
    console.log('  Press Ctrl+C to stop');
    console.log('');
  });

  server.on('error', (err) => {
    console.error(`❌ Server error: ${err.message}`);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down server...');
    server.close(() => {
      console.log('Server stopped.');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    server.close(() => {
      process.exit(0);
    });
  });

  // Error handlers
  process.on('uncaughtException', (err) => {
    console.error(`\n❌ Uncaught exception: ${err.message}`);
    console.error(err.stack);
    server.close(() => {
      process.exit(1);
    });
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error(`\n❌ Unhandled rejection: ${reason}`);
    // Don't exit on unhandled rejection, just log it
  });
}

// Run the server
main().catch((err) => {
  console.error(`❌ Failed to start server: ${err.message}`);
  process.exit(1);
});
