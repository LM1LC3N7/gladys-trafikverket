// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the TrafikverketApp (src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { TrafikverketApp } from './src/app.js';
import { ACTIONS, STATE_FILE } from './src/constants.js';
import { fileStorage } from './src/store.js';

const gladys = new GladysIntegration();
// The pace, the pause, the refusal and the last measurements are kept in
// /data, the one writable volume, so that a restart loop never reads faster
// than the interval nor publishes an old measurement again (the API key is
// never written).
const app = new TrafikverketApp({ gladys, storage: fileStorage(STATE_FILE, { logger }) });

// --- Discovery: the stations already read (no extra call) ----------------------
gladys.onScanRequest(() => app.publishDiscovered({ force: true }));

// --- A device was created: its values now, if the last measurement is fresh ---
gladys.onDeviceCreated((device) => app.onDeviceCreated(device));

// --- Configuration screen button -----------------------------------------------
gladys.onAction(ACTIONS.TEST, () => app.testConnection());

// --- Configuration changed by the user -----------------------------------------
gladys.onConfigUpdated(async (config) => {
  logger.info('Configuration updated: restarting');
  await app.start(config);
});

// --- Connection lifecycle -------------------------------------------------------
// A reconnection keeps the pace, the pause and the refusal: start() only
// lifts the refusal of a key that changed.
gladys.on('connected', async () => {
  try {
    await app.start(await gladys.getConfig());
  } catch (err) {
    logger.error('Start failed', app.scrub(err));
  }
});
gladys.on('disconnected', () => app.stop());
gladys.handleShutdown(() => app.shutdown());

logger.info('Starting the Trafikverket integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', app.scrub(err?.message ?? err));
  process.exit(1);
});
