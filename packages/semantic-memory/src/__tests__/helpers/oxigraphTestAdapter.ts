import { OxigraphAdapter } from '../../adapters/OxigraphAdapter.js';
import { OxigraphDiskAdapter } from '../../adapters/OxigraphDiskAdapter.js';

/** The two embedded Oxigraph backends a generic store test can run on. */
export type OxigraphTestAdapter = OxigraphAdapter | OxigraphDiskAdapter;

/**
 * Creates the embedded Oxigraph adapter a test runs on. The default is the file
 * adapter; with `ONTOFELIA_TEST_OXIGRAPH_STORE=disk` it is the on-disk adapter.
 * There is no silent fallback: when the native binary is missing, the disk
 * adapter's `initialize()` throws and the test fails.
 */
export function createOxigraphTestAdapter(): OxigraphTestAdapter {
  return process.env.ONTOFELIA_TEST_OXIGRAPH_STORE === 'disk'
    ? new OxigraphDiskAdapter()
    : new OxigraphAdapter();
}
