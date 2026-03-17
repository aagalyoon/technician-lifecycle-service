import { PoSProvider, PoSTechnician } from '../models/types';

/**
 * Registry for PoS providers. Adding a new provider (e.g. Housecall Pro)
 * requires only:
 * 1. Create a new file implementing PoSProvider
 * 2. Register it here
 *
 * No changes to core sync logic needed.
 */
const providers = new Map<string, PoSProvider>();

export function registerProvider(provider: PoSProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): PoSProvider | undefined {
  return providers.get(name);
}

export function getAllProviders(): PoSProvider[] {
  return Array.from(providers.values());
}
