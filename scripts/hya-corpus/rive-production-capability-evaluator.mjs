import { productionAdapterFromEnvironment } from './rive-production-adapter-bridge.mjs';

export const capabilityEvaluator = productionAdapterFromEnvironment('capability');

